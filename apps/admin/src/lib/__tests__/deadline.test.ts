import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ getToken: async () => "tok" }) }));

import { listUsers } from "@/lib/api";
import { DEFAULT_TIMEOUT_MS, TimeoutError, isTimeout, withDeadline } from "@/lib/deadline";

/**
 * N159 (#576): admin's copy of the web deadline, and `adminFetch` running under it.
 *
 * The copy is not pinned to web's by anything but its constants
 * (`check-timeout-parity.py`), so the properties that matter are asserted
 * here again rather than trusted to have been copied correctly.
 */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("admin's deadline copy", () => {
  it("times out with an error that is not named AbortError", async () => {
    const err = await withDeadline(undefined, { timeoutMs: 5 }, hang).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).name).toBe("TimeoutError");
    expect((err as Error).message).toBe("VOLA took too long to answer. Try again.");
  });

  it("lets a caller's cancellation win", async () => {
    const c = new AbortController();
    const p = withDeadline(c.signal, { timeoutMs: 60_000 }, hang);
    c.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });

  it("bounds the body, and does not trust a result that arrived after the deadline", async () => {
    const err = await withDeadline(undefined, { timeoutMs: 5 }, async (signal) =>
      hang(signal).catch(() => null),
    ).catch((e: unknown) => e);
    expect(isTimeout(err)).toBe(true);
  });
});

describe("adminFetch", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      fetchCalls++;
      return hang(init!.signal!);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("ends a hung backend read in a TimeoutError at the deadline, and not before", async () => {
    vi.useFakeTimers();
    let settled = false;
    let error: unknown;
    listUsers().then(
      () => (settled = true),
      (e: unknown) => {
        settled = true;
        error = e;
      },
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCalls).toBe(1);
    expect(settled).toBe(true);
    expect(isTimeout(error)).toBe(true);
  });
});
