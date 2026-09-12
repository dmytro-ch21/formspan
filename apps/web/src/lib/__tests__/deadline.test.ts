import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TIMEOUT_MS,
  SLOW_REQUEST_TIMEOUT_MS,
  TimeoutError,
  isTimeout,
  withDeadline,
} from "@/lib/deadline";

/**
 * N159 (#576): every web and admin request runs under a deadline.
 *
 * `hang` is a fetch that never answers and ends the way a real one does when
 * its signal aborts — with an `AbortError`. The deadline has to turn THAT into
 * a `TimeoutError`, because an `AbortError` is exactly what fifteen dashboard
 * call sites are written to ignore.
 */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort);
  });
}

function track<T>(p: Promise<T>) {
  const state: { v: "pending" | "resolved" | "rejected"; err?: unknown } = { v: "pending" };
  p.then(
    () => (state.v = "resolved"),
    (err) => {
      state.v = "rejected";
      state.err = err;
    },
  );
  return state;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a hung request times out", () => {
  it("at the default deadline, and not a millisecond before", async () => {
    vi.useFakeTimers();
    const s = track(withDeadline(undefined, {}, hang));
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(s.v).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.v).toBe("rejected");
    expect(s.err).toBeInstanceOf(TimeoutError);
    expect((s.err as TimeoutError).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("at a per-call budget when one is given", async () => {
    vi.useFakeTimers();
    const s = track(withDeadline(undefined, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS }, hang));
    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_TIMEOUT_MS - 1);
    expect(s.v).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(isTimeout(s.err)).toBe(true);
  });

  it("with an error that is not named AbortError, and says what happened", async () => {
    const err = await withDeadline(undefined, { timeoutMs: 5 }, hang).catch((e: unknown) => e);
    expect(isTimeout(err)).toBe(true);
    expect((err as Error).name).toBe("TimeoutError");
    expect((err as Error).name).not.toBe("AbortError");
    expect((err as Error).message).toBe("VOLA took too long to answer. Try again.");
  });

  it("when the headers arrive and the body never does", async () => {
    const err = await withDeadline(undefined, { timeoutMs: 5 }, async (signal) => {
      await Promise.resolve(); // the response object arrived
      return hang(signal); // reading it never finishes
    }).catch((e: unknown) => e);
    expect(isTimeout(err)).toBe(true);
  });

  it("even when the body read swallows its own abort, as api.ts's does", async () => {
    const err = await withDeadline(undefined, { timeoutMs: 5 }, async (signal) => {
      // `res.json().catch(() => null)`: without the rule, this resolves with null.
      return hang(signal).catch(() => null);
    }).catch((e: unknown) => e);
    expect(isTimeout(err)).toBe(true);
  });
});

describe("the caller's cancellation wins", () => {
  it("a caller abort surfaces as the caller's AbortError, not a timeout", async () => {
    const c = new AbortController();
    const p = withDeadline(c.signal, { timeoutMs: 60_000 }, hang);
    c.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(isTimeout(err)).toBe(false);
  });

  it("an already-aborted caller ends at once, as an abort", async () => {
    const c = new AbortController();
    c.abort();
    const err = await withDeadline(c.signal, { timeoutMs: 60_000 }, hang).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });

  it("when the deadline and the caller both fire, the caller is the answer", async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const s = track(
      withDeadline(c.signal, { timeoutMs: 10 }, (signal) =>
        new Promise<never>((_, reject) => {
          // The rejection lands a tick after the abort, the way a real fetch's does.
          signal.addEventListener("abort", () =>
            setTimeout(() => reject(new DOMException("aborted", "AbortError")), 1),
          );
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(10); // our deadline fires
    c.abort(); // and the screen abandons the request before the rejection lands
    await vi.advanceTimersByTimeAsync(1);
    expect(s.v).toBe("rejected");
    expect((s.err as Error).name).toBe("AbortError");
  });
});

describe("nothing lingers after a request settles", () => {
  it("clears its timer and lets go of the caller's signal", async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const remove = vi.spyOn(c.signal, "removeEventListener");
    await expect(withDeadline(c.signal, {}, async () => "answer")).resolves.toBe("answer");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not report a timeout for a request that finished in time", async () => {
    vi.useFakeTimers();
    const s = track(withDeadline(undefined, { timeoutMs: 50 }, async () => "answer"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.v).toBe("resolved");
  });

  it("passes a server error through unchanged", async () => {
    const boom = new Error("Request failed (500).");
    const err = await withDeadline(undefined, {}, async () => {
      throw boom;
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
  });
});
