import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "@/lib/api";
import { DEFAULT_TIMEOUT_MS, isTimeout } from "@/lib/deadline";
import { listModules } from "@/lib/modules";
import { capture, flush, installTelemetry, resetTelemetry } from "@/lib/telemetryClient";
import { fetchUnits } from "@/lib/unitSystem";

/**
 * N159 (#576): each production call site on web runs under the deadline.
 *
 * `deadline.test.ts` proves the wrapper. This proves the call sites use it —
 * every one of these would hang forever against `hang`, which is a backend that
 * accepts the connection and never answers, if its wrapper were removed.
 */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort);
  });
}

type Outcome<T> = { v?: T; e?: unknown; settled: boolean };

async function afterDeadline<T>(p: Promise<T>): Promise<Outcome<T>> {
  const out: Outcome<T> = { settled: false };
  p.then(
    (v) => Object.assign(out, { v, settled: true }),
    (e) => Object.assign(out, { e, settled: true }),
  );
  await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
  expect(out.settled).toBe(false); // not before the deadline
  await vi.advanceTimersByTimeAsync(1);
  return out;
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
const token = async () => "tok";

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    fetchCalls++;
    return hang(init!.signal!);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetTelemetry();
  vi.useRealTimers();
});

describe("api.ts request()", () => {
  it("ends a hung request in a TimeoutError at the deadline", async () => {
    vi.useFakeTimers();
    const out = await afterDeadline(apiRequest(token, "/profile"));
    expect(fetchCalls).toBe(1);
    expect(out.settled).toBe(true);
    expect(isTimeout(out.e)).toBe(true);
  });

  it("still reports a screen's own cancellation as the screen's abort", async () => {
    const c = new AbortController();
    const p = apiRequest(token, "/profile", {}, c.signal);
    c.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(isTimeout(err)).toBe(false);
  });
});

describe("modules.ts listModules()", () => {
  it("rejects with a TimeoutError, which the dashboard layout catches and fails open on", async () => {
    vi.useFakeTimers();
    const out = await afterDeadline(listModules(token));
    expect(fetchCalls).toBe(1);
    expect(isTimeout(out.e)).toBe(true);
  });
});

describe("unitSystem.ts fetchUnits()", () => {
  it("degrades to the defaults instead of holding the layout", async () => {
    vi.useFakeTimers();
    const out = await afterDeadline(fetchUnits(token));
    expect(fetchCalls).toBe(1);
    expect(out.e).toBeUndefined();
    expect(out.v).toEqual({ units: "metric", foodUnit: "g" });
  });
});

describe("telemetryClient.ts flush()", () => {
  it("settles, and counts the timed-out batch as lost on the next send", async () => {
    vi.useFakeTimers();
    installTelemetry(token);
    capture("error", "client_error", "boom");
    const out = await afterDeadline(flush());
    expect(fetchCalls).toBe(1);
    expect(out.e).toBeUndefined(); // flush never throws into its caller

    const posted: { events: { details: Record<string, unknown> }[] }[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init!.body)));
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch;
    capture("error", "client_error", "again");
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].events[0].details.lost_events).toBe(1);
  });
});
