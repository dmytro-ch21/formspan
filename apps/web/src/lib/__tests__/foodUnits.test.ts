/**
 * Food quantity units on web (N90).
 *
 * `apps/web/src/lib/units.ts` is a deliberate duplicate of the mobile file —
 * see the note at its top — so it gets the same assertions. A conversion that
 * drifts between the two apps would show the same meal at two different
 * quantities depending on which screen the athlete opened.
 */
import { describe, expect, test } from "vitest";

import {
  defaultFoodUnit,
  formatFoodQuantity,
  fromDisplayGrams,
  toDisplayGrams,
} from "../units";

describe("food units", () => {
  test("one ounce is the avoirdupois 28.35 g, not a rounded 28", () => {
    expect(fromDisplayGrams(1, "oz")).toBeCloseTo(28.35, 2);
  });

  test("an oz round trip is stable at the precision offered", () => {
    for (const typed of [0.5, 1, 3.5, 5.29, 12.75, 16]) {
      expect(toDisplayGrams(fromDisplayGrams(typed, "oz"), "oz")).toBeCloseTo(typed, 2);
    }
  });

  test("switching unit converts rather than relabelling", () => {
    expect(toDisplayGrams(150, "g")).toBe(150);
    expect(toDisplayGrams(150, "oz")).toBeCloseTo(5.29, 2);
  });

  test("the default follows unit_system, and only as a default", () => {
    expect(defaultFoodUnit("imperial")).toBe("oz");
    expect(defaultFoodUnit("metric")).toBe("g");
  });

  test("absence renders as a dash, never as zero", () => {
    expect(formatFoodQuantity(null, "g")).toBe("—");
    expect(formatFoodQuantity(150, "oz")).toBe("5.29oz");
  });
});
