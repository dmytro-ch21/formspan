import { describe, expect, it } from "vitest";

import { formatTimeOfDay } from "@/lib/history";

/**
 * N126/#520 — pure arithmetic over minutes-since-midnight, matching mobile's
 * `lib/planTime.ts` `formatPlanTime` (same rounding, same 12-hour rendering).
 * Never touches `Date`/`Intl`, so nothing here can be affected by the runner's
 * timezone — see `formatTimeOfDay`'s own doc comment for why that matters.
 */
describe("formatTimeOfDay", () => {
  it("null is null, not a placeholder string", () => {
    expect(formatTimeOfDay(null)).toBeNull();
  });

  it("midnight is 12:00 AM, a real minute, not the same as absent", () => {
    expect(formatTimeOfDay(0)).toBe("12:00 AM");
  });

  it("noon is 12:00 PM", () => {
    expect(formatTimeOfDay(12 * 60)).toBe("12:00 PM");
  });

  it("7:00 PM — the reference design's own example", () => {
    expect(formatTimeOfDay(19 * 60)).toBe("7:00 PM");
  });

  it("the last minute of the day", () => {
    expect(formatTimeOfDay(1439)).toBe("11:59 PM");
  });

  it("out of range is null, not clamped or wrapped", () => {
    expect(formatTimeOfDay(-1)).toBeNull();
    expect(formatTimeOfDay(1440)).toBeNull();
  });
});
