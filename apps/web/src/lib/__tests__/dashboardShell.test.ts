import { afterEach, describe, expect, it, vi } from "vitest";

import { readShell } from "@/lib/dashboardShell";
import { DEFAULT_TIMEOUT_MS } from "@/lib/deadline";

/**
 * N159 (#576): the dashboard shell's two server reads start together.
 *
 * Each ends at the request deadline, so awaiting them in turn made a hung API
 * cost the shell two deadlines before it painted. These pin that it costs one,
 * and that neither read's fallback can cost the other.
 */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort);
  });
}

const originalFetch = globalThis.fetch;
const token = async () => "tok";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("readShell", () => {
  it("starts both reads at once, and paints after ONE deadline when the API hangs", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      started.push(String(url));
      return hang(init!.signal!);
    }) as unknown as typeof fetch;

    let result: unknown;
    readShell(token).then((v) => (result = v));

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2); // both requests are already on the wire

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(result).toEqual({ modules: [], units: "metric", foodUnit: "g" });
  });

  it("a failed modules read does not cost the units", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/modules")) {
        return new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), { status: 500 });
      }
      return new Response(JSON.stringify({ unit_system: "imperial", food_unit: "oz" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(readShell(token)).resolves.toEqual({ modules: [], units: "imperial", foodUnit: "oz" });
  });
});
