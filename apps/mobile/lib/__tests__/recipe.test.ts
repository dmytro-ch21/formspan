/**
 * N87 — the arithmetic and the refusals behind recipe authoring.
 *
 * Pure logic, no database and no rendering. The storage half is
 * `recipeStore.test.ts`; this file is about what a portion of a recipe
 * CONTAINS, and about which drafts the phone declines to save.
 */

import type { CatalogFood } from '../catalogApi';
import type { Food, RecipeItem } from '../nutrition';
import {
  MAX_ITEMS,
  draftToFood,
  itemFromCatalog,
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
});

describe('an ingredient taken from the catalog', () => {
  const catalogFood: CatalogFood = {
    id: 'chicken-breast',
    name: 'Chicken breast, raw',
    brand: '',
    category: 'poultry',
    aliases: [],
    serving_label: '100 g',
    serving_grams: 100,
    kcal: 165,
    protein_g: 31,
    carb_g: 0,
    fat_g: 3.6,
    fibre_g: null,
    market: 'us',
    source: 'seed',
  } as CatalogFood;

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

describe('an ingredient taken from a saved food', () => {
  const saved: Food = {
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
    yield_servings: null,
    items: [],
  };

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

describe('what stops a draft being saved', () => {
  function draft(over: Partial<RecipeDraft> = {}): RecipeDraft {
    return {
      name: 'Traybake',
      brand: '',
      serving_label: '1 portion',
      yield_servings: 4,
      items: [item()],
      ...over,
    };
  }

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
    expect(recipeProblem(draft({ yield_servings: 1000 }))).toBe('no_yield');
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
