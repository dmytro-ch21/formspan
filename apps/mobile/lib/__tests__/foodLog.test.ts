/**
 * The food outbox, against a real SQLite database.
 *
 * SQL behaviour belongs in a fixture test, never a regex over the query string:
 * a text assertion proves a clause is present, not that SQLite honours it, and
 * an array mock can silently SUPPLY the behaviour under test. Both mistakes
 * shipped here before `support/sqlite.ts` existed.
 *
 * What is deliberately NOT tested here: the arithmetic (that is
 * `nutrition.test.ts`) and the migration shape (that is `schema.test.ts`). A
 * second opinion about either in this file is how two tests end up disagreeing
 * about one rule.
 */

import { ApiError, OfflineError } from '../apiError';
import {
  cacheEntries,
  editEntry,
  cacheTargets,
  localEntries,
  localLoggedDayKcal,
  localLoggedDays,
  localEntry,
  localFoods,
  localTargetView,
  logFood,
  pendingFoodCount,
  recentsFor,
  removeEntry,
  saveFoodLocally,
  syncFood,
} from '../foodLog';
import type { Food, Target } from '../nutrition';
import { migratedFixture, type FixtureDb } from './support/sqlite';

let db: FixtureDb;
let mockFixture: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({
  apiRequest: (...a: unknown[]) => mockApi(...a),
}));

const USER = 'u1';

function aTarget(over: Partial<Target> = {}): Target {
  return {
    effective_on: TODAY,
    kcal: 2400,
    protein_g: 180,
    carb_g: 240,
    fat_g: 80,
    fibre_g: 34,
    ...over,
  };
}
const TODAY = '2026-08-18';
const token = async () => 'tok';

function meal(over: Partial<Parameters<typeof logFood>[1]> = {}) {
  return {
    eaten_on: TODAY,
    meal: 'lunch' as const,
    name: 'Chicken thigh',
    servings: 1,
    serving_label: '100 g',
    kcal: 180,
    protein_g: 25,
    carb_g: 0,
    fat_g: 8,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    ...over,
  };
}

async function row(id: string) {
  return db.getFirstAsync<{
    dirty: number;
    remote: number;
    deleted_at: string | null;
    last_error: string | null;
    updated_at: string;
    kcal: number;
  }>(
    `SELECT dirty, remote, deleted_at, last_error, updated_at, kcal
       FROM food_entries WHERE id = ?`,
    id,
  );
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockUuidSeq = 0;
  mockApi.mockReset().mockResolvedValue({});
});

describe('logging', () => {
  it('writes locally and owes a push, without touching the network', async () => {
    const id = await logFood(USER, meal());
    expect(mockApi).not.toHaveBeenCalled();

    const r = await row(id);
    expect(r).toMatchObject({ dirty: 1, remote: 0, deleted_at: null });
    expect(await localEntries(USER, TODAY)).toHaveLength(1);
  });

  it('reads back the day with no network at all', async () => {
    await logFood(USER, meal());
    await logFood(USER, meal({ name: 'Rice', kcal: 300 }));
    const day = await localEntries(USER, TODAY);
    expect(day.map((e) => e.name)).toEqual(['Chicken thigh', 'Rice']);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('does not leak another day into the day being read', async () => {
    await logFood(USER, meal());
    await logFood(USER, meal({ eaten_on: '2026-08-17' }));
    expect(await localEntries(USER, TODAY)).toHaveLength(1);
  });

  it('is scoped to the athlete', async () => {
    await logFood(USER, meal());
    await logFood('u2', meal({ name: 'Theirs' }));
    const mine = await localEntries(USER, TODAY);
    expect(mine.map((e) => e.name)).toEqual(['Chicken thigh']);
  });
});

describe('reading one entry', () => {
  it('returns the row the editor was opened on', async () => {
    const id = await logFood(USER, meal());
    const e = await localEntry(USER, id);
    expect(e?.name).toBe('Chicken thigh');
  });

  it('will not hand another athlete their row, even knowing the id', async () => {
    // The id is generated on THIS device and travels through sync, so treating
    // it as a capability would make a signed-out athlete's leftover rows
    // readable by whoever signs in next on the same phone.
    const id = await logFood('u2', meal({ name: 'Theirs' }));
    expect(await localEntry(USER, id)).toBeNull();
  });

  it('is gone once tombstoned, so the editor says so rather than editing a ghost', async () => {
    const id = await logFood(USER, meal());
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal(), id, source_food_id: null, category: null, notes: '' } as never,
    ]);
    await removeEntry(USER, id);
    expect(await localEntry(USER, id)).toBeNull();
  });
});

describe('removing', () => {
  it('tombstones a row whose FIRST push may be in flight, rather than forgetting it', async () => {
    // A freshly logged row is `remote = 0, dirty = 1`. Hard-deleting it loses
    // the race: the in-flight create succeeds, the compare-and-swap finds
    // nothing, and the server keeps an entry this device has forgotten — with
    // no tombstone left to remove it and no pull to bring it back. Web then
    // totals a lunch the athlete deleted. The delete is 204-always on the
    // server, so tombstoning an id it has never seen costs nothing.
    const id = await logFood(USER, meal());
    await removeEntry(USER, id);
    expect(await row(id)).not.toBeNull();
    expect((await row(id))?.deleted_at).toBeTruthy();
    // Gone from every read, immediately, which is all the athlete sees.
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });

  it('hard-deletes a row that is neither pushed nor owed', async () => {
    const id = await logFood(USER, meal());
    // Simulate a completed push whose row was then marked not-remote — the only
    // state where nothing can be in flight.
    await db.runAsync(`UPDATE food_entries SET dirty = 0 WHERE id = ?`, id);
    await removeEntry(USER, id);
    expect(await row(id)).toBeNull();
  });

  it('tombstones a row the server knows about, so it cannot come back on the next pull', async () => {
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal(), id: 'srv-1', source_food_id: null, category: null, notes: '' },
    ]);
    await removeEntry(USER, 'srv-1');

    const r = await row('srv-1');
    expect(r?.deleted_at).not.toBeNull();
    expect(r?.dirty).toBe(1); // the delete is owed
    expect(await localEntries(USER, TODAY)).toHaveLength(0); // and hidden meanwhile
  });

  it('deleting twice is not an error', async () => {
    const id = await logFood(USER, meal());
    await removeEntry(USER, id);
    await expect(removeEntry(USER, id)).resolves.toBeUndefined();
  });
});

describe('pushing', () => {
  it('sends what is owed and stops owing it', async () => {
    const id = await logFood(USER, meal());
    const res = await syncFood(USER, token);

    expect(res.pushed).toBe(1);
    expect(res.failed).toBe(0);
    expect(await row(id)).toMatchObject({ dirty: 0, remote: 1, last_error: null });
  });

  it('sends the local id, which is the whole reason a retry is safe', async () => {
    const id = await logFood(USER, meal());
    await syncFood(USER, token);
    const [, path, init] = mockApi.mock.calls[0] as [unknown, string, { method: string }];
    expect(path).toBe(`/nutrition/entries/${id}`);
    expect(init.method).toBe('PUT');
  });

  it('a tombstone is deleted locally only after the server confirms', async () => {
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal(), id: 'srv-1', source_food_id: null, category: null, notes: '' },
    ]);
    await removeEntry(USER, 'srv-1');
    await syncFood(USER, token);
    expect(await row('srv-1')).toBeNull();
  });

  /**
   * THE COMPARE-AND-SWAP.
   *
   * An edit that lands while a push is in flight must leave the row dirty for
   * the next pass. Without it the push marks the row sent and the athlete's
   * correction is silently never delivered — no error, nothing on the sync
   * screen, just a number that quietly disagrees with what they typed.
   */
  it('an edit made mid-push leaves the row still owed', async () => {
    const id = await logFood(USER, meal());
    mockApi.mockImplementationOnce(async () => {
      // The user corrects the portion while the request is in the air.
      await editEntry(USER, id, meal({ servings: 2, kcal: 360 }));
      return {};
    });
    mockApi.mockResolvedValue({});

    await syncFood(USER, token);

    const r = await row(id);
    expect(r?.dirty).toBe(1);
  });

  it('an edit made mid-push survives a REJECTION of the payload that preceded it', async () => {
    // The quieter half of the same bug, and the one that shipped. The success
    // path compared-and-swapped from the start; the failure path did not, so a
    // 4xx on the OLD payload cleared `dirty` on the NEW edit and the
    // correction never left the phone — silently, with no error the athlete
    // could act on.
    const id = await logFood(USER, meal());
    // ONCE, and the distinction is load-bearing: a persistent implementation
    // also fires on the foods pull at the end of the push, which edits the row
    // a second time and re-dirties it — so the test would pass with the guard
    // removed. Found by mutation, which is the only thing that finds this.
    mockApi.mockImplementationOnce(async () => {
      await editEntry(USER, id, meal({ servings: 2, kcal: 360 }));
      throw new ApiError('rejected', 'invalid_input', 400);
    });
    mockApi.mockResolvedValue({});

    await syncFood(USER, token);

    const r = await row(id);
    expect(r?.dirty).toBe(1);
    expect(r?.kcal).toBe(360);
  });

  it('a rejection does not stamp its error onto a newer edit', async () => {
    const id = await logFood(USER, meal());
    mockApi.mockImplementationOnce(async () => {
      await editEntry(USER, id, meal({ servings: 2, kcal: 360 }));
      throw new ApiError('rejected', 'invalid_input', 400);
    });
    mockApi.mockResolvedValue({});

    await syncFood(USER, token);

    // `editEntry` clears `last_error`; the failure of the previous payload
    // must not put it back on a row that has not been tried yet.
    expect((await row(id))?.last_error).toBeNull();
  });

  it('a permanent rejection stops owing but keeps the reason', async () => {
    const id = await logFood(USER, meal());
    // Scoped to the entry's own PUT, not every call: an empty account also
    // owes the fresh-install backfill's own GET this same sync (N428, #686),
    // and a blanket rejection would fail that too — a second, unrelated
    // failure this test has no opinion about.
    mockApi.mockImplementation(async (_t: unknown, _path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') {
        throw new ApiError('servings must be more than 0', 'invalid_input', 400);
      }
      return {};
    });

    const res = await syncFood(USER, token);

    expect(res.failed).toBe(1);
    expect(res.errorKind).toBe('permanent');
    const r = await row(id);
    // Stops owing — a 4xx will not become a 2xx — but the row and its reason
    // survive so the sync screen can explain it.
    expect(r?.dirty).toBe(0);
    expect(r?.last_error).toContain('servings');
  });

  it('offline stops the queue rather than walking it', async () => {
    await logFood(USER, meal());
    await logFood(USER, meal({ name: 'Rice' }));
    mockApi.mockRejectedValue(new OfflineError());

    const res = await syncFood(USER, token);

    expect(res.errorKind).toBe('offline');
    // One attempt, not two: there is no point walking the rest with no
    // connection, and doing so turns one failure into a screenful.
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('offline leaves everything still owed', async () => {
    const id = await logFood(USER, meal());
    mockApi.mockRejectedValue(new OfflineError());
    await syncFood(USER, token);
    expect((await row(id))?.dirty).toBe(1);
  });
});

describe('the pull', () => {
  it('does not clobber a local row that is still owed', async () => {
    const id = await logFood(USER, meal({ name: 'Mine' }));
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal({ name: 'Server version' }), id, source_food_id: null, category: null, notes: '' },
    ]);
    const back = await localEntries(USER, TODAY);
    expect(back[0].name).toBe('Mine');
  });

  it('does not delete a local row the server has never heard of', async () => {
    // Absent from the server list is only evidence of deletion for rows the
    // server KNOWS about. This one is absent because it was never pushed.
    await logFood(USER, meal({ name: 'Not yet pushed' }));
    await cacheEntries(USER, TODAY, TODAY, []);
    expect(await localEntries(USER, TODAY)).toHaveLength(1);
  });

  it('removes a synced row the server dropped', async () => {
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal(), id: 'srv-1', source_food_id: null, category: null, notes: '' },
    ]);
    await cacheEntries(USER, TODAY, TODAY, []);
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });

  it('does not resurrect a tombstoned row', async () => {
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal(), id: 'srv-1', source_food_id: null, category: null, notes: '' },
    ]);
    await removeEntry(USER, 'srv-1');
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal(), id: 'srv-1', source_food_id: null, category: null, notes: '' },
    ]);
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });
});

describe('the foods pull', () => {
  /** A server food, as `listFoods` would hand it back. */
  function serverFood(over: Partial<Food> = {}): Food {
    return {
      id: 'srv-1',
      kind: 'food',
      name: 'Web recipe',
      brand: '',
      yield_servings: null,
      items: [],
      serving_label: '1 portion',
      serving_grams: null,
      kcal: 500,
      protein_g: 40,
      carb_g: 50,
      fat_g: 15,
      fibre_g: null,
      saturated_fat_g: null,
      sugar_g: null,
      added_sugar_g: null,
      sodium_mg: null,
      cholesterol_mg: null,
      ...over,
    };
  }

  /**
   * Feed the pull ACTUAL FOODS.
   *
   * Every other sync test resolves `{}`, so `listFoods` returns `[]` and the
   * pull loop runs zero times — the suite was green while the pull could not
   * write a single row, because `foods.created_at` and `cached_at` are NOT NULL
   * with no default and the insert omitted both. A mock that starves the code
   * under test hides a bug just as thoroughly as one that supplies the
   * behaviour; this is the same class of flaw, inverted.
   */
  function pullReturns(foods: Food[]) {
    mockApi.mockImplementation(async (_t: unknown, path: string) =>
      String(path).startsWith('/nutrition/foods') ? { foods } : {},
    );
  }

  it('writes a server food the phone has never seen', async () => {
    pullReturns([serverFood()]);
    await syncFood(USER, token);
    const local = await localFoods(USER);
    expect(local.map((f) => f.name)).toContain('Web recipe');
  });

  it('does not clobber a food this device still owes', async () => {
    const id = await saveFoodLocally(USER, {
      kind: 'food', name: 'Mine', brand: '', serving_label: '1',
      serving_grams: null, kcal: 100, protein_g: 1, carb_g: 1, fat_g: 1, fibre_g: null,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    // The push FAILS transiently, so the row is still owed when the pull runs —
    // a 5xx is not offline, so the pull is not skipped. That is the only
    // coherent way to reach this state in one pass: with a successful push, a
    // real server would list back the copy it just accepted, and a mock that
    // says otherwise is testing a server that cannot exist.
    mockApi.mockImplementation(async (_t: unknown, path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') throw new ApiError('upstream', 'internal', 500);
      return String(path).startsWith('/nutrition/foods')
        ? { foods: [serverFood({ id, name: 'Theirs' })] }
        : {};
    });

    await syncFood(USER, token);

    const local = await localFoods(USER);
    expect(local.find((f) => f.id === id)?.name).toBe('Mine');
  });

  it('removes a food the server dropped, but only one the phone has no stake in', async () => {
    pullReturns([serverFood({ id: 'srv-keep' }), serverFood({ id: 'srv-gone' })]);
    await syncFood(USER, token);
    expect((await localFoods(USER)).map((f) => f.id)).toEqual(
      expect.arrayContaining(['srv-keep', 'srv-gone']),
    );

    pullReturns([serverFood({ id: 'srv-keep' })]);
    await syncFood(USER, token);
    const after = (await localFoods(USER)).map((f) => f.id);
    expect(after).toContain('srv-keep');
    expect(after).not.toContain('srv-gone');
  });

  it('does not delete a local food the server has never heard of', async () => {
    await saveFoodLocally(USER, {
      kind: 'food', name: 'Unpushed', brand: '', serving_label: '1',
      serving_grams: null, kcal: 100, protein_g: 1, carb_g: 1, fat_g: 1, fibre_g: null,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    // Same shape: the push fails, so the row has genuinely never reached the
    // server, and an empty list means "never heard of it" rather than
    // "deleted". Deleting it here would throw away the athlete's own work.
    mockApi.mockImplementation(async (_t: unknown, path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') throw new ApiError('upstream', 'internal', 500);
      return String(path).startsWith('/nutrition/foods') ? { foods: [] } : {};
    });

    await syncFood(USER, token);

    expect((await localFoods(USER)).map((f) => f.name)).toContain('Unpushed');
  });

  it('is scoped to the athlete', async () => {
    pullReturns([serverFood()]);
    await syncFood(USER, token);
    expect(await localFoods('u2')).toHaveLength(0);
  });
});

describe('the target cache', () => {
  it('an unreachable target is UNKNOWN, not "you have none"', async () => {
    // The distinction the whole TargetView union exists for. Zero cached rows
    // and no successful fetch ever is not evidence that the athlete has no
    // target — they may have set one on web this morning.
    expect(await localTargetView(USER, TODAY)).toEqual({ state: 'unknown' });
  });

  it('once the server has answered, no target really does mean none', async () => {
    await cacheTargets(USER, TODAY, TODAY, []);
    expect(await localTargetView(USER, TODAY)).toEqual({ state: 'none' });
  });

  it('serves the cached target with no network at all', async () => {
    await cacheTargets(USER, TODAY, TODAY, [aTarget()]);
    const v = await localTargetView(USER, TODAY);
    expect(v.state).toBe('set');
    expect(v.state === 'set' && v.target.kcal).toBe(2400);
  });

  it('carries a target forward from before the window, like the server does', async () => {
    await cacheTargets(USER, '2026-03-01', '2026-03-01', [
      aTarget({ effective_on: '2026-03-01' }),
    ]);
    const v = await localTargetView(USER, TODAY);
    expect(v.state === 'set' && v.target.effective_on).toBe('2026-03-01');
  });

  it('a target deleted on web does not linger in the cache', async () => {
    await cacheTargets(USER, TODAY, TODAY, [aTarget()]);
    await cacheTargets(USER, TODAY, TODAY, []);
    expect(await localTargetView(USER, TODAY)).toEqual({ state: 'none' });
  });

  it('a narrow window does not sweep away a target from another month', async () => {
    // The carry-in row sits BEFORE `from`, so the in-window delete must not
    // reach it — otherwise asking about August erases March.
    await cacheTargets(USER, '2026-03-01', '2026-03-01', [
      aTarget({ effective_on: '2026-03-01' }),
    ]);
    await cacheTargets(USER, TODAY, TODAY, []);
    const v = await localTargetView(USER, TODAY);
    expect(v.state === 'set' && v.target.effective_on).toBe('2026-03-01');
  });

  it('is scoped to the athlete', async () => {
    await cacheTargets('u2', TODAY, TODAY, [aTarget()]);
    expect(await localTargetView(USER, TODAY)).toEqual({ state: 'unknown' });
  });
});

describe('pending count', () => {
  it('counts both tables, because sync gates its machinery on this number', async () => {
    await logFood(USER, meal());
    await saveFoodLocally(USER, {
      kind: 'food', name: 'Oats', brand: '', serving_label: '100 g', serving_grams: 100,
      kcal: 380, protein_g: 13, carb_g: 60, fat_g: 8, fibre_g: 10,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    expect(await pendingFoodCount(USER)).toBe(2);
  });

  it('is zero once everything is sent', async () => {
    await logFood(USER, meal());
    await syncFood(USER, token);
    expect(await pendingFoodCount(USER)).toBe(0);
  });

  it('is scoped to the athlete', async () => {
    await logFood('u2', meal());
    expect(await pendingFoodCount(USER)).toBe(0);
  });
});

describe('recents', () => {
  it('counts uses per slot, so breakfast and dinner rank differently', async () => {
    const oats = await saveFoodLocally(USER, {
      kind: 'food', name: 'Oats', brand: '', serving_label: '100 g', serving_grams: 100,
      kcal: 380, protein_g: 13, carb_g: 60, fat_g: 8, fibre_g: 10,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    await logFood(USER, meal({ meal: 'breakfast', source_food_id: oats }));
    await logFood(USER, meal({ meal: 'breakfast', source_food_id: oats }));
    await logFood(USER, meal({ meal: 'dinner', source_food_id: oats }));

    const breakfast = await recentsFor(USER, 'breakfast');
    const dinner = await recentsFor(USER, 'dinner');
    expect(breakfast[0].uses).toBe(2);
    expect(dinner[0].uses).toBe(1);
  });

  it('a deleted entry stops counting toward the ranking', async () => {
    const oats = await saveFoodLocally(USER, {
      kind: 'food', name: 'Oats', brand: '', serving_label: '100 g', serving_grams: 100,
      kcal: 380, protein_g: 13, carb_g: 60, fat_g: 8, fibre_g: 10,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    const id = await logFood(USER, meal({ meal: 'breakfast', source_food_id: oats }));
    await cacheEntries(USER, TODAY, TODAY, []); // make it server-known so it tombstones
    await logFood(USER, meal({ meal: 'breakfast', source_food_id: oats }));
    await removeEntry(USER, id);

    const breakfast = await recentsFor(USER, 'breakfast');
    expect(breakfast[0].uses).toBe(1);
  });
});

/**
 * `localLoggedDays` — the SQL half of the logged-day count.
 *
 * A fixture test rather than a pure one, deliberately: this repo's rule is that
 * anything about SQL behaviour belongs against a real database, never a regex
 * over the query string or an array mock, because a text assertion proves a
 * clause is present and not that SQLite honours it — and both mistakes have
 * shipped here before.
 *
 * The JS window arithmetic is covered in `n53Macros.test.ts`; this covers what
 * the query actually returns, and the two together are what make the count
 * trustworthy. Neither half alone would catch a mismatch between the SQL range
 * and the JS window.
 */
describe('localLoggedDays', () => {
  it('returns each day once, however many entries it has', () => {
    return (async () => {
      await logFood(USER, meal());
      await logFood(USER, meal({ name: 'Rice' }));
      await logFood(USER, meal({ eaten_on: '2026-08-17' }));
      const days = await localLoggedDays(USER, '2026-08-12', TODAY);
      expect(days.sort()).toEqual(['2026-08-17', TODAY]);
    })();
  });

  it('is inclusive at BOTH ends of the range', async () => {
    // The window `daysLogged` applies is [today-6, today] inclusive. If the
    // SQL were exclusive at either end the count would silently be short by a
    // day, and nothing else would notice.
    await logFood(USER, meal({ eaten_on: '2026-08-12' }));
    await logFood(USER, meal({ eaten_on: TODAY }));
    expect((await localLoggedDays(USER, '2026-08-12', TODAY)).sort()).toEqual([
      '2026-08-12',
      TODAY,
    ]);
  });

  it('excludes days outside the range', async () => {
    await logFood(USER, meal({ eaten_on: '2026-08-01' }));
    expect(await localLoggedDays(USER, '2026-08-12', TODAY)).toEqual([]);
  });

  it('stops counting a day whose only entry was deleted', async () => {
    // Tombstones, which is the half a `SELECT DISTINCT` most easily forgets —
    // and a deleted day still counting is a claim the athlete logged when they
    // have just undone exactly that.
    const id = await logFood(USER, meal());
    expect(await localLoggedDays(USER, '2026-08-12', TODAY)).toEqual([TODAY]);
    await removeEntry(USER, id);
    expect(await localLoggedDays(USER, '2026-08-12', TODAY)).toEqual([]);
  });

  it('does not see another athlete’s days', async () => {
    await logFood('someone-else', meal());
    expect(await localLoggedDays(USER, '2026-08-12', TODAY)).toEqual([]);
  });
});

/**
 * `localLoggedDayKcal` — the same query, carrying what the day added up to.
 *
 * The stronger half of `localLoggedDays`, and it feeds the Goals screen's
 * confidence block, where "did you log that day" and "did you log that day
 * *properly*" are different questions: a single breakfast is not a day's
 * evidence, and a target judged against fourteen of them is judged against a
 * fiction.
 *
 * A fixture test for the same reason its sibling above is one — **SQL
 * behaviour belongs against a real database**. Every claim here is one the
 * doc comment on the function makes, and each was previously a claim in a
 * comment and nothing else: the SUM, the DISTINCT-by-day grouping, the
 * tombstone exclusion, the range, and the user scope.
 */
describe('localLoggedDayKcal', () => {
  const on = (rows: { day: string; kcal: number }[], day: string) =>
    rows.find((r) => r.day === day);

  it('sums a day rather than returning a row per entry', async () => {
    await logFood(USER, meal({ kcal: 180 }));
    await logFood(USER, meal({ name: 'Rice', kcal: 320 }));
    const rows = await localLoggedDayKcal(USER, '2026-08-12', TODAY);
    expect(rows).toHaveLength(1);
    expect(on(rows, TODAY)?.kcal).toBe(500);
  });

  it('keeps days separate', async () => {
    await logFood(USER, meal({ kcal: 180 }));
    await logFood(USER, meal({ eaten_on: '2026-08-16', kcal: 2100 }));
    const rows = await localLoggedDayKcal(USER, '2026-08-12', TODAY);
    expect(rows).toHaveLength(2);
    expect(on(rows, '2026-08-16')?.kcal).toBe(2100);
    expect(on(rows, TODAY)?.kcal).toBe(180);
  });

  it('OMITS a day with no entries rather than reporting it as zero', async () => {
    // The distinction the whole three-state confidence rule rests on. `stateFor`
    // reads `undefined` as empty and a real `0` as partial, so a query that
    // helpfully filled gaps with zeroes would turn every untouched day into a
    // day the athlete part-logged.
    await logFood(USER, meal());
    const rows = await localLoggedDayKcal(USER, '2026-08-12', TODAY);
    expect(rows.map((r) => r.day)).toEqual([TODAY]);
  });

  it('stops reporting a day whose only entry was deleted', async () => {
    // The tombstone half, which is what `deleted_at IS NULL` is for. A deleted
    // day must DISAPPEAR, not come back as a zero — a zero is "you logged
    // almost nothing", and the athlete has just undone exactly that.
    const id = await logFood(USER, meal());
    expect(await localLoggedDayKcal(USER, '2026-08-12', TODAY)).toHaveLength(1);
    await removeEntry(USER, id);
    expect(await localLoggedDayKcal(USER, '2026-08-12', TODAY)).toEqual([]);
  });

  it('subtracts only the deleted entry from a day that has others', async () => {
    await logFood(USER, meal({ kcal: 180 }));
    const id = await logFood(USER, meal({ name: 'Rice', kcal: 320 }));
    await removeEntry(USER, id);
    const rows = await localLoggedDayKcal(USER, '2026-08-12', TODAY);
    expect(on(rows, TODAY)?.kcal).toBe(180);
  });

  it('is inclusive at both ends and excludes what is outside', async () => {
    await logFood(USER, meal({ eaten_on: '2026-08-11', kcal: 999 }));
    await logFood(USER, meal({ eaten_on: '2026-08-12', kcal: 100 }));
    await logFood(USER, meal({ eaten_on: TODAY, kcal: 200 }));
    const rows = await localLoggedDayKcal(USER, '2026-08-12', TODAY);
    expect(rows.map((r) => r.day).sort()).toEqual(['2026-08-12', TODAY]);
  });

  it('reports a genuine zero-calorie day, because it still has entries', async () => {
    // Black coffee. `stateFor` needs to tell this from "no rows at all", so the
    // query must return the day with 0 rather than dropping it.
    await logFood(USER, meal({ kcal: 0 }));
    const rows = await localLoggedDayKcal(USER, '2026-08-12', TODAY);
    expect(rows).toEqual([{ day: TODAY, kcal: 0 }]);
  });

  it('does not see another athlete’s days', async () => {
    await logFood('someone-else', meal({ kcal: 2000 }));
    expect(await localLoggedDayKcal(USER, '2026-08-12', TODAY)).toEqual([]);
  });
});
