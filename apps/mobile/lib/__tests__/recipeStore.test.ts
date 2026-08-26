/**
 * N87 — a recipe survives the phone's own storage and its own push.
 *
 * Written BEFORE the code it guards, because the omission this file is about
 * has shipped three times in this repo already: a write path that lists its
 * columns by hand and silently drops the one that was just added. `foods` has
 * five such lists — `saveFoodLocally`'s upsert, `localFoods`, `localFood`,
 * `cacheFoods`'s pull upsert, and `push`'s SELECT-plus-payload — and a recipe
 * that loses its `items` on any one of them reads as an empty recipe rather
 * than as a bug.
 *
 * These run against a REAL SQLite database through `migratedFixture()`, which
 * executes the app's own `migrate()`. A regex over the query text would prove a
 * column is named and say nothing about whether the round trip keeps its value.
 */

import { ApiError } from '../apiError';
import {
  localFood,
  localFoods,
  saveFoodLocally,
  syncFood,
} from '../foodLog';
import type { RecipeItem } from '../nutrition';
import { migratedFixture, type FixtureDb } from './support/sqlite';

const USER = 'cook';

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

function chicken(): RecipeItem {
  return {
    name: 'Chicken breast',
    quantity: 1,
    serving_label: '600 g',
    kcal: 990,
    protein_g: 186,
    carb_g: 0,
    fat_g: 21.6,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source_food_id: null,
  };
}

function rice(): RecipeItem {
  return {
    name: 'Basmati rice, dry',
    quantity: 2,
    serving_label: '100 g',
    kcal: 356,
    protein_g: 8.1,
    carb_g: 79,
    fat_g: 0.9,
    fibre_g: 1.4,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source_food_id: null,
  };
}

/** A recipe as the editor would hand it to the store: four portions of two. */
function traybake(over: Partial<Parameters<typeof saveFoodLocally>[1]> = {}) {
  return {
    kind: 'recipe' as const,
    name: 'Chicken and rice traybake',
    brand: '',
    serving_label: '1 portion',
    serving_grams: null,
    // Per portion, as the server would derive it: (990 + 712) / 4 etc.
    kcal: 425.5,
    protein_g: 50.6,
    carb_g: 39.5,
    fat_g: 5.85,
    fibre_g: 0.7,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    yield_servings: 4,
    items: [chicken(), rice()],
    ...over,
  };
}

describe('a recipe survives local storage', () => {
  it('reads back the ingredients it was saved with', async () => {
    const id = await saveFoodLocally(USER, traybake());

    const back = await localFood(USER, id);
    expect(back?.kind).toBe('recipe');
    expect(back?.yield_servings).toBe(4);
    expect(back?.items).toEqual([chicken(), rice()]);
  });

  /**
   * The ORDER of a recipe's items is data, not presentation: the server keys
   * them on `(food_id, position)` and renders them back in that order, so a
   * store that round-trips the set but not the sequence reorders somebody's
   * method every time they open it. An assertion on `toEqual` of a two-item
   * array would pass under a store that sorted alphabetically — 'Basmati'
   * sorts before 'Chicken' — so this uses items whose stored order is the one
   * a sort would change.
   */
  it('keeps the ingredients in the order they were entered', async () => {
    const id = await saveFoodLocally(USER, traybake());
    const back = await localFood(USER, id);
    expect(back?.items.map((i) => i.name)).toEqual([
      'Chicken breast',
      'Basmati rice, dry',
    ]);
  });

  it('lists a recipe with its ingredients, not just its totals', async () => {
    await saveFoodLocally(USER, traybake());
    const [only] = await localFoods(USER);
    expect(only.items).toHaveLength(2);
    expect(only.yield_servings).toBe(4);
  });

  /**
   * The empty-vs-unknown collapse, at the storage layer. A plain food has no
   * ingredients and that is a FACT about it, not a gap — so it must read back
   * as an empty list and a null yield, never as undefined, or every consumer
   * has to decide for itself what silence meant.
   */
  it('gives a plain food an empty item list and no yield', async () => {
    const id = await saveFoodLocally(USER, {
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
    });
    const back = await localFood(USER, id);
    expect(back?.items).toEqual([]);
    expect(back?.yield_servings).toBeNull();
  });

  /**
   * Editing a recipe REPLACES its ingredient list, exactly as the server's own
   * `DELETE … INSERT` does. A store that merged instead would leave a removed
   * ingredient in the pot forever, and the athlete would have no way to take
   * anything out of a recipe.
   */
  it('replaces the ingredient list on an edit rather than merging into it', async () => {
    const id = await saveFoodLocally(USER, traybake());
    await saveFoodLocally(USER, traybake({ id, items: [rice()] }));

    const back = await localFood(USER, id);
    expect(back?.items.map((i) => i.name)).toEqual(['Basmati rice, dry']);
  });
});

describe('a recipe survives the push to the server', () => {
  /**
   * The load-bearing one. `PUT /v1/nutrition/foods/{id}` derives a recipe's
   * per-serving macros from `items ÷ yield_servings` and replaces its items
   * WHOLESALE — so a payload that omits `items` does not leave them alone, it
   * empties them. And a payload that omits `yield_servings` while claiming
   * `kind: "recipe"` fails the server's biconditional and is a PERMANENT 400,
   * which strands the row in the outbox forever.
   */
  it('sends the ingredients and the yield, not just the totals', async () => {
    await saveFoodLocally(USER, traybake());
    await syncFood(USER, token);

    const put = mockApi.mock.calls.find(
      (c) => String(c[1]).startsWith('/nutrition/foods/'),
    );
    expect(put).toBeDefined();
    const body = JSON.parse(String((put![2] as { body: string }).body));

    expect(body.kind).toBe('recipe');
    expect(body.yield_servings).toBe(4);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      name: 'Chicken breast',
      quantity: 1,
      serving_label: '600 g',
      kcal: 990,
    });
  });

  /**
   * The consequence rather than the payload, because the payload is a proxy.
   * This stubs the server's ACTUAL validation — `(kind == recipe) !=
   * (yield_servings != nil)` is a 400 in `Food.Validate()` — so a client that
   * stops sending the yield fails here even if somebody also changes what this
   * file asserts about the body above.
   */
  it('is not rejected by the server rule that a recipe needs a yield', async () => {
    // Stores what it accepts and lists it back, so the pull that follows the
    // push sees the row the server really has. A stub that answered the listing
    // with nothing would delete the freshly-pushed row as "dropped on the
    // server" — correct behaviour, and it would look exactly like the rejection
    // this test is about.
    const stored: Record<string, unknown> = {};
    mockApi.mockImplementation(async (_t: unknown, url: string, init?: { body?: string }) => {
      if (url.startsWith('/nutrition/foods/') && init?.body) {
        const id = url.slice('/nutrition/foods/'.length);
        const b = JSON.parse(init.body) as { kind?: string; yield_servings?: number | null };
        if ((b.kind === 'recipe') !== (b.yield_servings != null)) {
          throw new ApiError(
            'a recipe needs yield_servings (how many portions it makes) and a food must not have one',
            'invalid_input',
            400,
          );
        }
        stored[id] = { id, user_id: USER, source: 'user', ...b };
        return stored[id];
      }
      if (url.startsWith('/nutrition/foods')) return { foods: Object.values(stored) };
      return {};
    });

    await saveFoodLocally(USER, traybake());
    const result = await syncFood(USER, token);

    expect(result.failed).toBe(0);
    expect(result.errorKind).toBeUndefined();
    // A permanent rejection clears `dirty` and leaves a reason on the row; the
    // recipe would be gone from the server's side of the world with nothing
    // saying so.
    const [only] = await localFoods(USER);
    expect(only.items).toHaveLength(2);
  });

  /**
   * A plain food must NOT acquire a yield on its way out. The server refuses
   * `kind: "food"` carrying one with the same biconditional, so a push path
   * that defaults the yield to a number rather than to null would turn every
   * ordinary saved food into a permanent rejection — the widest possible blast
   * radius for a change that is supposed to be about recipes.
   */
  it('does not put a yield on a plain food', async () => {
    await saveFoodLocally(USER, {
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
    });
    await syncFood(USER, token);

    const put = mockApi.mock.calls.find(
      (c) => String(c[1]).startsWith('/nutrition/foods/'),
    );
    const body = JSON.parse(String((put![2] as { body: string }).body));
    expect(body.yield_servings ?? null).toBeNull();
    expect(body.items ?? []).toEqual([]);
  });
});
