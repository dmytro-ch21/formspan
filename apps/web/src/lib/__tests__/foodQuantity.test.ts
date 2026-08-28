/**
 * Reading a gram basis out of a free-text serving/ingredient label (N90).
 *
 * Same assertions as `apps/mobile/lib/__tests__/foodQuantity.test.ts`'s
 * `gramsBasisFromLabel` describe block — this file is a hand-written,
 * per-app duplicate (see the header of `../foodQuantity.ts`), and a drift
 * between the two would let one app offer a grams control the other refuses
 * for the exact same label.
 */
import { describe, expect, test } from "vitest";

import { gramsBasisFromLabel, parseQuantity, quantityForLabelGrams } from "../foodQuantity";
import { fromDisplayGrams } from "../units";

describe("gramsBasisFromLabel", () => {
  test("a bare gram weight is read as a basis", () => {
    expect(gramsBasisFromLabel("100 g")).toBe(100);
    expect(gramsBasisFromLabel("182.5 g")).toBeCloseTo(182.5, 5);
  });

  test("no space, and a capital G, both still count", () => {
    expect(gramsBasisFromLabel("30g")).toBe(30);
    expect(gramsBasisFromLabel("30G")).toBe(30);
  });

  test("surrounding whitespace does not defeat it", () => {
    expect(gramsBasisFromLabel("  100 g  ")).toBe(100);
  });

  test("a parenthetical gram note is NOT a basis for the label as a whole", () => {
    expect(gramsBasisFromLabel("1 scoop (30 g)")).toBeNull();
  });

  test("a label with no gram claim at all has no basis", () => {
    expect(gramsBasisFromLabel("1 egg")).toBeNull();
    expect(gramsBasisFromLabel("1 portion")).toBeNull();
  });

  test("trailing text after the unit disqualifies it — the label must be BARE grams", () => {
    // An unanchored end would let "100 g rounded" and "100 grams" through as
    // a 100 g basis — the label must be the whole claim, not a prefix of one.
    expect(gramsBasisFromLabel("100 g rounded")).toBeNull();
    expect(gramsBasisFromLabel("100 grams")).toBeNull();
  });

  test("zero grams is refused — a basis of zero would divide by zero downstream", () => {
    expect(gramsBasisFromLabel("0 g")).toBeNull();
  });

  test("empty and whitespace-only labels have no basis", () => {
    expect(gramsBasisFromLabel("")).toBeNull();
    expect(gramsBasisFromLabel("   ")).toBeNull();
  });
});

describe("quantityForLabelGrams", () => {
  test("divides by the basis the label states", () => {
    expect(quantityForLabelGrams("100 g", 250)).toBeCloseTo(2.5, 5);
  });

  test("is the exact inverse of the basis multiplication a caller does to redisplay it", () => {
    const quantity = quantityForLabelGrams("182 g", 273)!;
    expect(quantity * 182).toBeCloseTo(273, 5);
  });

  test("null for a label with no honest gram basis, rather than inventing one", () => {
    expect(quantityForLabelGrams("1 egg", 250)).toBeNull();
  });
});

describe("parseQuantity", () => {
  test("accepts a plain positive number", () => {
    expect(parseQuantity("150")).toBe(150);
    expect(parseQuantity("2.5")).toBe(2.5);
  });

  test("accepts a comma decimal separator", () => {
    expect(parseQuantity("2,5")).toBe(2.5);
  });

  test("rejects zero, negatives, and unusable text", () => {
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("-5")).toBeNull();
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
  });
});

/**
 * N90 criterion 7, web half: the same real quantity typed in g and in oz
 * must resolve to the same stored multiplier — `FoodQuantityInput` always
 * reports grams to its caller, and the caller (RecipeEditor, DayEditor)
 * always divides by the SAME basis regardless of which unit produced the
 * gram figure. This is the composition that makes that true.
 */
test("the same real quantity typed in g and in oz resolves to the same multiplier", () => {
  const viaOunces = fromDisplayGrams(4, "oz"); // "4" typed with the oz toggle on
  const viaGrams = fromDisplayGrams(113.4, "g"); // "113.4" typed with the g toggle on
  expect(viaOunces).toBeCloseTo(viaGrams, 1);

  const a = quantityForLabelGrams("100 g", viaOunces)!;
  const b = quantityForLabelGrams("100 g", viaGrams)!;
  expect(a).toBeCloseTo(b, 3);
});
