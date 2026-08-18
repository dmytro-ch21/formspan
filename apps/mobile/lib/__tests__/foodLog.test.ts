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
  localEntry,
  localTargetView,
  logFood,
  pendingFoodCount,
  recentsFor,
  removeEntry,
  saveFoodLocally,
  syncFood,
} from '../foodLog';
import type { Target } from '../nutrition';
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
      { ...meal(), id, source_food_id: null, notes: '' } as never,
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
      { ...meal(), id: 'srv-1', source_food_id: null, notes: '' },
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
      { ...meal(), id: 'srv-1', source_food_id: null, notes: '' },
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
    mockApi.mockRejectedValue(new ApiError('servings must be more than 0', 'invalid_input', 400));

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
      { ...meal({ name: 'Server version' }), id, source_food_id: null, notes: '' },
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
      { ...meal(), id: 'srv-1', source_food_id: null, notes: '' },
    ]);
    await cacheEntries(USER, TODAY, TODAY, []);
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });

  it('does not resurrect a tombstoned row', async () => {
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal(), id: 'srv-1', source_food_id: null, notes: '' },
    ]);
    await removeEntry(USER, 'srv-1');
    await cacheEntries(USER, TODAY, TODAY, [
      { ...meal(), id: 'srv-1', source_food_id: null, notes: '' },
    ]);
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
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
    });
    const id = await logFood(USER, meal({ meal: 'breakfast', source_food_id: oats }));
    await cacheEntries(USER, TODAY, TODAY, []); // make it server-known so it tombstones
    await logFood(USER, meal({ meal: 'breakfast', source_food_id: oats }));
    await removeEntry(USER, id);

    const breakfast = await recentsFor(USER, 'breakfast');
    expect(breakfast[0].uses).toBe(1);
  });
});
