/**
 * Building a recipe on the phone (N87).
 *
 * A recipe is a saved food with a yield and a list of ingredients. The athlete
 * says "this makes 4 portions", adds what went in, and afterwards logs *a
 * portion of it* like any other saved food.
 *
 * # The rule this file exists to keep visible
 *
 * **An ingredient's macros are a COPY, taken when it was added.** So is a
 * logged entry's. That means:
 *
 * - correcting a saved food next month does not rewrite a recipe built from it
 *   today, and
 * - **editing a recipe does not rewrite meals already logged from it.** A
 *   logged portion keeps the numbers it was logged with, for good; the edit
 *   changes what the NEXT portion logs.
 *
 * That is not an implementation detail that happened to fall out — it is the
 * same decision `nutrition_entries` and `nutrition_targets` both make, and the
 * alternative was considered and refused. Following the reference at read time
 * is shorter, compiles, and passes every test, which is exactly the problem: a
 * typo fixed in a recipe would silently restate every day an athlete has
 * already used to judge whether their cut is working, and there would be
 * nothing left to compare against. The editor SAYS this, because an author who
 * assumes a correction propagates is wrong about their own history.
 *
 * # The server is authoritative
 *
 * `perServing` here mirrors the Go `Food.PerServing()` so the editor can preview
 * a portion live. The server recomputes on write and ITS answer is what is
 * stored — this is a preview, never the source of truth.
 */

import type { CatalogFood } from './catalogApi';
import { macrosForGrams } from './foodQuantity';
import type { Food, Macros, RecipeItem } from './nutrition';

/** The most ingredients the server will accept in one recipe. */
export const MAX_ITEMS = 100;

/** The largest yield the server will accept ("this makes N portions"). */
export const MAX_YIELD = 1000;

/**
 * The server's own length limits, mirrored — and mirrored in its UNITS.
 *
 * `validateName` and `validateLabel` trim, then count **runes**
 * (`len([]rune(n))`), so the client has to count code points, not UTF-16 units.
 * `brand` is checked with a bare `len(f.Brand)`, which in Go is **bytes** — a
 * different unit, and using runes for it would let a non-ASCII note through
 * that the server refuses.
 *
 * These exist because getting them wrong is not a validation message, it is a
 * LOST RECIPE: the server answers 400, `classify` reads a 400 as permanent, the
 * outbox clears `dirty`, and the recipe lives only on that phone with nothing
 * anywhere saying so. Checking here is also what makes the refusal work
 * offline, where the server's answer is not available at all.
 */
export const MAX_NAME_RUNES = 120;
export const MAX_LABEL_RUNES = 40;
export const MAX_BRAND_BYTES = 80;

/** Code points, matching Go's `len([]rune(strings.TrimSpace(v)))`. */
function runes(v: string): number {
  return Array.from(v.trim()).length;
}

/** UTF-8 bytes, matching Go's `len(s)` on a string. */
function bytes(v: string): number {
  return new TextEncoder().encode(v.trim()).length;
}

/**
 * Cut a name down to what the server will accept.
 *
 * **Measured, not hypothetical: 72 of the catalog's 12,651 foods have names
 * over 120 runes, the longest 184** — USDA descriptions like "Chicken or
 * turkey, breaded, fried, garden salad with bacon and cheese, …". Copying one
 * verbatim into an ingredient produced a recipe that passed every client check
 * and then 400-ed permanently on push.
 *
 * Truncating rather than refusing, because the athlete did nothing wrong — they
 * picked a real food out of our own catalog — and a picker that rejects 72 of
 * its own rows is a worse answer than a shortened label. The ellipsis is there
 * so a clipped name reads as clipped rather than as a different food.
 */
export function clampName(v: string): string {
  const cp = Array.from(v.trim());
  if (cp.length <= MAX_NAME_RUNES) return v.trim();
  return cp.slice(0, MAX_NAME_RUNES - 1).join('').trimEnd() + '…';
}

/**
 * Sum a recipe's ingredients and divide by its yield.
 *
 * Mirrors `Food.PerServing()` in `backend/internal/modules/nutrition`, INCLUDING
 * its fibre rule: fibre is summed only if at least one ingredient states it, so
 * a recipe whose ingredients never mention fibre reports "not stated" rather
 * than a total assembled out of silence. Zero would be a claim; null is the
 * absence of one.
 *
 * A yield of zero or less returns zeroes rather than dividing — the caller is
 * mid-edit with an empty field, and `Infinity` on screen is worse than 0.
 */
export function perServing(items: RecipeItem[], yieldServings: number): Macros {
  const out: Macros = {
    kcal: 0,
    protein_g: 0,
    carb_g: 0,
    fat_g: 0,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
  };
  if (!(yieldServings > 0)) return out;

  let fibreSum = 0;
  let fibreStated = false;
  let saturatedFatSum = 0;
  let saturatedFatStated = false;
  let sugarSum = 0;
  let sugarStated = false;
  let addedSugarSum = 0;
  let addedSugarStated = false;
  let sodiumSum = 0;
  let sodiumStated = false;
  let cholesterolSum = 0;
  let cholesterolStated = false;
  for (const it of items) {
    out.kcal += it.kcal * it.quantity;
    out.protein_g += it.protein_g * it.quantity;
    out.carb_g += it.carb_g * it.quantity;
    out.fat_g += it.fat_g * it.quantity;
    if (it.fibre_g != null) {
      fibreSum += it.fibre_g * it.quantity;
      fibreStated = true;
    }
    if (it.saturated_fat_g != null) {
      saturatedFatSum += it.saturated_fat_g * it.quantity;
      saturatedFatStated = true;
    }
    if (it.sugar_g != null) {
      sugarSum += it.sugar_g * it.quantity;
      sugarStated = true;
    }
    if (it.added_sugar_g != null) {
      addedSugarSum += it.added_sugar_g * it.quantity;
      addedSugarStated = true;
    }
    if (it.sodium_mg != null) {
      sodiumSum += it.sodium_mg * it.quantity;
      sodiumStated = true;
    }
    if (it.cholesterol_mg != null) {
      cholesterolSum += it.cholesterol_mg * it.quantity;
      cholesterolStated = true;
    }
  }
  out.kcal /= yieldServings;
  out.protein_g /= yieldServings;
  out.carb_g /= yieldServings;
  out.fat_g /= yieldServings;
  out.fibre_g = fibreStated ? fibreSum / yieldServings : null;
  out.saturated_fat_g = saturatedFatStated ? saturatedFatSum / yieldServings : null;
  out.sugar_g = sugarStated ? sugarSum / yieldServings : null;
  out.added_sugar_g = addedSugarStated ? addedSugarSum / yieldServings : null;
  out.sodium_mg = sodiumStated ? sodiumSum / yieldServings : null;
  out.cholesterol_mg = cholesterolStated ? cholesterolSum / yieldServings : null;
  return out;
}

/**
 * An ingredient picked out of the food catalog, at a weight in grams.
 *
 * **`quantity` is 1 and the macros are the ABSOLUTE figures for that weight**,
 * with the weight itself written into `serving_label`. The alternative — a
 * per-100 g row with `quantity: 1.5` — stores the same arithmetic and reads
 * worse: "1.5 × 100 g" is a puzzle where "150 g" is an answer, and the label is
 * what the athlete sees in the ingredient list a month later.
 *
 * `source_food_id` is deliberately **null**. It is a foreign key into the
 * athlete's OWN saved foods, and a catalog id lives in a different id space —
 * writing one there would dangle. The same reason the log records `null` for a
 * catalog row.
 */
export function itemFromCatalog(food: CatalogFood, grams: number): RecipeItem {
  return {
    name: clampName(food.brand ? `${food.brand} ${food.name}` : food.name),
    quantity: 1,
    serving_label: `${round(grams)} g`,
    ...macrosForGrams(food, grams),
    source_food_id: null,
  };
}

/**
 * An ingredient taken from one of the athlete's own saved foods.
 *
 * Unlike the catalog case this DOES carry `source_food_id`, because a saved
 * food is in the same id space the column references. It is provenance only —
 * it answers "where did this come from", and nothing that returns nutrition
 * follows it.
 */
export function itemFromSavedFood(food: Food, quantity: number): RecipeItem {
  return {
    name: clampName(food.brand ? `${food.brand} ${food.name}` : food.name),
    quantity,
    serving_label: food.serving_label,
    kcal: food.kcal,
    protein_g: food.protein_g,
    carb_g: food.carb_g,
    fat_g: food.fat_g,
    fibre_g: food.fibre_g,
    saturated_fat_g: food.saturated_fat_g,
    sugar_g: food.sugar_g,
    added_sugar_g: food.added_sugar_g,
    sodium_mg: food.sodium_mg,
    cholesterol_mg: food.cholesterol_mg,
    source_food_id: food.id,
  };
}

/** What is wrong with a draft, or null when it is ready to save. */
export type RecipeProblem =
  | 'no_name'
  | 'name_too_long'
  | 'no_serving_label'
  | 'label_too_long'
  | 'note_too_long'
  | 'no_yield'
  | 'yield_too_large'
  | 'no_items'
  | 'too_many_items'
  | 'item_name_too_long';

export type RecipeDraft = {
  name: string;
  brand: string;
  serving_label: string;
  yield_servings: number;
  items: RecipeItem[];
};

/**
 * The first thing stopping this draft being saved, or null.
 *
 * Returns a REASON rather than a boolean, so the screen can say which control
 * to touch. A bare `canSave` would leave the athlete with a dead button and no
 * account of why — the shape of failure this codebase keeps finding.
 *
 * Every one of these is also enforced by the server, and that is deliberate
 * rather than duplicated effort: this is what makes the phone able to refuse a
 * draft while OFFLINE, where the server's answer is not available. A draft that
 * passes here and fails there would sit in the outbox as a permanent rejection.
 */
export function recipeProblem(draft: RecipeDraft): RecipeProblem | null {
  if (!draft.name.trim()) return 'no_name';
  if (runes(draft.name) > MAX_NAME_RUNES) return 'name_too_long';
  if (!draft.serving_label.trim()) return 'no_serving_label';
  if (runes(draft.serving_label) > MAX_LABEL_RUNES) return 'label_too_long';
  // The note is stored as `brand`, and the server caps that at 80. A field
  // labelled "Note" with placeholder "Optional" invites prose, so this is the
  // limit most likely to be met by somebody writing normally.
  if (bytes(draft.brand) > MAX_BRAND_BYTES) return 'note_too_long';
  if (!(draft.yield_servings > 0)) return 'no_yield';
  if (draft.yield_servings >= MAX_YIELD) return 'yield_too_large';
  if (draft.items.length === 0) return 'no_items';
  if (draft.items.length > MAX_ITEMS) return 'too_many_items';
  // Defensive: `clampName` means an ingredient added through this app cannot be
  // too long. A recipe PULLED from the server, or one written by an older
  // build, can be — and re-saving it would strand the whole recipe.
  if (draft.items.some((i) => runes(i.name) > MAX_NAME_RUNES)) return 'item_name_too_long';
  return null;
}

/** What to tell the athlete about each problem. */
export function problemMessage(problem: RecipeProblem): string {
  switch (problem) {
    case 'no_name':
      return 'Give the recipe a name.';
    case 'name_too_long':
      return `Shorten the name — ${MAX_NAME_RUNES} characters at most.`;
    case 'label_too_long':
      return `Shorten what one portion is — ${MAX_LABEL_RUNES} characters at most.`;
    case 'note_too_long':
      return 'Shorten the note — it is a label, not a method.';
    case 'yield_too_large':
      // Distinct from `no_yield` on purpose: "say how many portions this makes"
      // is the wrong sentence for somebody who said, and said 5000.
      return `That is a lot of portions — fewer than ${MAX_YIELD}, please.`;
    case 'item_name_too_long':
      return 'One ingredient has a name too long to save. Remove it and add it again.';
    case 'no_serving_label':
      return 'Say what one portion is — "1 bowl", "1 portion".';
    case 'no_yield':
      return 'Say how many portions this makes.';
    case 'no_items':
      // Deliberately not "add an ingredient" alone: a recipe with nothing in it
      // would save as 0 kcal per portion, which is a confident claim about a
      // meal rather than an empty form.
      return 'Add at least one ingredient — a recipe with none would log as nothing.';
    case 'too_many_items':
      return `A recipe can hold ${MAX_ITEMS} ingredients.`;
  }
}

/**
 * The draft as a food to store.
 *
 * The macros are `perServing`'s answer, sent so the row is usable on this phone
 * the instant it is saved and before any sync happens. The server recomputes
 * them from the items and overwrites — which is why a mismatch here is a
 * cosmetic bug for one round trip rather than a wrong number forever.
 */
export function draftToFood(draft: RecipeDraft): Omit<Food, 'id'> {
  return {
    kind: 'recipe',
    name: draft.name.trim(),
    brand: draft.brand.trim(),
    serving_label: draft.serving_label.trim(),
    // A portion of a recipe has no honest gram weight — the athlete said how
    // many portions it makes, not what one weighs — and inventing one would
    // make every gram-based total quietly fictional.
    serving_grams: null,
    ...perServing(draft.items, draft.yield_servings),
    yield_servings: draft.yield_servings,
    items: draft.items,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
