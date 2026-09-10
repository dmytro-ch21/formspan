import { describe, expect, it } from "vitest";

import { perServing } from "../RecipeEditor";

/**
 * F37 — the web preview of a recipe's own label macros must agree with what the
 * server will actually store.
 *
 * The server DERIVES a recipe's per-serving macros from its items
 * (`Food.PerServing` in `backend/internal/modules/nutrition/nutrition.go`) and
 * its answer is the one that lands in the database. This function computes the
 * same thing for the live preview beside the form. If the two ever disagree,
 * the screen lies about what saving will do — and it lies quietly, because both
 * numbers are plausible and nothing compares them.
 *
 * Written because a review pointed out `perServing` had no test at all, while
 * the invariant it backs ("web must not clear a scanned ingredient's label
 * macros just by opening and saving a recipe") was one of the load-bearing
 * ones.
 */

/** An ingredient draft, with only the fields these cases care about stated. */
function item(over: Partial<Parameters<typeof perServing>[0][number]> = {}) {
  return {
    key: "k",
    name: "Bar",
    quantity: "1",
    serving_label: "1 bar",
    kcal: "240",
    protein_g: "9",
    carb_g: "27",
    fat_g: "11",
    fibre_g: "",
    labels: {
      saturated_fat_g: null,
      sugar_g: null,
      added_sugar_g: null,
      sodium_mg: null,
      cholesterol_mg: null,
    },
    ...over,
  };
}

const stated = {
  saturated_fat_g: 4.5,
  sugar_g: 18,
  added_sugar_g: 15,
  sodium_mg: 210,
  cholesterol_mg: 5,
};

describe("perServing — the five label macros", () => {
  it("sums a stated figure across quantity and divides by the yield", () => {
    // Two bars over two servings is one bar per serving.
    const per = perServing([item({ quantity: "2", labels: stated })], 2);
    expect(per.sodium_mg).toBe(210);
    expect(per.saturated_fat_g).toBe(4.5);
  });

  /**
   * The rule the whole module turns on, and the server's own: a recipe whose
   * ingredients never mention sodium is not a sodium-free recipe. Zero would be
   * a claim no label made.
   */
  it("stays null when NO item states a figure, rather than reporting zero", () => {
    const per = perServing([item(), item()], 2);
    for (const v of [
      per.saturated_fat_g,
      per.sugar_g,
      per.added_sugar_g,
      per.sodium_mg,
      per.cholesterol_mg,
    ]) {
      expect(v).toBeNull();
    }
  });

  /**
   * Partial is the honest best available, and it matches the server exactly —
   * `Food.PerServing`'s own comment says so: if some ingredients state a figure
   * and others do not, the total is the sum of those that did and reads as
   * complete. Documented here too, because a reader could reasonably expect the
   * opposite (that one silent ingredient poisons the total to null).
   */
  it("sums only the items that stated, when some did and some did not", () => {
    const per = perServing([item({ labels: stated }), item()], 1);
    expect(per.sodium_mg).toBe(210);
  });

  /** An item stating ZERO is a measurement, and must not read as silence. */
  it("treats a stated zero as stated", () => {
    const per = perServing([item({ labels: { ...stated, sodium_mg: 0 } })], 1);
    expect(per.sodium_mg).toBe(0);
    expect(per.sodium_mg).not.toBeNull();
  });

  /** The existing fibre rule, asserted alongside so the two cannot drift. */
  it("applies the same stated/unstated rule to fibre", () => {
    expect(perServing([item()], 1).fibre_g).toBeNull();
    expect(perServing([item({ fibre_g: "3" })], 1).fibre_g).toBe(3);
  });
});
