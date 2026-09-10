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
