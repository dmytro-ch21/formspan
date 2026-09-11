import { describe, expect, it } from "vitest";

import { entriesInMeal, type Entry, type Meal } from "@/lib/nutritionApi";

/**
 * Web renders the order the athlete arranged on their phone — N553/#1019.
 *
 * The ticket's criterion is "web renders the same order", and the honest
 * reading of that is a NEGATIVE: web must not have an order of its own.
 * `/nutrition/entries` sorts by `position` within a meal, so the whole of
 * web's job is to group by meal and change nothing — and the failure mode is
 * a `.sort()` added later, by somebody making the list "tidy", which would
 * silently overrule a gesture made on a phone with a rule nobody asked for.
 *
 * That is why this tests a one-line filter. The line is trivial; the property
 * is not, and until N553 it was inline in a Clerk-authenticated client
 * component where no test in this repo could reach it.
 */

const entry = (id: string, meal: Meal, name: string, position: number): Entry => ({
  id,
  user_id: "u1",
  eaten_on: "2026-08-18",
  meal,
  name,
  servings: 1,
  serving_label: "100 g",
  kcal: 100,
  protein_g: 10,
  carb_g: 5,
  fat_g: 2,
  fibre_g: null,
  // Required by `Macros` since F37; null is the honest value for a fixture
  // that is about ordering, not nutrition.
  saturated_fat_g: null,
  sugar_g: null,
  added_sugar_g: null,
  sodium_mg: null,
  cholesterol_mg: null,
  source_food_id: null,
  notes: "",
  position,
  created_at: "2026-08-18T07:00:00Z",
  updated_at: "2026-08-18T07:00:00Z",
});

describe("entriesInMeal", () => {
  // The server's order arrives already correct. Every alternative ordering a
  // future "tidy up" might reach for is deliberately WRONG here: the names are
  // not alphabetical, the ids are not in order, and the earliest-logged row is
  // not first — because the athlete dragged it down.
  const served: Entry[] = [
    entry("c", "breakfast", "Toast", 512),
    entry("a", "breakfast", "Eggs", 1024),
    entry("b", "breakfast", "Coffee", 3072),
    entry("d", "dinner", "Steak", 1024),
  ];

  it("keeps the server's order, which is the athlete's order", () => {
    expect(entriesInMeal(served, "breakfast").map((e) => e.name)).toEqual([
      "Toast",
      "Eggs",
      "Coffee",
    ]);
  });

  it("does not sort by name, id, or position value", () => {
    const got = entriesInMeal(served, "breakfast");
    expect(got.map((e) => e.name)).not.toEqual(["Coffee", "Eggs", "Toast"]); // alphabetical
    expect(got.map((e) => e.id)).not.toEqual(["a", "b", "c"]); // by id
  });

  it("keeps meals apart — position is per meal and never compared across them", () => {
    // Steak and Eggs both sit at 1024. A grouping that leaked one into the
    // other's list would put two rows at the same position in one meal, which
    // is the one state the ordering scheme has no answer for.
    expect(entriesInMeal(served, "dinner").map((e) => e.name)).toEqual(["Steak"]);
    expect(entriesInMeal(served, "breakfast").some((e) => e.name === "Steak")).toBe(false);
  });

  it("is empty, not undefined, for a meal with nothing in it", () => {
    expect(entriesInMeal(served, "snack")).toEqual([]);
  });
});
