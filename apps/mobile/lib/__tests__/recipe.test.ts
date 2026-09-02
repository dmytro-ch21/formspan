/**
 * N87 — the arithmetic and the refusals behind recipe authoring.
 *
 * Pure logic, no database and no rendering. The storage half is
 * `recipeStore.test.ts`; this file is about what a portion of a recipe
 * CONTAINS, and about which drafts the phone declines to save.
 */

import type { CatalogFood } from '../catalogApi';
import type { Entry, Food, RecipeItem } from '../nutrition';
import {
  MAX_BRAND_BYTES,
  MAX_ITEMS,
  MAX_LABEL_RUNES,
  MAX_NAME_RUNES,
  MAX_YIELD,
  clampName,
  draftToFood,
  entriesFromRecipeItems,
  itemFromCatalog,
  itemFromEntry,
  itemFromSavedFood,
  perServing,
  problemMessage,
  recipeProblem,
  type RecipeDraft,
} from '../recipe';

function item(over: Partial<RecipeItem> = {}): RecipeItem {
  return {
    name: 'Chicken breast',
    quantity: 1,
    serving_label: '100 g',
    kcal: 165,
    protein_g: 31,
    carb_g: 0,
    fat_g: 3.6,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source_food_id: null,
    ...over,
  };
}

describe('perServing', () => {
  it('divides the pot by how many portions it makes', () => {
    const per = perServing([item({ quantity: 4 })], 4);
    expect(per.kcal).toBe(165);
    expect(per.protein_g).toBe(31);
  });

  /**
   * Quantity is a MULTIPLIER on an ingredient's per-label macros, and getting
   * this backwards is the expensive mistake: dropping the `* it.quantity` still
   * produces a plausible number for every single-quantity recipe, which is most
   * of them. This vector uses a quantity that is neither 1 nor equal to the
   * yield, so neither omission survives it.
   */
  it('multiplies each ingredient by its quantity', () => {
    const per = perServing([item({ quantity: 3 })], 2);
    expect(per.kcal).toBeCloseTo(247.5);
  });

  it('adds the ingredients up rather than taking one of them', () => {
    const per = perServing(
      [item({ kcal: 100, protein_g: 10 }), item({ kcal: 40, protein_g: 2 })],
      1,
    );
    expect(per.kcal).toBe(140);
    expect(per.protein_g).toBe(12);
  });

  /**
   * The load-bearing one, and the whole reason `fibre_g` is nullable.
   *
   * A recipe whose ingredients never mention fibre is not a fibre-free recipe —
   * nobody said. Reporting 0 would be a claim the data does not support, and it
   * is the same empty-vs-unknown collapse that has shipped twice here in a day.
   */
  it('reports fibre as not stated when no ingredient stated it', () => {
    const per = perServing([item({ fibre_g: null }), item({ fibre_g: null })], 1);
    expect(per.fibre_g).toBeNull();
  });

  it('sums fibre when at least one ingredient states it', () => {
    const per = perServing([item({ fibre_g: 3 }), item({ fibre_g: null })], 2);
    expect(per.fibre_g).toBe(1.5);
  });

  /**
   * A partial fibre total reads as complete, and that is the honest best
   * available rather than an oversight — the same caveat the server's own
   * `PerServing` carries. Pinned so that "fix" is a deliberate act.
   */
  it('sums only the ingredients that stated fibre, not all of them', () => {
    const per = perServing([item({ fibre_g: 4 }), item({ fibre_g: null })], 1);
    expect(per.fibre_g).toBe(4);
  });

  /**
   * Mid-edit the yield field is empty, and `x / 0` is `Infinity`, which renders
   * as "Infinity kcal" on a screen the athlete is still typing into. A guard
   * whose outcome looks redundant still needs a test — without one, the next
   * reader deletes it because "the tests pass without it".
   */
  it('returns zeroes rather than infinity while the yield is empty', () => {
    const per = perServing([item()], 0);
    expect(per.kcal).toBe(0);
    expect(Number.isFinite(per.kcal)).toBe(true);
  });

  it('refuses a negative yield the same way', () => {
    expect(perServing([item()], -2).kcal).toBe(0);
  });

  it('is zero for a recipe with nothing in it, and says nothing about fibre', () => {
    const per = perServing([], 4);
    expect(per.kcal).toBe(0);
    expect(per.fibre_g).toBeNull();
  });

  // Each N52 label macro follows fibre's own rule independently — a recipe
  // where only one ingredient states sodium must not report a confident zero
  // for sugar just because sodium was found.
  it('sums each N52 label macro only from the ingredients that stated it', () => {
    const per = perServing(
      [item({ sodium_mg: 200 }), item({ sodium_mg: null, sugar_g: 4 })],
      2,
    );
    expect(per.sodium_mg).toBe(100);
    expect(per.sugar_g).toBe(2);
    expect(per.saturated_fat_g).toBeNull();
  });
});

const catalogFood: CatalogFood = {
    id: 'chicken-breast',
    name: 'Chicken breast, raw',
    brand: '',
    category: 'poultry',
    aliases: [],
    serving_label: '100 g',
    serving_grams: 100,
    natural_serving_label: null,
    natural_serving_grams: null,
    kcal: 165,
    protein_g: 31,
    carb_g: 0,
    fat_g: 3.6,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
  market: 'us',
  source: 'seed',
} as CatalogFood;

describe('an ingredient taken from the catalog', () => {
  it('records the weight that was picked, not a multiplier of 100 g', () => {
    const it = itemFromCatalog(catalogFood, 150);
    expect(it.serving_label).toBe('150 g');
    expect(it.quantity).toBe(1);
  });

  it('copies the macros for that weight, not the per-100 g figures', () => {
    const it = itemFromCatalog(catalogFood, 150);
    expect(it.kcal).toBeCloseTo(247.5);
    expect(it.protein_g).toBeCloseTo(46.5);
  });

  /**
   * `source_food_id` is a foreign key into the athlete's OWN saved foods, and a
   * catalog id is a slug in a different id space. Writing one here would dangle
   * — the same reason logging a catalog row records null. This is the guard
   * that is only exercised by the input it is meant to reject, so it gets its
   * own vector rather than riding along on the macro assertions.
   */
  it('does not claim a catalog slug as a saved-food reference', () => {
    expect(itemFromCatalog(catalogFood, 150).source_food_id).toBeNull();
  });

  it('names the brand alongside the food, so the list is readable later', () => {
    const branded = { ...catalogFood, brand: 'Lidl' };
    expect(itemFromCatalog(branded, 100).name).toBe('Lidl Chicken breast, raw');
  });
});

const savedFood: Food = {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'food',
    name: 'Skyr',
    brand: 'Arla',
    serving_label: '100 g',
    serving_grams: 100,
    kcal: 63,
    protein_g: 11,
    carb_g: 4,
    fat_g: 0.2,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
  yield_servings: null,
  items: [],
};

describe('an ingredient taken from a saved food', () => {
  const saved = savedFood;

  /**
   * The mirror of the catalog case, and the pair is the point: a saved food IS
   * in the id space the column references, so dropping the provenance here
   * would lose real information. Asserting only the null case would leave a
   * `source_food_id: null` hardcoded everywhere and passing.
   */
  it('keeps the provenance, because a saved food is in the right id space', () => {
    expect(itemFromSavedFood(saved, 2).source_food_id).toBe(saved.id);
  });

  it('keeps the food own serving label and quantity', () => {
    const it = itemFromSavedFood(saved, 2);
    expect(it.serving_label).toBe('100 g');
    expect(it.quantity).toBe(2);
    // Per-label macros, NOT multiplied here — `perServing` applies the
    // quantity. Multiplying in both places doubles it, which is the silent
    // version of this bug.
    expect(it.kcal).toBe(63);
  });
});

function draftWith(over: Partial<RecipeDraft> = {}): RecipeDraft {
  return {
    name: 'Traybake',
    brand: '',
    serving_label: '1 portion',
    yield_servings: 4,
    items: [item()],
    ...over,
  };
}

describe('what stops a draft being saved', () => {
  const draft = draftWith;

  it('accepts a complete draft', () => {
    expect(recipeProblem(draft())).toBeNull();
  });

  it('needs a name', () => {
    expect(recipeProblem(draft({ name: '   ' }))).toBe('no_name');
  });

  it('needs to know what one portion is', () => {
    expect(recipeProblem(draft({ serving_label: '' }))).toBe('no_serving_label');
  });

  it('needs a yield above zero', () => {
    expect(recipeProblem(draft({ yield_servings: 0 }))).toBe('no_yield');
  });

  it('refuses a yield the server would refuse', () => {
    // `yield_too_large`, not `no_yield`: the athlete DID say how many portions,
    // so "say how many portions this makes" would be the wrong sentence.
    expect(recipeProblem(draft({ yield_servings: 1000 }))).toBe('yield_too_large');
  });

  /**
   * A recipe with no ingredients derives to 0 kcal per portion and saves
   * perfectly happily — so the athlete would get a saved "meal" that logs as
   * nothing at all. That is an empty answer wearing the clothes of a real one,
   * and it is the reason this is a refusal rather than a warning.
   */
  it('refuses a recipe with nothing in it', () => {
    expect(recipeProblem(draft({ items: [] }))).toBe('no_items');
  });

  it('refuses more ingredients than the server accepts', () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, () => item());
    expect(recipeProblem(draft({ items: many }))).toBe('too_many_items');
  });

  it('accepts exactly the server maximum', () => {
    const many = Array.from({ length: MAX_ITEMS }, () => item());
    expect(recipeProblem(draft({ items: many }))).toBeNull();
  });

  it('has a distinct sentence for every problem it can report', () => {
    const problems = [
      'no_name', 'no_serving_label', 'no_yield', 'no_items', 'too_many_items',
    ] as const;
    const messages = problems.map(problemMessage);
    // A shared message would leave the athlete told to fix a control they had
    // already filled in.
    expect(new Set(messages).size).toBe(problems.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(0);
  });
});

describe('draftToFood', () => {
  const base: RecipeDraft = {
    name: '  Traybake  ',
    brand: ' notes ',
    serving_label: ' 1 bowl ',
    yield_servings: 2,
    items: [item({ quantity: 2 })],
  };

  it('marks it as a recipe and keeps the yield', () => {
    const f = draftToFood(base);
    expect(f.kind).toBe('recipe');
    expect(f.yield_servings).toBe(2);
  });

  it('carries the ingredients, which is what the server derives from', () => {
    expect(draftToFood(base).items).toHaveLength(1);
  });

  it('stores the per-portion macros, not the whole pot', () => {
    // 165 kcal x 2 quantity / 2 portions.
    expect(draftToFood(base).kcal).toBe(165);
  });

  it('trims what the athlete typed', () => {
    const f = draftToFood(base);
    expect(f.name).toBe('Traybake');
    expect(f.serving_label).toBe('1 bowl');
  });

  /**
   * A portion of a recipe has no honest gram weight — the athlete said how many
   * portions it makes, never what one weighs. Inventing 100 here would make it
   * loggable by weight and every gram-based total quietly fictional.
   */
  it('claims no gram weight for a portion', () => {
    expect(draftToFood(base).serving_grams).toBeNull();
  });
});

describe('the server length limits, mirrored so a recipe is never stranded', () => {
  /**
   * **Not hypothetical: 72 of the catalog's 12,651 foods have names over 120
   * runes, the longest 184.** This is one of them, verbatim. Copying it into an
   * ingredient produced a recipe that passed every client check and then 400-ed
   * permanently on push — `dirty` cleared, recipe lost, nothing saying so.
   *
   * The guard is only exercised by the input it is meant to reject, so the
   * vector has to be a real over-length name rather than a short one.
   */
  const REAL_LONG_NAME =
    'Chicken or turkey, breaded, fried, garden salad with bacon and cheese, chicken and/or turkey, '
    + 'tomato and/or carrots, other vegetables, dressing';

  it('the fixture is actually over the limit', () => {
    // Guards the guard: a vector that quietly came in under 120 would make
    // every assertion below pass while testing nothing.
    expect(Array.from(REAL_LONG_NAME).length).toBeGreaterThan(MAX_NAME_RUNES);
  });

  it('clamps a catalog name the server would refuse', () => {
    const it_ = itemFromCatalog({ ...catalogFood, name: REAL_LONG_NAME }, 100);
    expect(Array.from(it_.name).length).toBeLessThanOrEqual(MAX_NAME_RUNES);
  });

  it('marks a clamped name as clipped rather than passing it off as the food', () => {
    const it_ = itemFromCatalog({ ...catalogFood, name: REAL_LONG_NAME }, 100);
    expect(it_.name.endsWith('…')).toBe(true);
  });

  it('leaves a name that fits exactly alone', () => {
    const exact = 'x'.repeat(MAX_NAME_RUNES);
    expect(clampName(exact)).toBe(exact);
    expect(clampName(exact).endsWith('…')).toBe(false);
  });

  it('clamps the brand-plus-name join too, not just the name', () => {
    // 80-char brand + 120-char name is legal on each field and 201 joined.
    const it_ = itemFromCatalog(
      { ...catalogFood, brand: 'B'.repeat(80), name: 'N'.repeat(MAX_NAME_RUNES) },
      100,
    );
    expect(Array.from(it_.name).length).toBeLessThanOrEqual(MAX_NAME_RUNES);
  });

  it('clamps a saved food the same way', () => {
    const long = { ...savedFood, name: REAL_LONG_NAME };
    expect(Array.from(itemFromSavedFood(long, 1).name).length)
      .toBeLessThanOrEqual(MAX_NAME_RUNES);
  });

  it('refuses a recipe name over the limit', () => {
    expect(recipeProblem(draftWith({ name: 'x'.repeat(MAX_NAME_RUNES + 1) }))).toBe('name_too_long');
  });

  it('refuses a portion label over the limit', () => {
    expect(recipeProblem(draftWith({ serving_label: 'x'.repeat(MAX_LABEL_RUNES + 1) })))
      .toBe('label_too_long');
  });

  /**
   * The note is stored as `brand`, which the server caps in **bytes**
   * (`len(f.Brand)`), not runes. A rune-based check here would pass a note of
   * 80 accented characters that the server refuses at 160 bytes.
   */
  it('counts the note in bytes, as the server does', () => {
    const asciiFits = 'a'.repeat(MAX_BRAND_BYTES);
    expect(recipeProblem(draftWith({ brand: asciiFits }))).toBeNull();

    // Same rune count, twice the bytes.
    const accented = 'é'.repeat(MAX_BRAND_BYTES);
    expect(recipeProblem(draftWith({ brand: accented }))).toBe('note_too_long');
  });

  /**
   * A recipe pulled from the server, or written by an older build, can carry an
   * item name this build would have clamped. Re-saving it must be refused with
   * a reason rather than stranding the whole recipe on push.
   */
  it('refuses an ingredient name that arrived over the limit from elsewhere', () => {
    const bad = item({ name: 'x'.repeat(MAX_NAME_RUNES + 1) });
    expect(recipeProblem(draftWith({ items: [bad] }))).toBe('item_name_too_long');
  });

  /**
   * A stated-but-too-large yield is not the same problem as an empty one, and
   * "say how many portions this makes" is the wrong sentence for somebody who
   * said, and said 5000.
   */
  it('separates a yield that is too big from one that is missing', () => {
    expect(recipeProblem(draftWith({ yield_servings: 0 }))).toBe('no_yield');
    expect(recipeProblem(draftWith({ yield_servings: MAX_YIELD }))).toBe('yield_too_large');
  });
});

/**
 * N115 — "I had a shake so I added milk, protein, berries, ice cream — we
 * should be able to squash them all in one." `itemFromEntry` is the ONE
 * direction of that squash: a `RecipeItem` copied from an entry already
 * logged. `entriesFromRecipeItems` below is the other direction.
 */
function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    eaten_on: '2026-09-01',
    meal: 'breakfast',
    name: 'Whole milk',
    servings: 1,
    serving_label: '250 ml',
    kcal: 150,
    protein_g: 8,
    carb_g: 12,
    fat_g: 8,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source_food_id: null,
    category: null,
    notes: '',
    ...over,
  };
}

describe('an ingredient taken from an entry already logged (N115)', () => {
  /**
   * The load-bearing property: an entry's macros are already the ABSOLUTE
   * total for what was logged (`Entry`'s own doc comment), so this must copy
   * them straight across rather than deriving a per-serving figure and
   * remultiplying — the exact division-then-multiplication `rescale`'s own
   * doc comment warns compounds rounding. A mutant that divided by
   * `entry.servings` before storing would still pass every OTHER assertion in
   * this block (all of them use `servings: 1`, where dividing by 1 is a
   * no-op) — this is the one vector where it matters.
   */
  it('copies the absolute macros unchanged, not a re-derived per-serving figure', () => {
    const it_ = itemFromEntry(entry({ servings: 2.5, kcal: 375, protein_g: 20 }));
    expect(it_.kcal).toBe(375);
    expect(it_.protein_g).toBe(20);
    expect(it_.quantity).toBe(1);
  });

  it('keeps the plain serving label when the entry was exactly one serving', () => {
    expect(itemFromEntry(entry({ servings: 1, serving_label: '250 ml' })).serving_label).toBe(
      '250 ml',
    );
  });

  it('states the quantity actually eaten when it was not one serving', () => {
    expect(itemFromEntry(entry({ servings: 1.5, serving_label: '100 g' })).serving_label).toBe(
      '1.5 × 100 g',
    );
  });

  it('carries the provenance through, the same as a saved food does', () => {
    const withSource = entry({ source_food_id: '33333333-3333-4333-8333-333333333333' });
    expect(itemFromEntry(withSource).source_food_id).toBe(withSource.source_food_id);
  });

  it('preserves a null N52 macro rather than defaulting it to zero', () => {
    expect(itemFromEntry(entry({ sodium_mg: null })).sodium_mg).toBeNull();
  });

  it('clamps a name over the server limit, the same as every other item source', () => {
    const long = entry({ name: 'x'.repeat(MAX_NAME_RUNES + 1) });
    expect(Array.from(itemFromEntry(long).name).length).toBeLessThanOrEqual(MAX_NAME_RUNES);
  });

  /**
   * The arithmetic AC, pinned directly: build a shake from four entries the
   * way `combine.tsx` does, and the recipe's one-serving total must equal
   * exactly what the four entries summed to — "a total that cannot be checked
   * against its components is the failure this repo keeps naming."
   */
  it('sums back to exactly what the entries totalled, at one serving', () => {
    const milk = entry({ name: 'Milk', kcal: 150, protein_g: 8, carb_g: 12, fat_g: 8 });
    const protein = entry({ name: 'Protein powder', kcal: 120, protein_g: 24, carb_g: 3, fat_g: 1 });
    const berries = entry({ name: 'Berries', kcal: 40, protein_g: 1, carb_g: 10, fat_g: 0 });
    const iceCream = entry({ name: 'Ice cream', kcal: 200, protein_g: 3, carb_g: 24, fat_g: 10 });
    const items = [milk, protein, berries, iceCream].map(itemFromEntry);
    const shake = draftToFood({
      name: 'Shake',
      brand: '',
      serving_label: '1 serving',
      yield_servings: 1,
      items,
    });
    expect(shake.kcal).toBe(150 + 120 + 40 + 200);
    expect(shake.protein_g).toBe(8 + 24 + 1 + 3);
    expect(shake.carb_g).toBe(12 + 3 + 10 + 24);
    expect(shake.fat_g).toBe(8 + 1 + 0 + 10);
  });
});

function recipeFood(items: RecipeItem[]): Food {
  return { ...savedFood, id: 'shake', kind: 'recipe', name: 'Shake', yield_servings: 1, items };
}

describe('entries rebuilt from a recipe (N115 — "opened back into its parts")', () => {
  it('makes one entry per item, at the item\'s own quantity and label', () => {
    const food = recipeFood([item({ name: 'Milk', quantity: 1, serving_label: '250 ml', kcal: 150 })]);
    const rows = entriesFromRecipeItems(food, 'breakfast', '2026-09-02');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Milk');
    expect(rows[0].servings).toBe(1);
    expect(rows[0].serving_label).toBe('250 ml');
    expect(rows[0].meal).toBe('breakfast');
    expect(rows[0].eaten_on).toBe('2026-09-02');
  });

  /**
   * The other half of the round trip: an item's contribution is
   * `kcal × quantity` (its own doc comment), so a decomposed row must carry
   * that full contribution, not the bare per-label figure. A mutant that
   * dropped `* it.quantity` would still pass every vector above with
   * `quantity: 1` — this is the one that catches it.
   */
  it('multiplies by quantity, not just by 1', () => {
    const food = recipeFood([item({ kcal: 100, protein_g: 10, quantity: 3 })]);
    const [row] = entriesFromRecipeItems(food, 'lunch', '2026-09-02');
    expect(row.kcal).toBe(300);
    expect(row.protein_g).toBe(30);
  });

  it('keeps a null N52 macro null rather than a multiplied zero', () => {
    const food = recipeFood([item({ sodium_mg: null, quantity: 2 })]);
    expect(entriesFromRecipeItems(food, 'lunch', '2026-09-02')[0].sodium_mg).toBeNull();
  });

  it('carries an item\'s provenance to the entry it becomes', () => {
    const food = recipeFood([item({ source_food_id: '44444444-4444-4444-8444-444444444444' })]);
    expect(entriesFromRecipeItems(food, 'lunch', '2026-09-02')[0].source_food_id).toBe(
      '44444444-4444-4444-8444-444444444444',
    );
  });

  it('round-trips a combined shake back to its original per-item totals', () => {
    const milk = entry({ name: 'Milk', kcal: 150, protein_g: 8 });
    const protein = entry({ name: 'Protein powder', kcal: 120, protein_g: 24 });
    const items = [milk, protein].map(itemFromEntry);
    const food = recipeFood(items);
    const rows = entriesFromRecipeItems(food, 'breakfast', '2026-09-02');
    expect(rows.map((r) => r.kcal)).toEqual([150, 120]);
    expect(rows.map((r) => r.protein_g)).toEqual([8, 24]);
    // And the total is unchanged by the round trip — nothing was invented or
    // dropped going item -> entry -> item -> entry.
    const total = rows.reduce((sum, r) => sum + r.kcal, 0);
    expect(total).toBe(milk.kcal + protein.kcal);
  });
});
