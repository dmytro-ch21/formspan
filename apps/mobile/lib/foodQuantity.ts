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
 * The narrowest shape these functions actually need — deliberately NOT
 * `CatalogFood` itself.
 *
 * A barcode scan (`ScannedFood`, `lib/barcodeApi.ts`) has every field here and
 * neither `id` nor `category`, which `CatalogFood` carries only because it is
 * a row in OUR catalog. Typing `macrosForGrams`/`quantityOptions` against the
 * full `CatalogFood` would force the scan screen (N117) to fabricate an `id`
 * and a `category` just to satisfy the compiler for a food that has neither —
 * so this is the actual contract, and `CatalogFood` satisfies it structurally
 * with nothing extra to add.
 */
export type QuantifiableFood = Macros &
  Pick<CatalogFood, 'name' | 'brand' | 'serving_grams'> & {
    portions?: CatalogPortion[];
  };

/**
 * Name and brand, without repeating the brand when it is already in the name
 * (N426, found in review) — a scanned "Kinder Chocolate" whose brand is
 * "Kinder" must read as "Kinder Chocolate", not the literal, wrong
 * "Kinder Kinder Chocolate" a naive `${brand} ${name}` produces.
 *
 * Shared by every caller that renders a food's name — `scan.tsx` had its own
 * copy of this exact check before N426 (`FoodQuantity` did not, which is
 * where the duplicate-name bug actually surfaced) — so a future caller gets
 * the guard automatically rather than needing to remember to add it.
 */
export function displayName(food: Pick<QuantifiableFood, 'name' | 'brand'>): string {
  if (!food.brand) return food.name;
  if (food.name.toLowerCase().includes(food.brand.toLowerCase())) return food.name;
  return `${food.brand} ${food.name}`;
}

/**
 * A discrete unit derived from the packet's OWN stated serving (N426,
 * reported from a device against N427's own scoping question: "a discrete
 * count for a food whose per-serving figures are already in per-piece
 * terms... is derivable without more data than OFF states"). "2 pieces
 * (25 g)" implies one piece weighs 12.5 g — no density, no per-item catalog
 * fact, nothing this codebase does not already have.
 *
 * Deliberately narrow, matching N117's own discipline: this parses ONE
 * shape (a leading count, a word, matched against the packet's own label —
 * never a catalog portion like "1 large" or "1 cup", which is why this
 * takes the raw label rather than being folded into `quantityOptions`)
 * and returns `null` for anything it cannot read cleanly. A "pieces" toggle
 * that sometimes shows the wrong weight is a worse instance of exactly the
 * bug N117 fixed — offering none is safer than guessing at one.
 */
export type NaturalUnit = {
  /** Singular, for "1 piece" — "pieces" crudely singularised. */
  word: string;
  /** As the packet states it — "pieces", "bars", "cookies" — for the toggle. */
  wordPlural: string;
  gramsPerUnit: number;
};

const NATURAL_UNIT_LABEL_RE = /^(\d+(?:\.\d+)?)\s+([A-Za-z]+)/;

/**
 * Words the regex can match that are NOT a natural count unit — found in
 * review: OFF's `serving_size` is a free-text string with no shape
 * guarantee, and `"25 g"` matches the same `<count> <word>` pattern
 * `"2 pieces"` does. Offering "g" as a second, duplicate unit pill (beside
 * the real grams toggle) — or "x" from `"2 x 25 g"` — is exactly the
 * confusing-screen failure this feature exists to fix, just relocated.
 */
const NOT_A_NATURAL_UNIT = new Set([
  'g',
  'gr',
  'gram',
  'grams',
  'oz',
  'ounce',
  'ounces',
  'ml',
  'l',
  'kg',
  'mg',
  'x',
]);

export function naturalUnitFor(label: string | null, totalGrams: number | null): NaturalUnit | null {
  if (!label || totalGrams == null || !Number.isFinite(totalGrams) || totalGrams <= 0) return null;
  const m = label.match(NATURAL_UNIT_LABEL_RE);
  if (!m) return null;
  const count = Number(m[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  const wordPlural = m[2];
  // Found in review: `[A-Za-z]+` stops at the first non-ASCII character, so
  // "2 Stück (25 g)" matches only "St" — a real word cut short, not a real
  // unit. The character immediately after the match has to be whitespace,
  // an opening paren, or punctuation for the match to be trusted as whole;
  // anything else means the regex stopped mid-word.
  const boundary = label[m[0].length];
  if (boundary && !/[\s(),.]/.test(boundary)) return null;
  if (NOT_A_NATURAL_UNIT.has(wordPlural.toLowerCase())) return null;
  return { word: singularize(wordPlural), wordPlural, gramsPerUnit: totalGrams / count };
}

/** "pieces" → "piece". Deliberately crude — wrong only cosmetically (a stray
 *  "1 pieces" reads oddly but claims nothing false), never worth a real
 *  pluralisation library for a label this narrow. */
function singularize(word: string): string {
  // "glasses"/"classes" → "glass"/"class": the -sses plural drops "es", not
  // "s" — stripping only the last letter left the wrong, ungrammatical
  // "glasse". Checked first because the general rule below would otherwise
  // fire on these too (they end in "s").
  if (word.length > 4 && /sses$/i.test(word)) return word.slice(0, -2);
  if (word.length > 3 && /s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

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
export function macrosForGrams(food: QuantifiableFood, grams: number): Macros {
  return scaleMacros(food, servingsForGrams(food, grams));
}

/**
 * The macros for a plain SERVINGS multiplier — no gram basis involved.
 *
 * For a food with no honest gram weight (`serving_grams: null` — an
 * AI-described "1 egg", cached against a barcode by `describe.tsx`),
 * `macrosForGrams`'s model does not apply: there is no gram basis to scale
 * against that would not be invented, and `servingBasisGrams`'s 100 g
 * fallback exists for the catalog case, not this one. This is the
 * basis-agnostic form the scan screen used everywhere before N117 (typing a
 * "servings" count directly) — kept as its own function so a caller
 * (`canLogByWeight` is how it decides) reaches for it deliberately instead
 * of routing an ungrammed food through the grams control and silently
 * fabricating a basis it never stated.
 */
export function macrosForServings(food: Macros, servings: number): Macros {
  return scaleMacros(food, servings);
}

function scaleMacros(food: Macros, s: number): Macros {
  return {
    kcal: round1(food.kcal * s),
    protein_g: round1(food.protein_g * s),
    carb_g: round1(food.carb_g * s),
    fat_g: round1(food.fat_g * s),
    fibre_g: food.fibre_g == null ? null : round1(food.fibre_g * s),
    saturated_fat_g: food.saturated_fat_g == null ? null : round1(food.saturated_fat_g * s),
    sugar_g: food.sugar_g == null ? null : round1(food.sugar_g * s),
    added_sugar_g: food.added_sugar_g == null ? null : round1(food.added_sugar_g * s),
    sodium_mg: food.sodium_mg == null ? null : round1(food.sodium_mg * s),
    cholesterol_mg: food.cholesterol_mg == null ? null : round1(food.cholesterol_mg * s),
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

/**
 * A gram basis, read back out of a `serving_label` that states one honestly
 * (N90's edit-an-existing-entry half).
 *
 * `nutrition_entries` has no gram column — `servings` is a multiplier against
 * whatever `serving_label` says one serving is, and that label is free text:
 * "100 g" for almost everything the catalog logs, but also "1 scoop (30 g)" or
 * plain "1 egg" for a saved or described food. Only the first shape is honestly
 * a weight — a scoop's "30 g" is a parenthetical about the scoop, not the unit
 * the athlete is choosing between servings of, and "1 egg" has no gram claim in
 * it at all.
 *
 * So this matches ONLY a label that is a bare number and "g" — `/^\d+(\.\d+)?
 * \s*g$/i` after trimming — and returns null for everything else, including
 * the two examples above. A caller that got a basis for "1 scoop (30 g)" would
 * offer a grams control for a scoop and silently start counting scoops as
 * grams, which is the exact relabel-not-convert bug this ticket's other half
 * (`FoodQuantity`) already refuses.
 */
export function gramsBasisFromLabel(servingLabel: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*g$/i.exec(servingLabel.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Grams -> servings, for a label that honestly states a gram basis — null when
 * it does not, so a caller can fall back to editing servings directly rather
 * than inventing a basis `gramsBasisFromLabel` just refused to guess.
 */
export function servingsForLabelGrams(servingLabel: string, grams: number): number | null {
  const basis = gramsBasisFromLabel(servingLabel);
  if (basis == null) return null;
  return grams / basis;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
