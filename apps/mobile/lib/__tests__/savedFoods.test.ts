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
import { ApiError } from '../apiError';
import {
  localEntries,
  localFood,
  localFoods,
  logFood,
  recentsFor,
  saveFoodLocally,
  syncFood,
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

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const token = async () => 'tok';

beforeEach(async () => {
  mockUuidSeq = 0;
  mockFixture = await migratedFixture();
  mockApi.mockReset().mockResolvedValue({});
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
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
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
      saturated_fat_g: before.saturated_fat_g,
      sugar_g: before.sugar_g,
      added_sugar_g: before.added_sugar_g,
      sodium_mg: before.sodium_mg,
      cholesterol_mg: before.cholesterol_mg,
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
      saturated_fat_g: null,
      sugar_g: null,
      added_sugar_g: null,
      sodium_mg: null,
      cholesterol_mg: null,
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
      saturated_fat_g: item.saturated_fat_g,
      sugar_g: item.sugar_g,
      added_sugar_g: item.added_sugar_g,
      sodium_mg: item.sodium_mg,
      cholesterol_mg: item.cholesterol_mg,
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
      saturated_fat_g: item.saturated_fat_g,
      sugar_g: item.sugar_g,
      added_sugar_g: item.added_sugar_g,
      sodium_mg: item.sodium_mg,
      cholesterol_mg: item.cholesterol_mg,
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

describe('pushing a drafted food and the entry that names it', () => {
  /**
   * **THE ORDERING THIS FEATURE DEPENDS ON, AND IT IS NOT A STYLE POINT.**
   *
   * `nutrition_entries` has a composite foreign key
   * `(user_id, source_food_id) -> nutrition_foods (user_id, id)`. Before N114
   * every entry the phone pushed carried `source_food_id: null` for a drafted
   * meal, so the order of the two outbox queues could not matter. It does now:
   * the entry names a food the server has never seen.
   *
   * And the failure is PERMANENT, not a retry. The server maps a 23503 to
   * `invalid_input` and answers 400; `classify` reads a 400 as a permanent
   * rejection and clears `dirty`, on the correct general reasoning that a 4xx
   * will not become a 2xx. So the entry is dropped from the outbox, the lunch
   * lives only on the phone, and nothing anywhere says so.
   */
  it('sends the food BEFORE the entry that references it', async () => {
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
      saturated_fat_g: item.saturated_fat_g,
      sugar_g: item.sugar_g,
      added_sugar_g: item.added_sugar_g,
      sodium_mg: item.sodium_mg,
      cholesterol_mg: item.cholesterol_mg,
      source_food_id: foodId,
    });

    await syncFood(USER, token);

    const paths = mockApi.mock.calls.map((c) => String(c[1]));
    const foodAt = paths.findIndex((u) => u.startsWith('/nutrition/foods/'));
    const entryAt = paths.findIndex((u) => u.startsWith('/nutrition/entries/'));
    expect(foodAt).toBeGreaterThanOrEqual(0);
    expect(entryAt).toBeGreaterThanOrEqual(0);
    expect(foodAt).toBeLessThan(entryAt);
  });

  /**
   * The same thing asserted through the CONSEQUENCE rather than through the
   * call order, because the order is a proxy and this is the thing that is
   * actually lost. A server that refuses an entry naming an unknown food must
   * never be reached at all — and if it is, the entry must not be silently
   * dropped from the outbox.
   */
  it('does not lose the entry to a server that has not heard of the food yet', async () => {
    const seen = new Set<string>();
    mockApi.mockImplementation(async (_t: unknown, url: string, init?: { method?: string }) => {
      if (url.startsWith('/nutrition/foods/') && init?.method === 'PUT') {
        seen.add(url.slice('/nutrition/foods/'.length));
        return {};
      }
      if (url.startsWith('/nutrition/entries/')) {
        // Exactly what the backend answers for a 23503 on this FK.
        if (!seen.has(String(lastSourceFoodId))) {
          throw new ApiError(
            'source_food_id does not name a saved food',
            'invalid_input',
            400,
          );
        }
        return {};
      }
      return { foods: [], entries: [] };
    });

    const item = draftItem();
    const foodId = await saveFoodLocally(USER, savedFoodFrom(item));
    lastSourceFoodId = foodId;
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
      saturated_fat_g: item.saturated_fat_g,
      sugar_g: item.sugar_g,
      added_sugar_g: item.added_sugar_g,
      sodium_mg: item.sodium_mg,
      cholesterol_mg: item.cholesterol_mg,
      source_food_id: foodId,
    });

    const result = await syncFood(USER, token);
    expect(result.failed).toBe(0);
    expect(result.error).toBeUndefined();
  });
});

let lastSourceFoodId: string | null = null;
