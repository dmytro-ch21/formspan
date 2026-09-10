import { describe, expect, it } from "vitest";

import { NO_LABEL_MACROS, scaleLabelMacros } from "../nutritionApi";

/**
 * F37 — the web half of "a write never silently changes a label figure".
 *
 * The server now KEEPS the five label macros when a body does not mention
 * them, which is the right default for a client that cannot know about them.
 * Web is no longer such a client, and for two of its writes "keep" is the
 * wrong answer: halve an entry and the stored sodium would stay at full
 * strength, contradicting the calories printed beside it. So web sends them,
 * scaled — and this is the arithmetic that does it.
 */
describe("scaleLabelMacros", () => {
  const scanned = {
    saturated_fat_g: 4.5,
    sugar_g: 18,
    added_sugar_g: 15,
    sodium_mg: 210,
    cholesterol_mg: 5,
  };

  it("multiplies every stated figure", () => {
    expect(scaleLabelMacros(scanned, 0.5)).toEqual({
      saturated_fat_g: 2.25,
      sugar_g: 9,
      added_sugar_g: 7.5,
      sodium_mg: 105,
      cholesterol_mg: 2.5,
    });
  });

  /**
   * The property the whole module turns on, restated as arithmetic: absence is
   * a fact about what we KNOW, never a fact about the food. Half of "nobody
   * told us" is still "nobody told us" — never 0, which would be a claim no
   * source made.
   */
  it("leaves an unstated figure unstated rather than making it zero", () => {
    expect(scaleLabelMacros(NO_LABEL_MACROS, 2)).toEqual(NO_LABEL_MACROS);
    expect(scaleLabelMacros({ ...scanned, sodium_mg: null }, 2).sodium_mg).toBeNull();
  });

  /** A correction that does not touch the quantity must not touch the label. */
  it("is the identity at a factor of one", () => {
    expect(scaleLabelMacros(scanned, 1)).toEqual(scanned);
  });
});

/**
 * The round trip `docs/testing/functional-scenarios.md` asks for, in the same
 * branch that added the scenario — written because a review noticed the doc
 * demanded it and the tests only covered ½ and ×1 separately.
 *
 * The arithmetic is bit-exact rather than merely close, and for a reason worth
 * stating: 0.5 and 2 are exact binary fractions, so neither multiplication
 * rounds. That is the same mechanism the entry editor's own halve-then-double
 * scenario already relies on for kcal — the earlier version of that control
 * drifted (100 kcal came back 99.98) not because of the factors but because it
 * round-tripped through a two-decimal per-serving draft. Scaling the stored
 * number directly, as both do now, has no such step.
 */
describe("scaleLabelMacros round trips", () => {
  const scanned = {
    saturated_fat_g: 4.5,
    sugar_g: 18,
    added_sugar_g: 15,
    sodium_mg: 210,
    cholesterol_mg: 5,
  };

  it("is exactly inverse under halve-then-double", () => {
    expect(scaleLabelMacros(scaleLabelMacros(scanned, 0.5), 2)).toEqual(scanned);
  });

  it("is exactly inverse under double-then-halve", () => {
    expect(scaleLabelMacros(scaleLabelMacros(scanned, 2), 0.5)).toEqual(scanned);
  });

  /** The quarter-serving case that broke the entry editor's own scaling. */
  it("survives repeated halving without drifting", () => {
    // Annotated, not inferred: `scanned` infers as all-numbers, and the
    // function returns the nullable `Pick<Macros, ...>`. vitest does not
    // typecheck, so this only shows up under `tsc`.
    let m: ReturnType<typeof scaleLabelMacros> = scanned;
    for (let i = 0; i < 4; i++) m = scaleLabelMacros(m, 0.5);
    for (let i = 0; i < 4; i++) m = scaleLabelMacros(m, 2);
    expect(m).toEqual(scanned);
  });
});
