/**
 * N79 — deleting a saved food or recipe, against a real SQLite database.
 *
 * `removeFood` is the exact shape of `removeEntry` (`foodLog.test.ts`'s
 * "removing" and "pushing" describe blocks are its template), applied to a
 * table that PULLS as well as pushes — which is what makes the push-side half
 * of this file necessary in a way the entry queue never needed: `foods`' own
 * dirty-row query used to filter `deleted_at IS NULL`, so a tombstone was
 * silently invisible to the very query meant to send it. That is the bug this
 * ticket exists to close, and the ONE regression this suite must never let
 * back in is a tombstoned row that `syncFood` walks straight past.
 *
 * ## The fake server has to be STATEFUL
 *
 * `foodLog.test.ts`'s own comment on this exact trap: "every other sync test
 * resolves `{}`, so `listFoods` returns `[]`" — harmless for a test that never
 * has a synced food row lying around, and WRONG here. Every `syncFood` call
 * ends with a foods PULL that treats an empty list as "the server dropped
 * this", and `cacheFoods` sweeps any local row that is `dirty = 0, remote = 1`
 * to match — which is exactly the state a row is in the instant after this
 * file pushes it. A blanket `{}` mock would silently pre-delete the very row
 * `removeFood` is about to be asked to tombstone, and every assertion below
 * would pass for a reason that has nothing to do with `removeFood` at all.
 * `fakeServer()` tracks what has actually been PUT and DELETEd so the pull
 * echoes back a server that could really exist.
 */

import { ApiError, OfflineError } from '../apiError';
import { localFood, localFoods, logFood, removeFood, saveFoodLocally, syncFood } from '../foodLog';
import type { FoodDraft, NewEntry } from '../foodLog';
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
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const USER = 'eater';
const token = async () => 'tok';

function draft(over: Partial<FoodDraft> = {}): FoodDraft {
  return {
    kind: 'food',
    name: 'Pork Shashlik',
    brand: '',
    serving_label: '1 skewer',
    serving_grams: null,
    kcal: 310,
    protein_g: 28,
    carb_g: 4,
    fat_g: 20,
    fibre_g: 1.5,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source: 'user',
    ...over,
  };
}

/**
 * A server that actually remembers what was PUT and DELETEd, keyed by id — see
 * the file doc comment for why a blanket `{}` response cannot be used here.
 */
const serverStore = new Map<string, Record<string, unknown>>();

function fakeServer() {
  mockApi.mockImplementation(
    async (_t: unknown, path: string, init?: { method?: string; body?: string }) => {
      const p = String(path);
      if (p.startsWith('/nutrition/foods/')) {
        const id = p.slice('/nutrition/foods/'.length);
        if (init?.method === 'DELETE') {
          serverStore.delete(id);
          return {};
        }
        if (init?.method === 'PUT') {
          const body = (init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
          const stored = {
            id,
            brand: '',
            serving_grams: null,
            saturated_fat_g: null,
            sugar_g: null,
            added_sugar_g: null,
            sodium_mg: null,
            cholesterol_mg: null,
            source: 'user',
            yield_servings: null,
            items: [],
            ...body,
          };
          serverStore.set(id, stored);
          return stored;
        }
      }
      if (p.startsWith('/nutrition/foods')) {
        return { foods: Array.from(serverStore.values()) };
      }
      return {};
    },
  );
}

async function foodRow(id: string) {
  return db.getFirstAsync<{
    dirty: number;
    remote: number;
    deleted_at: string | null;
    last_error: string | null;
    updated_at: string;
    kcal: number;
  }>(`SELECT dirty, remote, deleted_at, last_error, updated_at, kcal FROM foods WHERE id = ?`, id);
}

function meal(over: Partial<NewEntry> = {}): NewEntry {
  return {
    eaten_on: '2026-08-27',
    meal: 'lunch',
    name: 'Pork Shashlik',
    servings: 1,
    serving_label: '1 skewer',
    kcal: 310,
    protein_g: 28,
    carb_g: 4,
    fat_g: 20,
    fibre_g: 1.5,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    notes: '',
    ...over,
  };
}

async function entryRow(id: string) {
  return db.getFirstAsync<{
    source_food_id: string | null;
    dirty: number;
    last_error: string | null;
    kcal: number;
  }>(`SELECT source_food_id, dirty, last_error, kcal FROM food_entries WHERE id = ?`, id);
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockUuidSeq = 0;
  serverStore.clear();
  mockApi.mockReset();
  fakeServer();
});

describe('removing a saved food locally', () => {
  it('tombstones a row that has never been pushed, because a first push may be in flight', async () => {
    // Freshly saved: `remote = 0, dirty = 1`. Hard-deleting here loses the same
    // race `removeEntry`'s identical test names: the in-flight create succeeds,
    // the CAS in `push` finds nothing to update, and the server keeps a food
    // this device has forgotten, with no tombstone left to ever remove it.
    const id = await saveFoodLocally(USER, draft());
    await removeFood(USER, id);

    const r = await foodRow(id);
    expect(r).not.toBeNull();
    expect(r?.deleted_at).toBeTruthy();
    expect(r?.dirty).toBe(1); // still owed — a delete request has to go out
  });

  it('hard-deletes a row that is neither pushed nor owed', async () => {
    const id = await saveFoodLocally(USER, draft());
    // The state a PERMANENTLY rejected, never-confirmed save leaves behind —
    // `push`'s own `kind === 'permanent'` branch clears `dirty` without ever
    // setting `remote`.
    await db.runAsync(`UPDATE foods SET dirty = 0 WHERE id = ?`, id);
    await removeFood(USER, id);
    expect(await foodRow(id)).toBeNull();
  });

  it('tombstones a row the server has already seen, so it cannot come back on the next pull', async () => {
    const id = await saveFoodLocally(USER, draft());
    await syncFood(USER, token); // confirms it: dirty 0, remote 1
    await removeFood(USER, id);

    const r = await foodRow(id);
    expect(r?.deleted_at).not.toBeNull();
    expect(r?.dirty).toBe(1); // the delete itself is now owed
  });

  it('deleting twice is not an error', async () => {
    const id = await saveFoodLocally(USER, draft());
    await removeFood(USER, id);
    await expect(removeFood(USER, id)).resolves.toBeUndefined();
  });

  it('deleting something already gone is not an error either', async () => {
    await expect(removeFood(USER, 'never-existed')).resolves.toBeUndefined();
  });

  it('disappears from every read immediately, before any push has happened', async () => {
    const id = await saveFoodLocally(USER, draft({ name: 'Traybake' }));
    await removeFood(USER, id);

    expect(await localFood(USER, id)).toBeNull();
    expect(await localFoods(USER, '')).toHaveLength(0);
  });
});

describe('pushing a deleted saved food', () => {
  /**
   * **THE REGRESSION THIS FILE EXISTS TO PREVENT.** `push`'s foods query used
   * to read `WHERE user_id = ? AND dirty = 1 AND deleted_at IS NULL` — the
   * same filter every ordinary READ of this table correctly carries, copied
   * into the one place that must NOT carry it. A tombstoned row is `dirty = 1`
   * and `deleted_at IS NOT NULL`, so that query silently never selected it:
   * `deleteFood` would sit forever with no caller reaching it, and a phone
   * delete would work locally and never leave the phone.
   */
  it('sends the delete request, not a save, for a tombstoned row', async () => {
    const id = await saveFoodLocally(USER, draft());
    await syncFood(USER, token);
    mockApi.mockClear(); // keeps `fakeServer`'s implementation, clears call history

    await removeFood(USER, id);
    const res = await syncFood(USER, token);

    expect(res.pushed).toBe(1);
    expect(res.failed).toBe(0);
    // The delete, then the foods pull that ends every `syncFood` run — never a
    // save for a row on its way out.
    const [, delPath, delInit] = mockApi.mock.calls[0] as [unknown, string, { method: string }];
    expect(delPath).toBe(`/nutrition/foods/${id}`);
    expect(delInit.method).toBe('DELETE');
  });

  it('hard-deletes the local tombstone only once the server confirms', async () => {
    const id = await saveFoodLocally(USER, draft());
    await syncFood(USER, token);
    await removeFood(USER, id);

    await syncFood(USER, token);
    expect(await foodRow(id)).toBeNull();
  });

  it('a permanent rejection of a delete stops owing it, and the tombstone is invisible to every ordinary read', async () => {
    const id = await saveFoodLocally(USER, draft());
    await syncFood(USER, token);
    await removeFood(USER, id);
    mockApi.mockReset().mockRejectedValue(new ApiError('cannot delete', 'invalid_input', 400));

    const res = await syncFood(USER, token);

    expect(res.errorKind).toBe('permanent');
    const r = await foodRow(id);
    expect(r).not.toBeNull(); // the row and its reason survive
    expect(r?.dirty).toBe(0); // but a 4xx will not become a 2xx
    expect(r?.deleted_at).not.toBeNull();
    // Invisible anyway — every ordinary read filters `deleted_at IS NULL`.
    expect(await localFood(USER, id)).toBeNull();
  });

  it('offline stops the queue, and the tombstone stays fully owed to retry', async () => {
    const id = await saveFoodLocally(USER, draft());
    await syncFood(USER, token);
    await removeFood(USER, id);
    mockApi.mockReset().mockRejectedValue(new OfflineError());

    const res = await syncFood(USER, token);

    expect(res.errorKind).toBe('offline');
    const r = await foodRow(id);
    expect(r?.dirty).toBe(1);
    expect(r?.deleted_at).not.toBeNull();
  });

  it('does not resend a save for a row it is about to delete', async () => {
    // A row saved and then immediately deleted before ever syncing carries
    // BOTH a dirty save and, once tombstoned, a dirty delete — but it is one
    // row, and the branch in `push` must pick the delete, not send a PUT and a
    // DELETE for the same id.
    const id = await saveFoodLocally(USER, draft());
    await removeFood(USER, id);
    await syncFood(USER, token);

    const paths = mockApi.mock.calls.map((c) => String(c[1]));
    // The delete, then the foods pull — never a PUT to `/nutrition/foods/{id}`.
    expect(paths[0]).toBe(`/nutrition/foods/${id}`);
    const puts = mockApi.mock.calls.filter(
      (c) => (c[2] as { method?: string } | undefined)?.method === 'PUT',
    );
    expect(puts).toHaveLength(0);
  });
});

/**
 * **THE DATA-LOSS BUG FOUND IN REVIEW (N79, #413).** `push()` sends the foods
 * queue before the entries queue (a documented N114 correctness constraint,
 * ~40 lines above `removeFood` in `foodLog.ts`) — which this ticket's OWN
 * delete branch now cuts against. Log a meal from a saved food, then delete
 * that food, all on one phone, all before the next sync: the entry is still
 * DIRTY and still names the food by id. Left alone, the SAME sync pass sends
 * the food's delete first and the entry's save second, the entry's
 * `source_food_id` now names a row the server has just been told to forget
 * (or, if the food was never synced at all, never had), the composite FK on
 * `nutrition_entries` refuses it with a 23503 the server maps to
 * `invalid_input`, and `classify` reads that 400 as PERMANENT — clearing
 * `dirty` on the ENTRY. The meal's own numbers survive locally (an entry owns
 * its copy), but the entry never reaches the server or any other device
 * again, silently: no error, nothing on the sync screen. Exactly the failure
 * `push()`'s own N114 comment exists to prevent, reachable for the first time
 * from ONE phone rather than two devices racing, because before this ticket
 * nothing on the phone could delete a saved food at all.
 */
describe("severing a dirty entry's reference when its food is deleted", () => {
  it('nulls the reference locally and immediately, before any sync — the entry keeps its own numbers', async () => {
    const foodId = await saveFoodLocally(USER, draft());
    const entryId = await logFood(USER, meal({ source_food_id: foodId }));

    await removeFood(USER, foodId);

    const r = await entryRow(entryId);
    expect(r?.source_food_id).toBeNull();
    expect(r?.kcal).toBe(310); // its own copied numbers, untouched by the food's removal
  });

  it('leaves an ALREADY-SYNCED entry alone — nothing here needs to re-push it', async () => {
    const foodId = await saveFoodLocally(USER, draft());
    const entryId = await logFood(USER, meal({ source_food_id: foodId }));
    await syncFood(USER, token); // confirms both: dirty 0 on the entry too

    await removeFood(USER, foodId);

    // Not touched: this device owes the server nothing about this entry, and
    // the server's own ON DELETE SET NULL already handles its copy.
    const r = await entryRow(entryId);
    expect(r?.source_food_id).toBe(foodId);
    expect(r?.dirty).toBe(0);
  });

  /**
   * The regression test itself. A fake server that behaves EXACTLY like the
   * real one's foreign key: an entry naming a food id the server does not
   * currently hold for this user is refused with the real error shape
   * (`invalid_input`, 400) — see `backend/internal/modules/nutrition/postgres.go`'s
   * `23503` branch, which this fake server's refusal condition mirrors.
   */
  it('pushes the entry successfully afterward, rather than losing it to a permanent rejection', async () => {
    const foodId = await saveFoodLocally(USER, draft());
    await syncFood(USER, token); // the food is confirmed server-side first
    const entryId = await logFood(USER, meal({ source_food_id: foodId }));

    await removeFood(USER, foodId); // tombstones the food AND severs the entry's reference

    mockApi.mockReset().mockImplementation(
      async (_t: unknown, path: string, init?: { method?: string; body?: string }) => {
        const p = String(path);
        if (p.startsWith('/nutrition/foods/') && init?.method === 'DELETE') return {};
        if (p.startsWith('/nutrition/foods')) return { foods: [] };
        if (p.startsWith('/nutrition/entries/') && init?.method === 'PUT') {
          const body = (init.body ? JSON.parse(init.body) : {}) as { source_food_id?: string | null };
          // The real server's FK, reproduced: an entry naming THIS food id is
          // refused, because that food no longer exists for this user.
          if (body.source_food_id === foodId) {
            throw new ApiError('source_food_id does not name a saved food', 'invalid_input', 400);
          }
          return {};
        }
        return {};
      },
    );

    const res = await syncFood(USER, token);

    expect(res.failed).toBe(0);
    const r = await entryRow(entryId);
    expect(r?.dirty).toBe(0);
    expect(r?.last_error).toBeNull();
  });

  it('also covers a food that never reached the server at all', async () => {
    // Created and deleted before ever syncing — the entry's reference is to a
    // food id the server has NEVER heard of, which the FK refuses identically.
    const foodId = await saveFoodLocally(USER, draft());
    const entryId = await logFood(USER, meal({ source_food_id: foodId }));
    await removeFood(USER, foodId);

    const r = await entryRow(entryId);
    expect(r?.source_food_id).toBeNull();
  });
});
