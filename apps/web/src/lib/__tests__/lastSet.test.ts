import { describe, expect, it } from "vitest";

import type { Suggestion } from "../api";
import { lastSetLine } from "../lastSet";
import { formatWeight } from "../units";

/**
 * F62/#1165 — web's progression card printed a suggestion's top set as
 * "8 × 100kg · 1 RIR" even when three of the eight were spotted, beside a
 * progression measured against the solo count.
 */
const s = (over: Partial<Suggestion> = {}) =>
  ({ last_reps: 8, last_weight_kg: 100, last_rir: 1, last_rpe: null, ...over }) as Suggestion;
const w = formatWeight(100, "metric");

describe("the progression card's last set says when reps were assisted", () => {
  it("between the load and the effort", () => {
    expect(lastSetLine(s({ last_assisted_reps: 3 }), "metric")).toBe(`8 × ${w} (3 assisted) · 1 RIR`);
  });

  it.each([
    ["unrecorded (null)", null],
    ["none of them (0)", 0],
  ] as const)("adds nothing when assistance is %s", (_label, assisted) => {
    expect(lastSetLine(s({ last_assisted_reps: assisted }), "metric")).toBe(`8 × ${w} · 1 RIR`);
  });

  it("adds nothing when absent, an older response", () => {
    expect(lastSetLine(s(), "metric")).toBe(`8 × ${w} · 1 RIR`);
  });

  it("says nothing about assistance with no rep count to qualify", () => {
    expect(lastSetLine(s({ last_reps: null, last_assisted_reps: 3 }), "metric")).toBe(`${w} · 1 RIR`);
  });

  it("is null with no weight, as before", () => {
    expect(lastSetLine(s({ last_weight_kg: null }), "metric")).toBeNull();
  });
});
