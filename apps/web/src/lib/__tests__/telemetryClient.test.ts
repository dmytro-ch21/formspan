import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  capture,
  clearTelemetryForSignOut,
  flush,
  installTelemetry,
  resetTelemetry,
  shouldClearForIdentity,
} from "@/lib/telemetryClient";

/**
 * The web transport.
 *
 * Its mobile counterpart had four of five blocking review findings in it while
 * the pure buffer beside it was correct — the untested half was the broken
 * half. This suite exists so that lesson does not have to be learned twice, and
 * it covers the same four properties: batching rather than per-occurrence
 * sending, the loss tally surviving a failed send, no cross-account flush, and
 * never throwing into a caller.
 *
 * `installTelemetry` bails without a `window`, so the handler tests need one;
 * everything else runs in the node environment this app already uses.
 */

type Posted = {
  body: { events: Record<string, unknown>[] };
  token: string;
  keepalive: boolean;
};

let posted: Posted[] = [];
let respondOk = true;
let throwOnFetch = false;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  posted = [];
  respondOk = true;
  throwOnFetch = false;
  resetTelemetry();
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    if (throwOnFetch) throw new Error("network down");
    posted.push({
      body: JSON.parse(String(init.body)),
      token: String((init.headers as Record<string, string>).Authorization),
      keepalive: init.keepalive === true,
    });
    return { ok: respondOk, status: respondOk ? 202 : 400 } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  resetTelemetry();
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

const token = (v: string) => async () => v;

describe("batching, not per-occurrence sending", () => {
  it("sends ONE request for a burst of the same error", async () => {
    installTelemetry(token("A"));
    for (let i = 0; i < 60; i++) capture("error", "client_error", "boom");
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].body.events).toHaveLength(1);
    expect(posted[0].body.events[0].details).toMatchObject({ occurrences: 60 });
  });

  it("sends nothing on an occurrence", () => {
    installTelemetry(token("A"));
    capture("error", "client_error", "boom");
    expect(posted).toHaveLength(0);
  });

  it("sends with keepalive, so a flush started as the tab closes survives", async () => {
    // Added because a mutation removing `keepalive` left every other test
    // green — the line was doing real work with nothing guarding it. It is the
    // one advantage the browser has over the phone here, and the reason there
    // is no separate beacon path.
    installTelemetry(token("A"));
    capture("error", "client_error", "boom");
    await flush();
    expect(posted[0].keepalive).toBe(true);
  });

  it("does nothing when the buffer is empty", async () => {
    installTelemetry(token("A"));
    await flush();
    expect(posted).toHaveLength(0);
  });
});

describe("the loss tally must not evaporate", () => {
  /** Two consecutive failed flushes, so a tally exists BEFORE the second one.
   *  Failing a single event passes even with the bug present — that version
   *  was green against the exact defect it was named for on mobile. */
  async function failThreeThenThree(fail: () => void, unfail: () => void) {
    installTelemetry(token("A"));
    fail();
    capture("error", "client_error", "network down");
    capture("error", "client_error", "cannot parse");
    capture("error", "client_error", "token expired");
    await flush();

    capture("error", "client_error", "disk full");
    capture("error", "client_error", "clock skewed");
    capture("error", "client_error", "socket closed");
    await flush();

    unfail();
    capture("error", "client_error", "something later");
    await flush();
  }

  it("carries an earlier tally forward when a send is rejected", async () => {
    await failThreeThenThree(
      () => {
        respondOk = false;
      },
      () => {
        respondOk = true;
      },
    );
    const details = posted[posted.length - 1].body.events[0].details as Record<string, number>;
    expect(details.lost_events).toBe(6);
  });

  it("carries an earlier tally forward when the fetch throws", async () => {
    await failThreeThenThree(
      () => {
        throwOnFetch = true;
      },
      () => {
        throwOnFetch = false;
      },
    );
    const details = posted[posted.length - 1].body.events[0].details as Record<string, number>;
    expect(details.lost_events).toBe(6);
  });

  it("reports lost_events on ONE event, not on every one", async () => {
    installTelemetry(token("A"));
    throwOnFetch = true;
    capture("error", "client_error", "alpha");
    await flush();
    throwOnFetch = false;

    for (const m of ["network down", "cannot parse", "token expired", "disk full"]) {
      capture("error", "client_error", m);
    }
    await flush();
    const withLost = posted[0].body.events.filter(
      (e) => (e.details as Record<string, unknown>).lost_events !== undefined,
    );
    expect(withLost).toHaveLength(1);
  });
});

describe("one athlete's events must never be sent under another's token", () => {
  it("drops the buffer on sign-out", async () => {
    installTelemetry(token("A-token"));
    capture("error", "client_error", "A had a problem");
    clearTelemetryForSignOut();
    installTelemetry(token("B-token"));
    await flush();
    expect(posted).toHaveLength(0);
  });

  it("sends B's own events under B's token", async () => {
    installTelemetry(token("A-token"));
    capture("error", "client_error", "A had a problem");
    clearTelemetryForSignOut();
    installTelemetry(token("B-token"));
    capture("error", "client_error", "B had a different problem");
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].token).toBe("Bearer B-token");
  });

  it("does not attribute a PRE-AUTH event to whoever signs in next", async () => {
    // The gap review found, and the half that was missing: an error on a
    // public page (sign-in, landing) buffers with nobody signed in, no timer
    // is running to flush it, and it sits there until the first athlete signs
    // in — who then ships it under their token and owns it on the Health
    // screen. On a shared computer that is somebody else's error against your
    // name.
    //
    // `Telemetry.tsx` clears whenever the athlete CHANGES, in either
    // direction, which covers null → someone as well as someone → null. This
    // asserts the transport half honours a clear at that moment.
    capture("error", "client_error", "crash on the public sign-in page");
    clearTelemetryForSignOut(); // what the null → someone transition triggers
    installTelemetry(token("first-athlete"));
    await flush();
    expect(posted).toHaveLength(0);
  });

  it("sends nothing without a token", async () => {
    installTelemetry(async () => null);
    capture("error", "client_error", "boom");
    await flush();
    expect(posted).toHaveLength(0);
  });
});

describe("clearing on a change of athlete", () => {
  it("clears when somebody signs in after a signed-out error", () => {
    // null → someone. THE case review found missing: an error on a public page
    // buffers with nobody signed in, and the first athlete to sign in would
    // otherwise ship it under their token and own it on the Health screen.
    expect(shouldClearForIdentity(null, "athlete_a")).toBe(true);
  });

  it("clears on sign-out", () => {
    expect(shouldClearForIdentity("athlete_a", null)).toBe(true);
  });

  it("clears when one athlete replaces another without a signed-out gap", () => {
    expect(shouldClearForIdentity("athlete_a", "athlete_b")).toBe(true);
  });

  it("does NOT clear when only the token getter changed identity", () => {
    // The effect re-runs on `getToken` identity too. Clearing there would drop
    // events nobody had a problem with, which is why this is keyed on who
    // rather than on whether anything re-ran.
    expect(shouldClearForIdentity("athlete_a", "athlete_a")).toBe(false);
    expect(shouldClearForIdentity(null, null)).toBe(false);
  });
});

describe("privacy", () => {
  it("scrubs quoted content out of the outbound message", async () => {
    installTelemetry(token("A"));
    capture("error", "client_error", 'failed to save "felt awful, shoulder again"');
    await flush();
    const message = String(posted[0].body.events[0].message);
    expect(message).not.toContain("shoulder");
    expect(message).toContain("<str>");
  });

  it("drops detail keys that are not allowlisted", async () => {
    installTelemetry(token("A"));
    capture("error", "client_error", "boom", { code: "x", notes: "private prose" });
    await flush();
    const details = posted[0].body.events[0].details as Record<string, unknown>;
    expect(details.code).toBe("x");
    expect(details.notes).toBeUndefined();
  });
});

describe("the browser handlers", () => {
  it("registers error and unhandledrejection listeners, once", () => {
    const listeners: string[] = [];
    vi.stubGlobal("window", {
      addEventListener: (t: string) => listeners.push(t),
    });
    vi.stubGlobal("document", { addEventListener: (t: string) => listeners.push(t) });

    installTelemetry(token("A"));
    installTelemetry(token("A"));

    // Both browser hooks, and `visibilitychange` for the last flush on a tab
    // going away. Registered ONCE despite two installs: React strict mode runs
    // effects twice in development, and stacked listeners would capture every
    // error twice and make the counts a lie.
    expect(listeners).toEqual(["error", "unhandledrejection", "visibilitychange"]);
  });

  it("installs nothing when there is no window", () => {
    // Rendered on the server this must be a no-op rather than a crash — the
    // component that calls it is mounted in the root layout.
    expect(() => installTelemetry(token("A"))).not.toThrow();
  });
});

describe("nothing here may throw into a caller", () => {
  it("survives hostile input", () => {
    installTelemetry(token("A"));
    expect(() => capture("error", "client_error", undefined as unknown as string)).not.toThrow();
  });

  it("survives a flush with nothing installed", async () => {
    await expect(flush()).resolves.toBeUndefined();
  });
});
