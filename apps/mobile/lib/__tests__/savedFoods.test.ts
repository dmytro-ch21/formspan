/**
 * N114 — a food entered by AI or text is stored, so it can be reused.
 *
 * These run against a REAL SQLite database through `migratedFixture()`, which
 * executes the app's own `migrate()` — so the schema under test is the schema
 * that ships, and a claim about what a column does is checked rather than
 * asserted. A regex over a query string would prove a clause is present and say
 * nothing about whether SQLite honours it; both mistakes have shipped here.
 */

import { savedFoodFrom, type EstimatedItem } from '../estimateApi';
import {
  localEntries,
  localFood,
  localFoods,
  logFood,
  recentsFor,
  saveFoodLocally,
} from '../foodLog';
import { migratedFixture, type FixtureDb } from './support/sqlite';

const USER = 'eater';

// The same seam every other fixture test in this directory uses: `getDb` is
// pointed at a real, migrated SQLite database rather than at the native module
// jest-expo stubs out.
let mockFixture: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

beforeEach(async () => {
  mockUuidSeq = 0;
  mockFixture = await migratedFixture();
});

function draftItem(over: Partial<EstimatedItem> = {}): EstimatedItem {
  return {
    name: 'Pork Shashlik',
    serving_label: '1 skewer',
    servings: 2,
    kcal: 620,
    protein_g: 56,
    carb_g: 8,
    fat_g: 40,
    fibre_g: 3,
    portion_confidence: 'medium',
    assumption: 'assumed a large skewer',
    ...over,
  };
}

describe('savedFoodFrom', () => {
  // The unit inversion is the expensive mistake here: a saved food's macros are
  // PER SERVING and a draft's are the total for the quantity eaten. Storing the
  // total as the per-serving figure doubles every future log of it, silently.
  it('stores per serving, not the total that was eaten', () => {
    const f = savedFoodFrom(draftItem());
    expect(f.kcal).toBe(310);
    expect(f.protein_g).toBe(28);
    expect(f.carb_g).toBe(4);
    expect(f.fat_g).toBe(20);
    expect(f.fibre_g).toBe(1.5);
    expect(f.serving_label).toBe('1 skewer');
  });

  it('marks it as drafted rather than measured', () => {
    expect(savedFoodFrom(draftItem()).source).toBe('ai');
  });

  // Null is "the model did not state it", which is not a claim of zero grams.
  it('keeps an unstated fibre unstated', () => {
    expect(savedFoodFrom(draftItem({ fibre_g: null })).fibre_g).toBeNull();
  });

  // A zero servings would divide to Infinity and put it in the food store, and
  // from there into every entry ever logged from that food.
  it('never divides by zero servings', () => {
    const f = savedFoodFrom(draftItem({ servings: 0 }));
    expect(f.kcal).toBe(620);
    expect(Number.isFinite(f.kcal)).toBe(true);
  });

  // A serving stated in words has no honest gram weight, and inventing one
  // makes every gram-based total derived from this food fictional. #506 is
  // where a stated amount belongs.
  it('does not invent a gram weight for a serving stated in words', () => {
    expect(savedFoodFrom(draftItem()).serving_grams).toBeNull();
  });
});

describe('a food saved from a draft', () => {
  it('is stored, findable, and owed to the server', async () => {
    const id = await saveFoodLocally(USER, savedFoodFrom(draftItem()));

    const found = await localFood(USER, id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Pork Shashlik');
    expect(found!.source).toBe('ai');
    expect(found!.kcal).toBe(310);

    // It shows up in the athlete's own list, which is what the quick-add
    // search reads.
    const listed = await localFoods(USER, 'shashlik');
    expect(listed.map((f) => f.id)).toContain(id);
  });

  // THE RESTORE PATH, and it is the guard this repo has paid for three times on
  // `exercises.updateWithin`: a field a caller does not supply must not be
  // blanked by the write. Provenance is the one field here that nothing
  // downstream can reconstruct.
  it('keeps its provenance when the macros are corrected', async () => {
    const id = await saveFoodLocally(USER, savedFoodFrom(draftItem()));

    const before = (await localFood(USER, id))!;
    await saveFoodLocally(USER, {
      id,
      kind: before.kind,
      name: before.name,
      brand: before.brand,
      serving_label: before.serving_label,
      serving_grams: before.serving_grams,
      kcal: 415,
      protein_g: before.protein_g,
      carb_g: before.carb_g,
      fat_g: before.fat_g,
      fibre_g: before.fibre_g,
      // No `source` — exactly what the edit screen sends, and what every build
      // that predates N114 sends.
    });

    const after = (await localFood(USER, id))!;
    expect(after.kcal).toBe(415);
    expect(after.source).toBe('ai');
  });

  it('takes a stated provenance when one is given', async () => {
    const id = await saveFoodLocally(USER, { ...savedFoodFrom(draftItem()), source: 'user' });
    expect((await localFood(USER, id))!.source).toBe('user');
  });

  // A food typed by hand says nothing about source, and must not inherit `ai`
  // from a default written for the drafting path.
  it('is the athletes own when nothing says otherwise', async () => {
    const id = await saveFoodLocally(USER, {
      kind: 'food',
      name: 'Porridge',
      brand: '',
      serving_label: '60 g',
      serving_grams: 60,
      kcal: 220,
      protein_g: 7,
      carb_g: 40,
      fat_g: 4,
      fibre_g: 5,
    });
    expect((await localFood(USER, id))!.source).toBe('user');
  });

  it('is not another athletes to read', async () => {
    const id = await saveFoodLocally(USER, savedFoodFrom(draftItem()));
    expect(await localFood('someone-else', id)).toBeNull();
  });
});

describe('logging a drafted food against the row it was saved as', () => {
  // The consequence that is easy to miss: entries logged from a draft now carry
  // `source_food_id`, so a drafted meal reaches the quick-add recents — which
  // group entries by the food they name and were previously blind to every AI
  // log the app had ever made.
  it('puts it in the quick-add recents', async () => {
    const item = draftItem();
    const foodId = await saveFoodLocally(USER, savedFoodFrom(item));
    await logFood(USER, {
      eaten_on: '2026-08-18',
      meal: 'lunch',
      name: item.name,
      servings: item.servings,
      serving_label: item.serving_label,
      kcal: item.kcal,
      protein_g: item.protein_g,
      carb_g: item.carb_g,
      fat_g: item.fat_g,
      fibre_g: item.fibre_g,
      source_food_id: foodId,
    });

    const recents = await recentsFor(USER, 'lunch');
    expect(recents.map((r) => r.food.id)).toContain(foodId);
    expect(recents.find((r) => r.food.id === foodId)!.uses).toBe(1);
  });

  // The rule the whole nutrition module rests on, restated for the path N114
  // creates: correcting a saved food corrects what you log NEXT, never what you
  // already logged.
  it('leaves an entry alone when the food is corrected afterwards', async () => {
    const item = draftItem();
    const foodId = await saveFoodLocally(USER, savedFoodFrom(item));
    await logFood(USER, {
      eaten_on: '2026-08-18',
      meal: 'lunch',
      name: item.name,
      servings: item.servings,
      serving_label: item.serving_label,
      kcal: item.kcal,
      protein_g: item.protein_g,
      carb_g: item.carb_g,
      fat_g: item.fat_g,
      fibre_g: item.fibre_g,
      source_food_id: foodId,
    });

    await saveFoodLocally(USER, { ...savedFoodFrom(item), id: foodId, kcal: 999 });

    const recents = await recentsFor(USER, 'lunch');
    const row = recents.find((r) => r.food.id === foodId)!;
    // The FOOD moved…
    expect(row.food.kcal).toBe(999);
    // …and the entry did not. `recentsFor` reads the FOOD, so the entry has to
    // be read directly or this test would be checking the same row twice.
    const entries = await localEntries(USER, '2026-08-18');
    expect(entries[0].kcal).toBe(620);
  });
});
