/**
 * N533/#964 — "some foods from AI generation don't get saved".
 *
 * The reproduction, on the phone's own store: a drafted food is written to
 * the outbox, the server refuses it with a 400, `classify` reads that as
 * permanent and clears `dirty`, and the row lives on this phone only — with
 * the entry that named it refused next on the foreign key and cleared the
 * same way. Two local ghosts, both gone on a reinstall, nothing on screen.
 *
 * Runs against a REAL SQLite database through `migratedFixture()`, like every
 * other outbox test here, so what is asserted is what the shipped schema and
 * queries do rather than what a regex over a query string would suggest.
 *
 * **The fake server's two refusals are not invented.** `serving_label must be
 * between 1 and 40 characters` is what `Food.Validate` and `Entry.Validate`
 * return for a label over 40 runes — measured against the real Go validator
 * in `backend/internal/modules/nutrition/estimate_fit_test.go`
 * (`TestAnUnfittedLongLabelIsWhatTheServerRefuses`), with `longLabel` below
 * being that test's own constant. `source_food_id does not name a saved food`
 * is the message `postgres.go` maps a 23503 on the composite foreign key to,
 * quoted by `savedFoods.test.ts` already. A fake that returned 200 for
 * everything would confirm whatever this file believed; these return what
 * the server returns.
 */

import { ApiError } from '../apiError';
import {
  DEFAULT_SERVING_LABEL,
  fitServingLabel,
  itemToEntry,
  savedFoodFrom,
  SERVING_LABEL_MAX_RUNES,
  type EstimatedItem,
} from '../estimateApi';
import {
  foodSyncProblems,
  foodSyncState,
  localFood,
  logFood,
  removeFood,
  saveFoodLocally,
  syncFood,
  type FoodDraft,
  type NewEntry,
} from '../foodLog';
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

/** The Go test's own constant: 68 runes, well over the 40 a saved food accepts. */
const longLabel = '1 restaurant bowl with rice, beans, salsa and sour cream (about 400 g)';

const REFUSED_LABEL = 'serving_label must be between 1 and 40 characters';
const REFUSED_FK = 'source_food_id does not name a saved food';

function draft(over: Partial<FoodDraft> = {}): FoodDraft {
  return {
    kind: 'food',
    name: 'Burrito bowl',
    brand: '',
    serving_label: '1 bowl',
    serving_grams: null,
    kcal: 720,
    protein_g: 30,
    carb_g: 80,
    fat_g: 28,
    fibre_g: 9,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source: 'ai',
    ...over,
  };
}

function meal(over: Partial<NewEntry> = {}): NewEntry {
  return {
    eaten_on: '2026-09-08',
    meal: 'lunch',
    name: 'Burrito bowl',
    servings: 1,
    serving_label: '1 bowl',
    kcal: 720,
    protein_g: 30,
    carb_g: 80,
    fat_g: 28,
    fibre_g: 9,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    notes: '',
    ...over,
  };
}

function item(over: Partial<EstimatedItem> = {}): EstimatedItem {
  return {
    name: 'Burrito bowl',
    serving_label: longLabel,
    servings: 1,
    kcal: 720,
    protein_g: 30,
    carb_g: 80,
    fat_g: 28,
    fibre_g: 9,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    portion_confidence: 'medium',
    assumption: '',
    ...over,
  };
}

/**
 * A server that validates the way the real one does for the two rules this
 * ticket is about, and remembers what it accepted so the foreign-key refusal
 * is about state rather than about a flag.
 */
const serverFoods = new Map<string, Record<string, unknown>>();
const serverEntries = new Map<string, Record<string, unknown>>();
const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
/** When set, the foods PULL fails — the one window in which a refused edit's reason survives locally. */
let listFails = false;

function fakeServer() {
  mockApi.mockImplementation(
    async (_t: unknown, path: string, init?: { method?: string; body?: string }) => {
      const p = String(path);
      const method = init?.method ?? 'GET';
      const body = (init?.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
      calls.push({ method, path: p, body });
      if (p.startsWith('/nutrition/foods/')) {
        const id = p.slice('/nutrition/foods/'.length);
        if (method === 'DELETE') {
          serverFoods.delete(id);
          return {};
        }
        if (method === 'PUT') {
          const label = String(body.serving_label ?? '').trim();
          if (label.length < 1 || Array.from(label).length > 40) {
            throw new ApiError(REFUSED_LABEL, 'invalid_input', 400);
          }
          const stored = { id, yield_servings: null, items: [], ...body };
          serverFoods.set(id, stored);
          return stored;
        }
      }
      if (p.startsWith('/nutrition/foods')) {
        if (listFails) throw new ApiError('list is down', 'internal', 500);
        return { foods: Array.from(serverFoods.values()) };
      }
      if (p.startsWith('/nutrition/entries/')) {
        const id = p.slice('/nutrition/entries/'.length);
        if (method === 'DELETE') {
          serverEntries.delete(id);
          return {};
        }
        if (method === 'PUT') {
          const label = String(body.serving_label ?? '').trim();
          if (label.length < 1 || Array.from(label).length > 40) {
            throw new ApiError(REFUSED_LABEL, 'invalid_input', 400);
          }
          if (body.source_food_id != null && !serverFoods.has(String(body.source_food_id))) {
            throw new ApiError(REFUSED_FK, 'invalid_input', 400);
          }
          serverEntries.set(id, { id, ...body });
          return { id, ...body };
        }
      }
      if (p.startsWith('/nutrition/entries')) return { entries: Array.from(serverEntries.values()) };
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
    serving_label: string;
  }>(`SELECT dirty, remote, deleted_at, last_error, serving_label FROM foods WHERE id = ?`, id);
}

async function entryRow(id: string) {
  return db.getFirstAsync<{
    source_food_id: string | null;
    dirty: number;
    remote: number;
    last_error: string | null;
  }>(`SELECT source_food_id, dirty, remote, last_error FROM food_entries WHERE id = ?`, id);
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockUuidSeq = 0;
  serverFoods.clear();
  serverEntries.clear();
  calls.length = 0;
  listFails = false;
  mockApi.mockReset();
  fakeServer();
});

describe('fitting a drafted item to what the server accepts', () => {
  it('cuts a serving label the server would refuse down to one it accepts', () => {
    expect(Array.from(longLabel).length).toBeGreaterThan(SERVING_LABEL_MAX_RUNES);
    const food = savedFoodFrom(item());
    const entry = itemToEntry(item());
    expect(Array.from(food.serving_label).length).toBeLessThanOrEqual(SERVING_LABEL_MAX_RUNES);
    expect(Array.from(entry.serving_label).length).toBeLessThanOrEqual(SERVING_LABEL_MAX_RUNES);
    // The cut is a prefix of what the model said, not a substitute for it.
    expect(longLabel.startsWith(food.serving_label)).toBe(true);
    expect(food.serving_label).not.toMatch(/\s$/);
  });

  it('gives an empty label the honest default rather than leaving it empty', () => {
    expect(savedFoodFrom(item({ serving_label: '' })).serving_label).toBe(DEFAULT_SERVING_LABEL);
    expect(itemToEntry(item({ serving_label: '   ' })).serving_label).toBe(DEFAULT_SERVING_LABEL);
  });

  it('counts characters, not bytes, and never splits one', () => {
    const cyrillic = 'тарелка '.repeat(8);
    const fitted = fitServingLabel(cyrillic);
    expect(Array.from(fitted).length).toBeLessThanOrEqual(SERVING_LABEL_MAX_RUNES);
    // A surrogate pair at the cut point must survive whole.
    const emoji = '🥗'.repeat(SERVING_LABEL_MAX_RUNES + 3);
    const fittedEmoji = fitServingLabel(emoji);
    expect(Array.from(fittedEmoji).length).toBe(SERVING_LABEL_MAX_RUNES);
    expect(fittedEmoji).toBe('🥗'.repeat(SERVING_LABEL_MAX_RUNES));
  });

  it('leaves a label the server accepts alone', () => {
    expect(savedFoodFrom(item({ serving_label: '1 skewer' })).serving_label).toBe('1 skewer');
  });
});

describe('a food the server refuses', () => {
  /**
   * THE BUG, END TO END. A label over the limit reaches the outbox (any
   * writer can put one there — an older build, a manual entry, a server that
   * predates the fit), the push is refused, and before this ticket the entry
   * naming the food was refused next and cleared the same way: the day's
   * lunch existed on one phone and nowhere else.
   */
  it('does not take the meal logged against it down with it', async () => {
    const foodId = await saveFoodLocally(USER, draft({ serving_label: longLabel }));
    const entryId = await logFood(USER, meal({ source_food_id: foodId }));

    const result = await syncFood(USER, token);

    // The food: refused, kept, no longer owed, with the server's reason.
    const f = await foodRow(foodId);
    expect(f).toMatchObject({ dirty: 0, remote: 0, last_error: REFUSED_LABEL });
    expect(serverFoods.has(foodId)).toBe(false);

    // The entry: REACHED THE SERVER, without the link to a row it never had.
    const sent = calls.find((c) => c.method === 'PUT' && c.path === `/nutrition/entries/${entryId}`);
    expect(sent).toBeDefined();
    expect(sent!.body.source_food_id).toBeNull();
    expect(serverEntries.has(entryId)).toBe(true);
    expect(await entryRow(entryId)).toMatchObject({ dirty: 0, remote: 1, last_error: null, source_food_id: null });

    // And the result is honest about the half that failed.
    expect(result.failed).toBe(1);
    expect(result.errorKind).toBe('permanent');
  });

  it('is reported, with the reason, as existing on this phone only', async () => {
    const foodId = await saveFoodLocally(USER, draft({ serving_label: longLabel }));
    await syncFood(USER, token);

    const problems = await foodSyncProblems(USER);
    expect(problems.get(foodId)).toEqual({ reason: REFUSED_LABEL, onServer: false });
    expect(await foodSyncState(USER, foodId)).toEqual({ unsynced: true, owed: false, rejected: REFUSED_LABEL });
  });

  it('is owed again, and no longer a problem, once it is edited', async () => {
    const foodId = await saveFoodLocally(USER, draft({ serving_label: longLabel }));
    await syncFood(USER, token);
    expect((await foodSyncProblems(USER)).has(foodId)).toBe(true);

    await saveFoodLocally(USER, draft({ id: foodId, serving_label: '1 bowl' }));
    expect((await foodSyncProblems(USER)).has(foodId)).toBe(false);
    expect((await foodSyncState(USER, foodId))?.rejected).toBeNull();

    await syncFood(USER, token);
    expect(await foodRow(foodId)).toMatchObject({ dirty: 0, remote: 1, last_error: null });
    expect(serverFoods.has(foodId)).toBe(true);
  });

  it('is not reported while it is merely waiting for signal', async () => {
    const foodId = await saveFoodLocally(USER, draft());
    // A transient failure: still owed, and the next pass will retry.
    mockApi.mockRejectedValueOnce(new ApiError('try later', 'internal', 503));
    await syncFood(USER, token);
    expect(await foodRow(foodId)).toMatchObject({ dirty: 1, last_error: 'try later' });
    expect((await foodSyncProblems(USER)).has(foodId)).toBe(false);
    expect((await foodSyncState(USER, foodId))?.rejected).toBeNull();
  });
});

describe('a refused EDIT of a food the server already holds', () => {
  /**
   * The severing above is ONLY for a food the server has never accepted. A
   * food it already holds is one an entry may still name there — the refused
   * edit leaves the earlier version in place — so the link must survive.
   * Mutation target: applying the sever to every permanent rejection makes
   * this go red on `source_food_id`.
   */
  it('keeps the entry pointing at the version the server has', async () => {
    const foodId = await saveFoodLocally(USER, draft());
    await syncFood(USER, token);
    expect(await foodRow(foodId)).toMatchObject({ remote: 1 });

    await saveFoodLocally(USER, draft({ id: foodId, serving_label: longLabel }));
    const entryId = await logFood(USER, meal({ source_food_id: foodId }));
    await syncFood(USER, token);

    const sent = calls.find((c) => c.method === 'PUT' && c.path === `/nutrition/entries/${entryId}`);
    expect(sent!.body.source_food_id).toBe(foodId);
    expect(await entryRow(entryId)).toMatchObject({ remote: 1, source_food_id: foodId });
    expect(serverEntries.has(entryId)).toBe(true);
  });

  /**
   * What the athlete SEES after a refused edit is the existing design, not
   * this ticket's: the pull that ends every connected pass takes the server's
   * copy over any `dirty = 0` row and clears `last_error` — "after a permanent
   * rejection the server's copy IS the truth". So the refused correction is
   * reverted to the earlier version on this phone, silently, and the row is
   * NOT reported as a problem. Pinned here so the limit of the surfacing is
   * written down: the "earlier version" copy only appears in the window
   * below, where that pull fails. Whether a reverted edit should say so is
   * an open item, recorded in history.md.
   */
  it('is reverted to the server\'s version by the pull, and is then no longer reported', async () => {
    const foodId = await saveFoodLocally(USER, draft());
    await syncFood(USER, token);
    await saveFoodLocally(USER, draft({ id: foodId, serving_label: longLabel }));
    await syncFood(USER, token);

    expect(await foodRow(foodId)).toMatchObject({ dirty: 0, remote: 1, last_error: null, serving_label: '1 bowl' });
    expect((await foodSyncProblems(USER)).has(foodId)).toBe(false);
  });

  it('is reported, as a refused change to a food the account still has, while the pull is failing', async () => {
    const foodId = await saveFoodLocally(USER, draft());
    await syncFood(USER, token);
    await saveFoodLocally(USER, draft({ id: foodId, serving_label: longLabel }));
    listFails = true;
    await syncFood(USER, token);

    expect(await foodRow(foodId)).toMatchObject({ dirty: 0, remote: 1, last_error: REFUSED_LABEL });
    expect((await foodSyncProblems(USER)).get(foodId)).toEqual({ reason: REFUSED_LABEL, onServer: true });
    expect(await foodSyncState(USER, foodId)).toEqual({ unsynced: false, owed: false, rejected: REFUSED_LABEL });
  });
});

describe('confirming a regenerate over a food deleted in the meantime', () => {
  /**
   * The issue's hypothesis 2. A regenerate carries the id of the food it
   * replaces; if that row is a tombstone by the time the draft is confirmed,
   * an upsert that leaves `deleted_at` alone writes the fresh numbers into a
   * row every read filters out and then pushes a DELETE for it.
   */
  it('brings the food back rather than writing into its tombstone', async () => {
    const foodId = await saveFoodLocally(USER, draft());
    await syncFood(USER, token);
    await removeFood(USER, foodId);
    expect(await localFood(USER, foodId)).toBeNull();
    expect((await foodRow(foodId))?.deleted_at).not.toBeNull();

    await saveFoodLocally(USER, draft({ id: foodId, kcal: 650 }));

    expect(await localFood(USER, foodId)).toMatchObject({ kcal: 650 });
    calls.length = 0;
    await syncFood(USER, token);
    const sent = calls.filter((c) => c.path === `/nutrition/foods/${foodId}`).map((c) => c.method);
    expect(sent).toEqual(['PUT']);
    expect(serverFoods.get(foodId)).toMatchObject({ kcal: 650 });
  });
});
