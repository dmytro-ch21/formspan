/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from "@testing-library/react";
import {
  createHTMLErrorHandler,
  createReactServerErrorHandler,
  getDigestForWellKnownError,
} from "next/dist/server/app-render/create-error-handler";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ getToken: async () => "tok" }) }));

import { failureDigest, failureFromDigest } from "@/lib/adminFailure";
import { listUsers } from "@/lib/api";
import { DEFAULT_TIMEOUT_MS } from "@/lib/deadline";
import AdminError from "../error";

/**
 * F65 (#1182): what an operator reads when an admin screen fails in a
 * PRODUCTION build.
 *
 * `error.tsx` classified by `error.message.includes("403")`. A production build
 * never sends a Server Component error's message to the browser, so on a real
 * deploy every failure — the ADMIN_USER_IDS-drift 403 the page was written for
 * included — said "confirm the API is running". Every test that could have
 * noticed ran in development, where the message is still there.
 *
 * So these tests never hand the boundary the error the server threw. They hand
 * it what the browser receives: React's replacement message and the server's
 * digest, nothing else. The failures themselves are real — `listUsers()`
 * through `adminFetch` against a stubbed `fetch` — so the digest is the one the
 * API client actually stamps, not one written here to match.
 */

/** Measured on `next build` + `next start` of this app, 2026-09-12. */
const PRODUCTION_MESSAGE =
  "Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

function asProductionDelivers(thrown: unknown): Error & { digest?: string } {
  return Object.assign(new Error(PRODUCTION_MESSAGE), {
    digest: (thrown as { digest?: string }).digest,
  });
}

function screenFor(thrown: unknown): string {
  const { container } = render(<AdminError error={asProductionDelivers(thrown)} reset={() => {}} />);
  return container.textContent ?? "";
}

const originalFetch = globalThis.fetch;

function apiAnswers(status: number, body?: unknown) {
  globalThis.fetch = (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status })) as typeof fetch;
}

async function failureOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected the read to fail");
    },
    (e: unknown) => e,
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("error.tsx, given a failure the way a production build delivers it", () => {
  it("a 403 from the API explains ADMIN_USER_IDS drift, not an API outage", async () => {
    apiAnswers(403, { error: { code: "forbidden", message: "admin access required" } });
    const text = screenFor(await failureOf(listUsers()));
    expect(text).toContain("rejected this account as not-an-admin");
    expect(text).toContain("ADMIN_USER_IDS");
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
  });

  it("a 401 from the API points at the session", async () => {
    apiAnswers(401, { error: { code: "unauthorized", message: "invalid token" } });
    const text = screenFor(await failureOf(listUsers()));
    expect(text).toContain("rejected the session token");
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
  });

  it("a read that outlives the deadline says it took too long", async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init!.signal!.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const pending = failureOf(listUsers());
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    const text = screenFor(await pending);
    expect(text).toContain("took too long to answer");
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
  });

  it("a refused connection is the one case that says to check the API is running", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const text = screenFor(await failureOf(listUsers()));
    expect(text).toContain("Couldn't reach the API");
    expect(text).toContain("NEXT_PUBLIC_API_URL");
  });

  it("any other status is named, with nothing guessed about the cause", async () => {
    apiAnswers(500);
    const text = screenFor(await failureOf(listUsers()));
    expect(text).toContain("HTTP 500");
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
  });

  it("a failure nothing classified says so, and gives the digest to find it in the log", () => {
    // Next's own hash for an unclassified error — the shape the probe's
    // render bug produced on `next start`.
    const text = screenFor({ digest: "3867810585" });
    expect(text).toContain("wasn't an API response this console recognises");
    expect(text).toContain("3867810585");
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
  });

  it("never classifies by message — a 403 in the message alone is not a 403", () => {
    // The old rule, and the shape a development build still delivers. If the
    // boundary ever reads `message` again, this is the test that says so.
    const { container } = render(
      <AdminError
        error={Object.assign(new Error("API responded 403 for /admin/users"), { digest: "3834971595" })}
        reset={() => {}}
      />,
    );
    expect(container.textContent).not.toContain("not-an-admin");
  });
});

describe("Next keeps the digest the API client stamped", () => {
  // The whole fix rests on Next passing a pre-set digest through rather than
  // replacing it with its own hash. That is this installed Next's behaviour,
  // not a documented promise, so it is asserted against Next's real handlers:
  // an upgrade that changes it fails here instead of silently reverting every
  // production failure to "something failed".
  async function stamped() {
    apiAnswers(403, { error: { code: "forbidden", message: "admin access required" } });
    return (await failureOf(listUsers())) as Error & { digest: string };
  }

  // Both compare against the digest read BEFORE the handler runs. Next writes
  // its own hash onto `err.digest` when there is none, so comparing against
  // `err.digest` afterwards compares Next's hash with itself and passes with
  // no stamp at all — which is exactly what the first draft of this test did
  // under a mutation removing the stamp.
  it("the Server Components handler returns it unchanged", async () => {
    const err = await stamped();
    const sent = err.digest;
    const handler = createReactServerErrorHandler(false, false, new Map(), () => {}, undefined);
    const digest = handler(err);
    expect(digest).toBe(sent);
    expect(failureFromDigest(digest as string)?.kind).toBe("forbidden");
  });

  it("the HTML handler returns it unchanged", async () => {
    const err = await stamped();
    const sent = err.digest;
    const handler = createHTMLErrorHandler(false, false, new Map(), [], () => {}, undefined);
    const digest = handler(err, {} as never);
    expect(digest).toBe(sent);
    expect(failureFromDigest(digest as string)?.kind).toBe("forbidden");
  });

  it("and does not mistake it for one of Next's own (a redirect, a not-found)", async () => {
    expect(getDigestForWellKnownError(await stamped())).toBeUndefined();
  });
});

describe("the digest format", () => {
  it("round-trips every kind", () => {
    expect(failureFromDigest(failureDigest("forbidden", undefined, "ab12cd34"))).toEqual({
      kind: "forbidden",
      ref: "ab12cd34",
    });
    expect(failureFromDigest(failureDigest("api", 502, "ab12cd34"))).toEqual({
      kind: "api",
      status: 502,
      ref: "ab12cd34",
    });
    for (const kind of ["unauthorized", "timeout", "unreachable"] as const) {
      expect(failureFromDigest(failureDigest(kind))?.kind).toBe(kind);
    }
  });

  it("reads any digest this console did not write as unclassified", () => {
    for (const foreign of [
      undefined,
      "",
      "3834971595",
      "NEXT_HTTP_ERROR_FALLBACK;404",
      "NEXT_REDIRECT;replace;/users;307;",
      "VOLA_ADMIN;bogus;ab12cd34",
      "VOLA_ADMIN;api;abc;ab12cd34",
      "VOLA_ADMIN;forbidden",
    ]) {
      expect(failureFromDigest(foreign)).toBeNull();
    }
  });

  it("gives every throw its own reference, so one log line can be found", () => {
    expect(failureDigest("forbidden")).not.toBe(failureDigest("forbidden"));
  });
});
