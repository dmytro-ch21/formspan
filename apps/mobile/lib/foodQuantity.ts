/**
 * Turning "how much of this did you eat" into what gets logged (N90).
 *
 * Before this, tapping a catalog row logged `servings: 1` — one 100 g serving —
 * with no way to say otherwise, so an athlete eating one banana logged 100 g of
 * banana.
 *
 * # Grams are the currency, everywhere
 *
 * The athlete may type in grams or ounces and may tap a portion ("1 large" =
 * 50 g), and all three funnel through GRAMS before anything is computed. That
 * is the same rule `lib/units.ts` states for weight and distance, and it is why
 * `nutrition_entries` needed no new column: an entry already stores a `servings`
 * multiplier against the food's own serving, and grams divide straight into it.
 *
 * # The entry keeps recording what it recorded
 *
 * `servings` is `grams / serving_grams`, so 150 g of a per-100 g food is 1.5
 * servings and the macros are scaled by 1.5. Nothing here points at a portion
 * row: correcting a catalog portion later must not rewrite a meal somebody
 * already logged, which is the same rule migration 000066 states for
 * `source_food_id`.
 */
import type { CatalogFood, CatalogPortion } from './catalogApi';
import type { Macros } from './nutrition';

/** A catalog food can always be measured, even with no portions listed. */
export const FALLBACK_SERVING_GRAMS = 100;

/**
 * The gram basis one "serving" of this food represents.
 *
 * `serving_grams` is nullable on the wire — an egg has no honest gram weight —
 * and a null must never become 0, which would make `grams / basis` infinite and
 * every macro `NaN`. Falling back to 100 is safe because every USDA-seeded row
 * IS per 100 g; a food that genuinely has no gram basis simply cannot be logged
 * by weight, and `canLogByWeight` below is how a caller asks.
 */
export function servingBasisGrams(food: Pick<CatalogFood, 'serving_grams'>): number {
  const basis = food.serving_grams;
  if (basis == null || !Number.isFinite(basis) || basis <= 0) {
    return FALLBACK_SERVING_GRAMS;
  }
  return basis;
}

/** Whether this food states a real gram basis, rather than borrowing the fallback. */
export function canLogByWeight(food: Pick<CatalogFood, 'serving_grams'>): boolean {
  const basis = food.serving_grams;
  return basis != null && Number.isFinite(basis) && basis > 0;
}

/**
 * How many servings a gram quantity represents.
 *
 * Not rounded. Rounding here would quantise the macros — 150 g of a per-100 g
 * food is exactly 1.5 servings, and a `servings` rounded to 1 would under-log by
 * a third. The DATABASE stores this at NUMERIC(9,2), which is plenty at the
 * quantities food is logged in.
 */
export function servingsForGrams(
  food: Pick<CatalogFood, 'serving_grams'>,
  grams: number,
): number {
  return grams / servingBasisGrams(food);
}

/**
 * The macros for a gram quantity of a catalog food.
 *
 * Deliberately computed from the food's own per-serving numbers rather than
 * from any per-gram figure, because that is what the catalog states and
 * re-deriving would introduce a second source for one fact.
 */
export function macrosForGrams(food: CatalogFood, grams: number): Macros {
  const s = servingsForGrams(food, grams);
  return {
    kcal: round1(food.kcal * s),
    protein_g: round1(food.protein_g * s),
    carb_g: round1(food.carb_g * s),
    fat_g: round1(food.fat_g * s),
    fibre_g: food.fibre_g == null ? null : round1(food.fibre_g * s),
  };
}

/**
 * The quantity options offered, most useful first.
 *
 * **100 g is always present and always last**, because it is the one
 * measurement a kitchen scale always gives and 268 of the catalog's 12,651 rows
 * state no portion at all. It is appended rather than prepended so USDA's own
 * ordering — which puts the most representative portion first — still leads.
 *
 * Deduped on gram weight so a food whose only portion happens to weigh 100 g
 * does not offer the same amount twice under two names.
 */
export function quantityOptions(
  food: Pick<CatalogFood, 'serving_grams'>,
  portions: CatalogPortion[] | undefined,
): { label: string; grams: number }[] {
  const out: { label: string; grams: number }[] = [];
  const seen = new Set<number>();
  for (const p of portions ?? []) {
    if (!Number.isFinite(p.grams) || p.grams <= 0) continue;
    if (seen.has(p.grams)) continue;
    seen.add(p.grams);
    out.push({ label: p.label, grams: p.grams });
  }
  const basis = servingBasisGrams(food);
  if (!seen.has(basis)) {
    out.push({ label: `${basis} g`, grams: basis });
  }
  return out;
}

/**
 * Parse what was typed. Returns null for anything that is not a usable
 * quantity, so a caller can keep the log button disabled rather than logging a
 * NaN.
 *
 * Rejects zero and negatives: `nutrition_entries.servings` CHECKs `> 0`, so a
 * zero would be a 500 from the server rather than an empty meal.
 */
export function parseQuantity(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
