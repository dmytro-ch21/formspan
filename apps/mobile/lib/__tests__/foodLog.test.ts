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
  duplicateEntry,
  editEntry,
  cacheTargets,
  entrySyncState,
  foodSyncState,
  localEntries,
  localLoggedDayKcal,
  localLoggedDays,
  localEntry,
  localFoods,
  localTargetView,
  logFood,
  moveEntry,
  reorderEntries,
  pendingFoodCount,
  recentsFor,
  removeEntry,
  saveFoodLocally,
  syncFood,
} from '../foodLog';
import type { Food, Target } from '../nutrition';
import { isFoodCaffeineEntryId, pairedFoodCaffeineEntryId } from '../foodCaffeine';
import {
  cacheTrackers,
  localEntries as localTrackerEntries,
} from '../trackers';
import type { Tracker } from '../trackerModel';
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
    // N553 — carried so a spread of this into a server-shaped `Entry` (for
    // `cacheEntries`) satisfies the type. `logFood` ignores it and computes
    // the real one; the tests that care about ordering state it explicitly.
    position: 1024,
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

/**
 * N124/N113 (#514/#502): `category` threads through the full local write/read
 * cycle and the outbound push — the mobile-side equivalent of the backend's
 * `TestEntryCategoryIsCopiedAndSurvivesAnEditToTheFood`, closing the gap
 * `frontend-reviewer` flagged: every other fixture in this file sets
 * `category: null`, so nothing here previously went red if a real value were
 * silently dropped on write, read, edit or push — the exact `updateWithin`-
 * shaped column-threading bug CLAUDE.md warns about, on the one column in
 * this table with no test that could catch it.
 */
describe('category (N124/N113)', () => {
  it('survives the write/read round trip through SQLite', async () => {
    await logFood(USER, meal({ category: 'poultry' }));
    const [entry] = await localEntries(USER, TODAY);
    expect(entry.category).toBe('poultry');
  });

  it('a null category round-trips as null, not the string "null"', async () => {
    await logFood(USER, meal({ category: null }));
    const [entry] = await localEntries(USER, TODAY);
    expect(entry.category).toBeNull();
  });

  it('editing an entry keeps its category when the edit does not change it', async () => {
    const id = await logFood(USER, meal({ category: 'poultry' }));
    await editEntry(USER, id, meal({ category: 'poultry', kcal: 200 }));
    const [entry] = await localEntries(USER, TODAY);
    expect(entry).toMatchObject({ category: 'poultry', kcal: 200 });
  });

  it('is included in the payload a push sends to the server', async () => {
    await logFood(USER, meal({ category: 'poultry' }));
    await syncFood(USER, token);
    const [, , init] = mockApi.mock.calls[0] as [unknown, string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ category: 'poultry' });
  });
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

/**
 * N116/#505 — the two flags `ShareToFriend` is gated on. Real SQLite for the
 * same reason as everything else in this file: a mock supplying the answer
 * would prove nothing about the actual `remote`/`dirty` columns.
 */
describe('sync state, for the ShareToFriend gate (N116/#505)', () => {
  it('a freshly logged entry is both unsynced and owed', async () => {
    const id = await logFood(USER, meal());
    await expect(entrySyncState(USER, id)).resolves.toEqual({ unsynced: true, owed: true });
  });

  it('a pushed, unedited entry is shareable', async () => {
    const id = await logFood(USER, meal());
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await expect(entrySyncState(USER, id)).resolves.toEqual({ unsynced: false, owed: false });
  });

  it('a pushed entry with a LOCAL edit not yet pushed is owed, not unsynced', async () => {
    const id = await logFood(USER, meal());
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await editEntry(USER, id, meal({ kcal: 200 }));
    await expect(entrySyncState(USER, id)).resolves.toEqual({ unsynced: false, owed: true });
  });

  it('returns null for an id this device holds no row for', async () => {
    await expect(entrySyncState(USER, 'no-such-id')).resolves.toBeNull();
  });

  it('returns null for a tombstoned entry — nothing left to send', async () => {
    const id = await logFood(USER, meal());
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await removeEntry(USER, id);
    await expect(entrySyncState(USER, id)).resolves.toBeNull();
  });

  it('a freshly saved food is both unsynced and owed, the same as an entry', async () => {
    const id = await saveFoodLocally(USER, {
      kind: 'food', name: 'Mine', brand: '', serving_label: '1',
      serving_grams: null, kcal: 100, protein_g: 1, carb_g: 1, fat_g: 1, fibre_g: null,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    await expect(foodSyncState(USER, id)).resolves.toEqual({ unsynced: true, owed: true, rejected: null });
  });

  it('a pushed, unedited food is shareable', async () => {
    const id = await saveFoodLocally(USER, {
      kind: 'food', name: 'Mine', brand: '', serving_label: '1',
      serving_grams: null, kcal: 100, protein_g: 1, carb_g: 1, fat_g: 1, fibre_g: null,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    await db.runAsync(`UPDATE foods SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await expect(foodSyncState(USER, id)).resolves.toEqual({ unsynced: false, owed: false, rejected: null });
  });

  it('returns null for a food id this device holds no row for', async () => {
    await expect(foodSyncState(USER, 'no-such-id')).resolves.toBeNull();
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

/** The shipped caffeine preset (N431), same fixture shape `trackers.test.ts` uses. */
const caffeine: Tracker = {
  id: 't_caffeine', preset: 'caffeine', name: 'Caffeine', icon: '⚡', color_key: 'amber',
  unit: 'mg', increment: 80, target: 400, render_style: 'glyphs', sort_order: 30,
  count_noun: 'cup', provisioned: false, cutoff_minutes: 960,
};

const caffeineWire = (over: Partial<Record<string, unknown>> = {}) => ({
  ...caffeine,
  user_id: USER,
  archived_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

/**
 * N468/#792 — a logged food item automatically posting to the caffeine
 * tracker, staying in sync across edits, and being un-postable when the
 * food is removed. `foodCaffeine.test.ts` covers the heuristic itself in
 * isolation; this is the dual-write mechanics, against real SQLite.
 */
describe('N468/#792: a caffeinated food automatically posts to the caffeine tracker', () => {
  /**
   * A directly-tapped drink log, not a weighed one -- `serving_label` is a
   * real "how many" unit ("1 cup"), not a gram weight, so `servings` here
   * is a drink count and the mg figures below (95, 126, 190...) are the
   * plain `mgPerServing * servings` this suite is actually exercising (the
   * dual-write mechanics). `meal()`'s own default `serving_label: '100 g'`
   * is a gram weight as of N501/#872 and would route these through the
   * grams-basis scaling `foodCaffeine.test.ts` covers in isolation.
   */
  function drink(over: Partial<Parameters<typeof logFood>[1]> = {}) {
    return meal({ serving_label: '1 cup', ...over });
  }

  it('logs a paired caffeine entry when the athlete has a caffeine tracker', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    await logFood(USER, drink({ name: 'Latte' }));

    const entries = await localTrackerEntries(USER, TODAY);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tracker_id: caffeine.id, amount: 95 });
    expect(isFoodCaffeineEntryId(entries[0].id)).toBe(true);
  });

  it('scales the mg figure by how many servings were logged', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    await logFood(USER, drink({ name: 'Espresso', servings: 2 }));

    const entries = await localTrackerEntries(USER, TODAY);
    expect(entries[0].amount).toBe(126); // 63 mg * 2
  });

  it('posts nothing when the food is not recognised as caffeinated', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    await logFood(USER, drink({ name: 'Chicken thigh' }));
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(0);
  });

  it('posts nothing when the athlete has no caffeine tracker — exactly as before this ticket', async () => {
    await logFood(USER, drink({ name: 'Latte' }));
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(0);
  });

  it('a food-caused entry is refused/removed only alongside the food — editing the food to a non-caffeinated name removes it', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    const id = await logFood(USER, drink({ name: 'Latte' }));
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(1);

    await editEntry(USER, id, drink({ name: 'Decaf Latte' }));
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(0);
  });

  it('editing servings updates the caffeine total to match, not leaving the old figure stranded', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    const id = await logFood(USER, drink({ name: 'Latte', servings: 1 }));
    expect((await localTrackerEntries(USER, TODAY))[0].amount).toBe(95);

    await editEntry(USER, id, drink({ name: 'Latte', servings: 2 }));
    const entries = await localTrackerEntries(USER, TODAY);
    expect(entries).toHaveLength(1); // the stale one was superseded, not left beside the new one
    expect(entries[0].amount).toBe(190);
  });

  it('an edit that changes nothing about the caffeine figure does not churn the entry', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    const id = await logFood(USER, drink({ name: 'Latte' }));
    const before = (await localTrackerEntries(USER, TODAY))[0].id;

    // Editing only the note, say — the mg figure is unchanged.
    await editEntry(USER, id, drink({ name: 'Latte' }));
    const after = await localTrackerEntries(USER, TODAY);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before); // same row, not tombstoned and recreated
  });

  it('removing the food removes the caffeine entry it caused', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    const id = await logFood(USER, drink({ name: 'Latte' }));
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(1);

    await removeEntry(USER, id);
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(0);
  });

  it('does not touch a manually-tapped caffeine entry that merely shares a day', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    const id = await logFood(USER, drink({ name: 'Latte' }));
    // A manual tap the athlete made themselves, unrelated to any food.
    await db.runAsync(
      `INSERT INTO tracker_entries (id, tracker_id, user_id, logged_on, logged_at, amount, updated_at, dirty, remote)
       VALUES (?,?,?,?,?,?,?,1,0)`,
      'manual-1', caffeine.id, USER, TODAY, '2026-08-18T08:00:00.000Z', 80, '2026-08-18T08:00:00.000Z',
    );

    await removeEntry(USER, id);
    const entries = await localTrackerEntries(USER, TODAY);
    expect(entries.map((e) => e.id)).toEqual(['manual-1']);
  });

  /**
   * frontend-reviewer, N468 review: a food entry deleted from ANOTHER
   * surface (web's `DayEditor.tsx`, say) reaches this device as an absence
   * from the next `cacheEntries` pull, not as a call to `removeEntry` — and
   * `cacheEntries`'s own DELETE used to have no idea a caffeine entry was
   * ever paired to the row it was sweeping. The orphan this pins: the
   * caffeine banner keeps a padlocked entry pointing at a food log that no
   * longer has anything to edit or remove, on this device and any other
   * that pulls the same day — the exact "the two disagree" failure this
   * ticket's own AC named.
   */
  it('a food entry removed via a PULL (not this device\'s own removeEntry) also removes the caffeine entry it caused', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    // This device's copy of a server-known food entry — inserted the way a
    // real pull would (dirty=0, remote=1), not via logFood.
    await cacheEntries(USER, TODAY, TODAY, [
      { ...drink({ name: 'Latte' }), id: 'srv-food-1', source_food_id: null, category: null, notes: '' },
    ]);
    // Its caffeine entry, as if an earlier `logFood`/`editEntry` on some
    // device had already run `syncFoodCaffeineEntry` for it.
    const caffeineId = pairedFoodCaffeineEntryId('srv-food-1', 'abc12345');
    await db.runAsync(
      `INSERT INTO tracker_entries (id, tracker_id, user_id, logged_on, logged_at, amount, updated_at, dirty, remote)
       VALUES (?,?,?,?,?,?,?,1,0)`,
      caffeineId, caffeine.id, USER, TODAY, '2026-08-18T08:00:00.000Z', 95, '2026-08-18T08:00:00.000Z',
    );
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(1);

    // The server no longer reports the food (deleted from web, say) — the
    // next pull sweeps the local row via cacheEntries, never touching
    // removeEntry at all.
    await cacheEntries(USER, TODAY, TODAY, []);

    expect(await localEntries(USER, TODAY)).toHaveLength(0);
    // The orphan this bug named: the caffeine entry must go with it, not
    // survive pointing at nothing.
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(0);
  });

  it('a pull that drops an UNCAFFEINATED food touches no tracker row at all', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    await cacheEntries(USER, TODAY, TODAY, [
      { ...drink({ name: 'Chicken thigh' }), id: 'srv-food-2', source_food_id: null, category: null, notes: '' },
    ]);
    await cacheEntries(USER, TODAY, TODAY, []);
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
    expect(await localTrackerEntries(USER, TODAY)).toHaveLength(0);
  });

  /**
   * N501/#872, end to end against real SQLite — the grams-basis fix, not just
   * `drink()`'s drink-count path every other test in this block exercises.
   * `meal()`'s own default `serving_label: '100 g'` is exactly what a
   * catalog/barcode entry logged by weight carries (`food/add.tsx`'s
   * `logCatalog` sets `servings: servingsForGrams(food, grams)` against it —
   * see `foodQuantity.ts`), so this is the shape the bug report ("if i drink
   * one cup it should automatically add") actually arrives in.
   */
  it('a catalog entry logged BY WEIGHT posts a realistic single-cup dose, not a grams-inflated one', async () => {
    await cacheTrackers(USER, [caffeineWire()]);
    // 240 g of catalog "Coffee" (100 g basis) is one real cup: servings=2.4.
    await logFood(USER, meal({ name: 'Coffee', servings: 2.4, serving_label: '100 g' }));

    const entries = await localTrackerEntries(USER, TODAY);
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(95); // NOT round(95 * 2.4) = 228
  });
});

/**
 * N531/#962 — the row menu's Duplicate and the drag's drop, at the outbox.
 *
 * Both are local-first writes and both have to survive a pull. The drag has
 * one more property the ticket calls out by name — "do not ship a drag that
 * silently forgets" — so the pull-racing-a-move case is pinned here rather
 * than argued from `cacheEntries`' `WHERE dirty = 0`.
 */
describe('duplicate (N531)', () => {
  it('writes a NEW row in the same meal on the same day, with the same nutrition and provenance', async () => {
    const src = await logFood(USER, meal({
      meal: 'breakfast', source_food_id: 'food-7', category: 'poultry', notes: 'with sauce',
    }));
    const dup = await duplicateEntry(USER, src);

    expect(dup).not.toBe(src);
    const day = await localEntries(USER, TODAY);
    expect(day).toHaveLength(2);
    const copy = day.find((e) => e.id === dup);
    const orig = day.find((e) => e.id === src);
    expect(copy).toMatchObject({
      meal: 'breakfast', eaten_on: TODAY, name: 'Chicken thigh', kcal: 180, protein_g: 25,
      source_food_id: 'food-7', category: 'poultry', notes: 'with sauce',
    });
    // The original is untouched — a duplicate is an addition, not an edit.
    expect(orig).toMatchObject({ meal: 'breakfast', kcal: 180 });
  });

  it('owes a push for the copy, and makes no network call to create it (airplane mode)', async () => {
    const src = await logFood(USER, meal());
    // The original has already been sent, so the outbox is empty before this.
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, src);
    expect(await pendingFoodCount(USER)).toBe(0);

    const dup = await duplicateEntry(USER, src);
    expect(mockApi).not.toHaveBeenCalled();
    expect(await row(dup)).toMatchObject({ dirty: 1, remote: 0, deleted_at: null });
    expect(await pendingFoodCount(USER)).toBe(1);
  });

  it('sends the copy under its own id on the next push, with the same meal and source food', async () => {
    const src = await logFood(USER, meal({ source_food_id: 'food-7' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, src);
    const dup = await duplicateEntry(USER, src);

    await syncFood(USER, token);
    const entryCalls = mockApi.mock.calls.filter(([, path]) => String(path).includes(dup));
    expect(entryCalls).toHaveLength(1);
    const [, , init] = entryCalls[0] as [unknown, string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ meal: 'lunch', source_food_id: 'food-7' });
    expect(await row(dup)).toMatchObject({ dirty: 0, remote: 1 });
  });

  it('refuses an entry that is gone, rather than duplicating nothing', async () => {
    const id = await logFood(USER, meal());
    await removeEntry(USER, id);
    await expect(duplicateEntry(USER, id)).rejects.toThrow(/no longer exists/);
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });

  it("cannot duplicate another athlete's entry", async () => {
    const theirs = await logFood('u2', meal());
    await expect(duplicateEntry(USER, theirs)).rejects.toThrow(/no longer exists/);
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });
});

describe('move between meals (N531)', () => {
  it('changes ONLY the meal, and owes a push for it', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    const before = await db.getFirstAsync<{ logged_at: string }>(
      `SELECT logged_at FROM food_entries WHERE id = ?`, id,
    );

    await moveEntry(USER, id, 'lunch');

    const [e] = await localEntries(USER, TODAY);
    expect(e).toMatchObject({ id, meal: 'lunch', kcal: 180, name: 'Chicken thigh' });
    expect(await row(id)).toMatchObject({ dirty: 1, remote: 1, deleted_at: null });
    // `logged_at` is when it was eaten; a move does not re-eat it.
    const after = await db.getFirstAsync<{ logged_at: string }>(
      `SELECT logged_at FROM food_entries WHERE id = ?`, id,
    );
    expect(after?.logged_at).toBe(before?.logged_at);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('a drop on the section the entry is already in is a no-op — it does not dirty the row', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    const before = await row(id);

    await moveEntry(USER, id, 'breakfast');

    // Same `updated_at`, still clean — so `entrySyncState` still says
    // shareable, which is the reason this guard exists.
    expect(await row(id)).toEqual(before);
    expect(await entrySyncState(USER, id)).toEqual({ unsynced: false, owed: false });
  });

  it('sends the new meal on the next push', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await moveEntry(USER, id, 'dinner');

    await syncFood(USER, token);
    const [, , init] = mockApi.mock.calls[0] as [unknown, string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ meal: 'dinner' });
    expect(await row(id)).toMatchObject({ dirty: 0, remote: 1 });
  });

  it('persists across a pull: once pushed, the server echoing the new meal keeps it there', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await moveEntry(USER, id, 'dinner');
    await syncFood(USER, token);

    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal({ meal: 'dinner' }), id, source_food_id: null, category: null, notes: '' },
    ]);
    const [e] = await localEntries(USER, TODAY);
    expect(e.meal).toBe('dinner');
  });

  it('a pull that arrives BEFORE the push does not snap the entry back to its old meal', async () => {
    // The trap the ticket names: the athlete drags lunch to dinner, then a
    // background pull answers with the server\'s still-stale copy. The
    // local move is `dirty`, and `cacheEntries` refuses to overwrite a row
    // this device still owes — pinned here rather than assumed.
    const id = await logFood(USER, meal({ meal: 'lunch' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await moveEntry(USER, id, 'dinner');

    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal({ meal: 'lunch' }), id, source_food_id: null, category: null, notes: '' },
    ]);

    const [e] = await localEntries(USER, TODAY);
    expect(e.meal).toBe('dinner');
    expect(await row(id)).toMatchObject({ dirty: 1 });
  });

  it('refuses an entry that is gone', async () => {
    const id = await logFood(USER, meal());
    await removeEntry(USER, id);
    await expect(moveEntry(USER, id, 'dinner')).rejects.toThrow(/no longer exists/);
  });
});

describe('order inside a meal (N553/#1019)', () => {
  /** Positions as they are on disk, by id. */
  async function positions(): Promise<Record<string, number>> {
    const rows = await db.getAllAsync<{ id: string; position: number }>(
      `SELECT id, position FROM food_entries WHERE deleted_at IS NULL`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.position]));
  }

  it('a new entry lands at the END of its meal, one step past the last', async () => {
    const a = await logFood(USER, meal({ meal: 'breakfast', name: 'Eggs' }));
    const b = await logFood(USER, meal({ meal: 'breakfast', name: 'Toast' }));
    const p = await positions();
    expect(p[a]).toBe(1024);
    expect(p[b]).toBe(2048);
  });

  it('numbers each MEAL separately — two meals both start at one step', async () => {
    const b = await logFood(USER, meal({ meal: 'breakfast' }));
    const d = await logFood(USER, meal({ meal: 'dinner' }));
    const p = await positions();
    expect(p[b]).toBe(1024);
    expect(p[d]).toBe(1024);
  });

  it('does not leave a gap behind a deleted row — a tombstone is not in the list', async () => {
    const a = await logFood(USER, meal({ meal: 'breakfast' }));
    const b = await logFood(USER, meal({ meal: 'breakfast' }));
    await removeEntry(USER, b);
    const c = await logFood(USER, meal({ meal: 'breakfast' }));
    const p = await positions();
    // 2048, not 3072: the numbers are not a count and nothing reads them as one.
    expect(p[c]).toBe(p[a] + 1024);
  });

  it('reads a day back in POSITION order, not log order', async () => {
    const eggs = await logFood(USER, meal({ meal: 'breakfast', name: 'Eggs' }));
    const toast = await logFood(USER, meal({ meal: 'breakfast', name: 'Toast' }));
    expect((await localEntries(USER, TODAY)).map((e) => e.name)).toEqual(['Eggs', 'Toast']);

    // Drag the toast above the eggs: one write, the row that moved.
    await reorderEntries(USER, [{ id: toast, position: 0 }]);

    expect((await localEntries(USER, TODAY)).map((e) => e.name)).toEqual(['Toast', 'Eggs']);
    expect((await positions())[eggs]).toBe(1024);
  });

  it('a reorder writes ONLY the row that moved, and dirties only that one', async () => {
    const eggs = await logFood(USER, meal({ meal: 'breakfast', name: 'Eggs' }));
    const toast = await logFood(USER, meal({ meal: 'breakfast', name: 'Toast' }));
    const oats = await logFood(USER, meal({ meal: 'breakfast', name: 'Oats' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1`);
    const before = await positions();

    await reorderEntries(USER, [{ id: oats, position: 512 }]);

    const after = await positions();
    expect(after[eggs]).toBe(before[eggs]);
    expect(after[toast]).toBe(before[toast]);
    expect(await row(oats)).toMatchObject({ dirty: 1 });
    expect(await row(eggs)).toMatchObject({ dirty: 0 });
    expect(await row(toast)).toMatchObject({ dirty: 0 });
    // The whole criterion, stated as the outbox sees it: three rows in the
    // meal, ONE owed.
    expect(await pendingFoodCount(USER)).toBe(1);
  });

  it('sends the position on the next push, so the order survives a reinstall', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await reorderEntries(USER, [{ id, position: 4096 }]);

    await syncFood(USER, token);
    const [, , init] = mockApi.mock.calls[0] as [unknown, string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ position: 4096 });
  });

  it('takes the SERVER position on a pull, which is how another device order arrives', async () => {
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal({ meal: 'breakfast', name: 'Eggs' }), id: 's1', source_food_id: null, category: null, notes: '', position: 2048 },
      { ...meal({ meal: 'breakfast', name: 'Toast' }), id: 's2', source_food_id: null, category: null, notes: '', position: 1024 },
    ]);
    // The server sent them in one order and positioned them in another; the
    // position is what decides. This is the reinstall case too — `cacheEntries`
    // synthesises `logged_at` from a local stamp, so position is the ONLY
    // surviving record of what the athlete arranged.
    expect((await localEntries(USER, TODAY)).map((e) => e.name)).toEqual(['Toast', 'Eggs']);
  });

  it('a pull that arrives before the push does not snap a reorder back', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await reorderEntries(USER, [{ id, position: 77 }]);

    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal({ meal: 'breakfast' }), id, source_food_id: null, category: null, notes: '', position: 1024 },
    ]);

    expect((await positions())[id]).toBe(77);
    expect(await row(id)).toMatchObject({ dirty: 1 });
  });

  it('two rows on the same position still read back in ONE defined order, by id', async () => {
    // The offline-convergence tiebreak, at the SQL level rather than in
    // `entryOrder.ts` — `localEntries` must break the tie the same way
    // `compareEntries` does, or two devices that agree in JavaScript still
    // disagree on screen.
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal({ meal: 'breakfast', name: 'Zed' }), id: 'zzz', source_food_id: null, category: null, notes: '', position: 1024 },
      { ...meal({ meal: 'breakfast', name: 'Abe' }), id: 'aaa', source_food_id: null, category: null, notes: '', position: 1024 },
    ]);
    expect((await localEntries(USER, TODAY)).map((e) => e.name)).toEqual(['Abe', 'Zed']);
  });

  it('a cross-meal move with a position lands where it was dropped', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);

    await moveEntry(USER, id, 'dinner', 512);

    expect((await positions())[id]).toBe(512);
    const [e] = await localEntries(USER, TODAY);
    expect(e.meal).toBe('dinner');
  });

  it('a cross-meal move with NO position appends to the meal it joined', async () => {
    const steak = await logFood(USER, meal({ meal: 'dinner', name: 'Steak' }));
    const eggs = await logFood(USER, meal({ meal: 'breakfast', name: 'Eggs' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1`);

    await moveEntry(USER, eggs, 'dinner');

    const p = await positions();
    expect(p[eggs]).toBe(p[steak] + 1024);
  });

  it('a same-meal, same-position move is still a no-op — it does not dirty the row', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    const before = await row(id);

    await moveEntry(USER, id, 'breakfast');

    expect(await row(id)).toEqual(before);
    expect(await entrySyncState(USER, id)).toEqual({ unsynced: false, owed: false });
  });

  it('an empty plan writes nothing at all', async () => {
    const id = await logFood(USER, meal());
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    await reorderEntries(USER, []);
    expect(await row(id)).toMatchObject({ dirty: 0 });
  });

  it('cannot reorder another athlete row', async () => {
    const id = await logFood(USER, meal({ meal: 'breakfast' }));
    await db.runAsync(`UPDATE food_entries SET dirty = 0, remote = 1 WHERE id = ?`, id);
    const before = await positions();

    await reorderEntries('someone-else', [{ id, position: 9 }]);

    expect(await positions()).toEqual(before);
    expect(await row(id)).toMatchObject({ dirty: 0 });
  });
});
