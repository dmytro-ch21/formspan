/**
 * The food log, offline first.
 *
 * ## Why this is an outbox when check-ins are not
 *
 * `body.ts` is online-only and says so deliberately: a check-in is thirty
 * seconds by a scale, at home, once a day. Food fails every clause of that
 * test. It is logged four to six times a day, wherever you happen to eat, and
 * the one place you are reliably NOT is at home by a scale. A lost weigh-in is
 * one point in a 7-day mean and you can weigh again tomorrow; a lost lunch is
 * unrecoverable, and the remaining figure is then wrong for the rest of the day
 * in the direction that makes you eat more.
 *
 * ## Two shapes, and deliberately not a third
 *
 * **Entries push only** — `sequences.ts`'s shape. The phone is where food is
 * logged.
 *
 * **Foods pull as well as push** — `workout_cache`'s shape. Web authors
 * recipes, the phone saves what it just ate, and both must survive the other.
 */

import { randomUUID } from 'expo-crypto';

import { isPermanentRejection, isTransportFailure } from './apiError';
import { getDb, withTransaction } from './db';
import type { Entry, Food, Macros, Meal, Target, TargetView } from './nutrition';
import * as api from './nutritionApi';
import { PREF_TARGETS_FETCHED_AT, readPref, writePref } from './prefs';
import type { TokenGetter } from './useAuthToken';

/**
 * A strictly increasing timestamp, per process.
 *
 * `updated_at` is not decoration — it is the REVISION TOKEN the push's
 * compare-and-swap reads to decide whether an edit landed while a request was
 * in flight. ISO strings have millisecond resolution, so two writes inside the
 * same millisecond produce the *identical* token, the CAS matches, and the
 * second write is silently marked sent: no error, nothing on the sync screen,
 * just a correction the athlete typed that never leaves the phone.
 *
 * That is not hypothetical. The CAS test passed alone and failed in the full
 * suite, which is exactly what a same-millisecond collision looks like — and a
 * device batching a few quick logs hits it for real.
 *
 * Nudging forward by a millisecond keeps the column a sortable ISO string (the
 * pull-side comparison depends on that) while guaranteeing the token changes on
 * every write.
 */
let lastStamp = '';
function stamp(): string {
  let s = new Date().toISOString();
  if (s <= lastStamp) s = new Date(Date.parse(lastStamp) + 1).toISOString();
  lastStamp = s;
  return s;
}

type EntryRow = {
  id: string;
  user_id: string;
  eaten_on: string;
  meal: string;
  name: string;
  servings: number;
  serving_label: string;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
  source_food_id: string | null;
  notes: string;
  updated_at: string;
  deleted_at: string | null;
};

function toEntry(r: EntryRow): Entry {
  return {
    id: r.id,
    eaten_on: r.eaten_on,
    meal: r.meal as Meal,
    name: r.name,
    servings: r.servings,
    serving_label: r.serving_label,
    kcal: r.kcal,
    protein_g: r.protein_g,
    carb_g: r.carb_g,
    fat_g: r.fat_g,
    fibre_g: r.fibre_g,
    source_food_id: r.source_food_id,
    notes: r.notes,
  };
}

export type NewEntry = Macros & {
  eaten_on: string;
  meal: Meal;
  name: string;
  servings: number;
  serving_label: string;
  source_food_id?: string | null;
  notes?: string;
};

/**
 * Log something, locally, now.
 *
 * Returns as soon as SQLite has it; the network is never awaited. The design
 * doc's J2 criterion is that the screen reflects a log immediately, and a
 * spinner between the tap and the number moving is that reward loop broken.
 *
 * `randomUUID` rather than a counter: two devices signed into one account log
 * independently and offline, so the id has to be unique without coordination —
 * and it is the server's idempotency key, so a retry cannot duplicate the row.
 */
export async function logFood(userId: string, input: NewEntry): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  const now = stamp();
  await db.runAsync(
    `INSERT INTO food_entries (
       id, user_id, eaten_on, meal, name, servings, serving_label,
       kcal, protein_g, carb_g, fat_g, fibre_g, source_food_id, notes,
       logged_at, updated_at, dirty, remote)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0)`,
    id, userId, input.eaten_on, input.meal, input.name, input.servings, input.serving_label,
    input.kcal, input.protein_g, input.carb_g, input.fat_g, input.fibre_g,
    input.source_food_id ?? null, input.notes ?? '', now, now,
  );
  if (input.source_food_id) await noteFoodUsed(userId, input.source_food_id, input.eaten_on);
  return id;
}

/** Edit in place. Keeps the id, so the push is still an upsert. */
export async function editEntry(userId: string, id: string, input: NewEntry): Promise<void> {
  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE food_entries
        SET eaten_on = ?, meal = ?, name = ?, servings = ?, serving_label = ?,
            kcal = ?, protein_g = ?, carb_g = ?, fat_g = ?, fibre_g = ?,
            source_food_id = ?, notes = ?, dirty = 1, updated_at = ?, last_error = NULL
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    input.eaten_on, input.meal, input.name, input.servings, input.serving_label,
    input.kcal, input.protein_g, input.carb_g, input.fat_g, input.fibre_g,
    input.source_food_id ?? null, input.notes ?? '', stamp(), id, userId,
  );
  if (r.changes === 0) throw new Error('That entry no longer exists on this device.');
}

/**
 * Remove an entry.
 *
 * A TOMBSTONE for anything the server has seen — otherwise the row reappears on
 * the next pull and the athlete deletes their lunch twice. A row the server has
 * never heard of (`remote = 0`) is hard-deleted here and no request is made.
 */
export async function removeEntry(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ remote: number; dirty: number }>(
    `SELECT remote, dirty FROM food_entries WHERE id = ? AND user_id = ?`, id, userId,
  );
  if (!row) return; // Already gone. Deleting twice is not an error.
  // `dirty` as well as `remote`, and the second half is the one that is easy to
  // miss. A row the server has never seen but whose FIRST push is in flight
  // would be hard-deleted here; that push then succeeds, the CAS finds nothing
  // to update, and the server keeps an entry this device has forgotten — with
  // no tombstone left to ever remove it, so web totals a lunch the athlete
  // deleted. Entries are push-only, so nothing would ever bring it back to be
  // deleted again. A tombstone costs one row and closes the window.
  if (row.remote === 0 && row.dirty === 0) {
    await db.runAsync(`DELETE FROM food_entries WHERE id = ? AND user_id = ?`, id, userId);
    return;
  }
  const now = stamp();
  await db.runAsync(
    `UPDATE food_entries SET deleted_at = ?, dirty = 1, updated_at = ?, last_error = NULL
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    now, now, id, userId,
  );
}

/** One day's entries, tombstones excluded. SQLite only — works offline. */
export async function localEntries(userId: string, on: string): Promise<Entry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<EntryRow>(
    `SELECT * FROM food_entries
      WHERE user_id = ? AND eaten_on = ? AND deleted_at IS NULL
      ORDER BY logged_at, id`,
    userId, on,
  );
  return rows.map(toEntry);
}

/**
 * The distinct days in `[from, to]` that have at least one entry.
 *
 * DISTINCT days, not a row count — the figure it feeds is "how many days you
 * logged", and a day with six entries is one day. Tombstones excluded, so a
 * day whose only entry was deleted correctly stops counting.
 *
 * Deliberately returns the DAYS rather than a number: the caller owns the
 * window arithmetic (`daysLogged`), which is pure and tested, and a count
 * computed in SQL would put that rule in a second place where it could
 * disagree with the first.
 */
export async function localLoggedDays(
  userId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ eaten_on: string }>(
    `SELECT DISTINCT eaten_on FROM food_entries
      WHERE user_id = ? AND eaten_on BETWEEN ? AND ? AND deleted_at IS NULL`,
    userId, from, to,
  );
  return rows.map((r) => r.eaten_on);
}

/**
 * Each day in `[from, to]` that has entries, with what those entries add up to.
 *
 * The stronger half of {@link localLoggedDays}, and it exists because "did you
 * log that day" and "did you log that day *properly*" are different questions.
 * N106's confidence block has to draw a day that was half-logged differently
 * from one that was logged and one that was not touched at all — a single
 * breakfast is not fourteen days of evidence, and a target judged against it is
 * judged against a fiction.
 *
 * Returns the SUM rather than a verdict, for the same reason `localLoggedDays`
 * returns days rather than a count: the rule about what counts as a full day
 * needs a yardstick this query cannot see (the target that was in force), and
 * it lives in `confidence.ts` where it is pure and testable. A CASE expression
 * here would put that rule in a second place, where it could disagree with the
 * first.
 *
 * Tombstones excluded, same as everywhere else here, so a day whose only entry
 * was deleted correctly stops appearing rather than appearing as a zero.
 */
export async function localLoggedDayKcal(
  userId: string,
  from: string,
  to: string,
): Promise<{ day: string; kcal: number }[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ eaten_on: string; kcal: number }>(
    `SELECT eaten_on, SUM(kcal) AS kcal FROM food_entries
      WHERE user_id = ? AND eaten_on BETWEEN ? AND ? AND deleted_at IS NULL
      GROUP BY eaten_on`,
    userId, from, to,
  );
  return rows.map((r) => ({ day: r.eaten_on, kcal: r.kcal ?? 0 }));
}

/**
 * One entry by id, tombstones excluded.
 *
 * Scoped by `user_id` like every other read here. A row is not addressable
 * just because its UUID is known — the id is generated on this device and
 * travels through sync, so treating it as a capability would make a signed-out
 * user's leftover rows readable by the next one.
 */
export async function localEntry(userId: string, id: string): Promise<Entry | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<EntryRow>(
    `SELECT * FROM food_entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    id, userId,
  );
  return row ? toEntry(row) : null;
}

/**
 * Merge a server window of ENTRIES into the local store.
 *
 * **Not wired to anything yet, deliberately, and that is worth stating rather
 * than leaving to be discovered.** `food_entries` is push-only today: nothing
 * on web writes an entry, so there is nothing to pull. This exists and is
 * tested because the moment web can correct a day (N28) the phone needs a merge
 * that does not clobber what it still owes — and writing that merge under
 * pressure, next to a scoped DELETE, is how a sync loses data. Wire it when
 * there is a second writer; until then it is a specification with tests.
 *
 * Never clobbers a row this device still owes, and absent-from-the-server is
 * only evidence of deletion for rows the server KNOWS about — an entry logged
 * here and not yet pushed is absent because the server has never heard of it.
 * That is the trap `cacheWorkouts` documents.
 */
export async function cacheEntries(
  userId: string, from: string, to: string, entries: Entry[],
): Promise<void> {
  const db = await getDb();
  await withTransaction(db, async () => {
    const ids = entries.map((e) => e.id);
    const placeholders = ids.length ? ids.map(() => '?').join(',') : `''`;
    await db.runAsync(
      `DELETE FROM food_entries
        WHERE user_id = ? AND eaten_on BETWEEN ? AND ?
          AND id NOT IN (${placeholders})
          AND dirty = 0 AND remote = 1 AND deleted_at IS NULL`,
      userId, from, to, ...ids,
    );
    const now = stamp();
    for (const e of entries) {
      await db.runAsync(
        `INSERT INTO food_entries (
           id, user_id, eaten_on, meal, name, servings, serving_label,
           kcal, protein_g, carb_g, fat_g, fibre_g, source_food_id, notes,
           logged_at, updated_at, dirty, remote)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)
         ON CONFLICT(id) DO UPDATE SET
           eaten_on = excluded.eaten_on, meal = excluded.meal, name = excluded.name,
           servings = excluded.servings, serving_label = excluded.serving_label,
           kcal = excluded.kcal, protein_g = excluded.protein_g,
           carb_g = excluded.carb_g, fat_g = excluded.fat_g, fibre_g = excluded.fibre_g,
           source_food_id = excluded.source_food_id, notes = excluded.notes, remote = 1
         WHERE food_entries.dirty = 0 AND food_entries.deleted_at IS NULL`,
        e.id, userId, e.eaten_on, e.meal, e.name, e.servings, e.serving_label,
        e.kcal, e.protein_g, e.carb_g, e.fat_g, e.fibre_g,
        e.source_food_id, e.notes, now, now,
      );
    }
  });
}

/**
 * What this device can say about the target on a day, with no network.
 *
 * Returns `unknown` rather than `none` when nothing is cached and no fetch has
 * ever succeeded. That distinction is the whole reason this function exists:
 * both cases have zero rows, and reporting the second as "you have no target"
 * tells an athlete who set one on web to go and set it again.
 */
export async function localTargetView(userId: string, on: string): Promise<TargetView> {
  const db = await getDb();
  // The newest row effective on or before the day — the same rule `targetOn`
  // applies to a server response, so the cache cannot answer differently from
  // the wire.
  const row = await db.getFirstAsync<Target>(
    `SELECT effective_on, kcal, protein_g, carb_g, fat_g, fibre_g
       FROM nutrition_targets
      WHERE user_id = ? AND effective_on <= ?
      ORDER BY effective_on DESC
      LIMIT 1`,
    userId, on,
  );
  if (row) return { state: 'set', target: row };
  const fetched = await readPref(userId, PREF_TARGETS_FETCHED_AT);
  // KNOWN LIMITATION, stated rather than left to be found: the marker is
  // device-global while the cache is filled a day-window at a time. So stepping
  // back, offline, to a day BEFORE the earliest target this device ever
  // fetched reports `none` when the truth is `unknown` — the very sentence this
  // union exists to avoid, in a narrower window. Fixing it properly means
  // recording which windows were fetched, not a single timestamp, and that is
  // not worth the bookkeeping until somebody actually reads old days offline.
  return fetched ? { state: 'none' } : { state: 'unknown' };
}

/**
 * Store a server window of targets.
 *
 * Rows the server did not return for days INSIDE the window are dropped, so a
 * target deleted on web does not linger in the cache and reappear the next time
 * the phone is offline. The carry-in row `listTargets` adds sits before `from`
 * and is therefore untouched by that delete, which is what keeps a target set
 * in March from being swept away by a query about August.
 *
 * The timestamp is written even when `targets` is empty — that is exactly the
 * case it exists to record.
 */
export async function cacheTargets(
  userId: string, from: string, to: string, targets: Target[],
): Promise<void> {
  const db = await getDb();
  await withTransaction(db, async () => {
    const days = targets.map((t) => t.effective_on);
    const placeholders = days.length ? days.map(() => '?').join(',') : `''`;
    await db.runAsync(
      `DELETE FROM nutrition_targets
        WHERE user_id = ? AND effective_on BETWEEN ? AND ?
          AND effective_on NOT IN (${placeholders})`,
      userId, from, to, ...days,
    );
    for (const t of targets) {
      await db.runAsync(
        `INSERT INTO nutrition_targets
           (user_id, effective_on, kcal, protein_g, carb_g, fat_g, fibre_g)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(user_id, effective_on) DO UPDATE SET
           kcal = excluded.kcal, protein_g = excluded.protein_g,
           carb_g = excluded.carb_g, fat_g = excluded.fat_g,
           fibre_g = excluded.fibre_g`,
        userId, t.effective_on, t.kcal, t.protein_g, t.carb_g, t.fat_g, t.fibre_g,
      );
    }
  });
  await writePref(userId, PREF_TARGETS_FETCHED_AT, stamp());
}

export async function localFoods(userId: string, q = ''): Promise<Food[]> {
  const db = await getDb();
  // `%` and `_` are LIKE metacharacters, so a search for "100%" would otherwise
  // match every saved food. The backend's own search escapes them for the same
  // reason; two search surfaces disagreeing about what a query means is worse
  // than either being wrong.
  const escaped = q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped}%`;
  return db.getAllAsync<Food>(
    `SELECT id, kind, name, brand, serving_label, serving_grams,
            kcal, protein_g, carb_g, fat_g, fibre_g
       FROM foods
      WHERE user_id = ? AND deleted_at IS NULL AND lower(name) LIKE ? ESCAPE '\\'
      ORDER BY lower(name)`,
    userId, like,
  );
}

/** Save a food locally: owed to the server, and usable immediately. */
export async function saveFoodLocally(
  userId: string, input: Omit<Food, 'id'> & { id?: string },
): Promise<string> {
  const db = await getDb();
  const id = input.id ?? randomUUID();
  const now = stamp();
  await db.runAsync(
    `INSERT INTO foods (
       id, user_id, kind, name, brand, serving_label, serving_grams,
       kcal, protein_g, carb_g, fat_g, fibre_g, created_at, updated_at,
       dirty, remote, cached_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind, name = excluded.name, brand = excluded.brand,
       serving_label = excluded.serving_label, serving_grams = excluded.serving_grams,
       kcal = excluded.kcal, protein_g = excluded.protein_g, carb_g = excluded.carb_g,
       fat_g = excluded.fat_g, fibre_g = excluded.fibre_g,
       dirty = 1, updated_at = excluded.updated_at, last_error = NULL`,
    id, userId, input.kind, input.name, input.brand, input.serving_label, input.serving_grams,
    input.kcal, input.protein_g, input.carb_g, input.fat_g, input.fibre_g, now, now, now,
  );
  return id;
}

/**
 * Remember a food was just used, for the quick-add ranking.
 *
 * Local-only and never pushed: this is the device's reading of its own log. It
 * sets no `dirty`, deliberately — a usage count is not something the server
 * needs, and marking the row owed would put a pointless request in the outbox
 * after every single log.
 */
async function noteFoodUsed(userId: string, foodId: string, on: string): Promise<void> {
  const db = await getDb();
  // Scoped like every read in this file. `source_food_id` arrives from a
  // caller, so an unscoped UPDATE would let one athlete's log bump another's
  // counters on a shared device — improbable with UUIDs, and still the rule
  // this module states: an id is provenance, never a capability.
  await db.runAsync(
    `UPDATE foods SET use_count = use_count + 1, last_used_at = ?
      WHERE id = ? AND user_id = ?`,
    on, foodId, userId,
  );
}

/** Quick-add candidates with their per-slot usage. Pure SQLite, no network. */
export async function recentsFor(
  userId: string, meal: Meal,
): Promise<{ food: Food; uses: number; lastUsedOn: string | null }[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Food & { uses: number; last_used_on: string | null }>(
    `SELECT f.id, f.kind, f.name, f.brand, f.serving_label, f.serving_grams,
            f.kcal, f.protein_g, f.carb_g, f.fat_g, f.fibre_g,
            COUNT(e.id) AS uses, MAX(e.eaten_on) AS last_used_on
       FROM foods f
       JOIN food_entries e
         ON e.source_food_id = f.id AND e.user_id = f.user_id
        AND e.meal = ? AND e.deleted_at IS NULL
      WHERE f.user_id = ? AND f.deleted_at IS NULL
      GROUP BY f.id
      ORDER BY uses DESC`,
    meal, userId,
  );
  return rows.map((r) => ({
    food: {
      id: r.id, kind: r.kind, name: r.name, brand: r.brand,
      serving_label: r.serving_label, serving_grams: r.serving_grams,
      kcal: r.kcal, protein_g: r.protein_g, carb_g: r.carb_g, fat_g: r.fat_g, fibre_g: r.fibre_g,
    },
    uses: r.uses,
    lastUsedOn: r.last_used_on,
  }));
}

export type FoodSyncResult = {
  pushed: number;
  failed: number;
  error?: string;
  errorKind?: 'offline' | 'permanent' | 'transient';
};

function classify(err: unknown): 'offline' | 'permanent' | 'transient' {
  if (isTransportFailure(err)) return 'offline';
  if (isPermanentRejection(err)) return 'permanent';
  return 'transient';
}

function worseKind(
  a: FoodSyncResult['errorKind'], b: FoodSyncResult['errorKind'],
): FoodSyncResult['errorKind'] {
  if (a === 'offline' || b === 'offline') return 'offline';
  if (a === 'permanent' || b === 'permanent') return 'permanent';
  return a ?? b;
}

let inFlight: Promise<FoodSyncResult> | null = null;

/** Serialised, like every other outbox here: two passes would race each other. */
export function syncFood(userId: string, getToken: TokenGetter): Promise<FoodSyncResult> {
  const run = (inFlight ?? Promise.resolve(null)).catch(() => null).then(() => push(userId, getToken));
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}

async function push(userId: string, getToken: TokenGetter): Promise<FoodSyncResult> {
  const db = await getDb();
  const result: FoodSyncResult = { pushed: 0, failed: 0 };
  /** Set once the connection is gone, so the second queue is not even read. */
  let stalled = false;

  const rows = await db.getAllAsync<EntryRow & { remote: number }>(
    `SELECT * FROM food_entries WHERE user_id = ? AND dirty = 1 ORDER BY logged_at`, userId,
  );

  for (const r of rows) {
    try {
      if (r.deleted_at) {
        await api.deleteEntry(getToken, r.id);
        // Hard-delete only once the server confirms. Until then the tombstone
        // IS the record that a delete is owed.
        await db.runAsync(`DELETE FROM food_entries WHERE id = ? AND user_id = ?`, r.id, userId);
      } else {
        await api.saveEntry(getToken, r.id, {
          eaten_on: r.eaten_on, meal: r.meal as Meal, name: r.name,
          servings: r.servings, serving_label: r.serving_label,
          kcal: r.kcal, protein_g: r.protein_g, carb_g: r.carb_g, fat_g: r.fat_g,
          fibre_g: r.fibre_g, source_food_id: r.source_food_id, notes: r.notes,
        });
        // COMPARE-AND-SWAP on updated_at: an edit that landed while this push
        // was in flight leaves the row dirty for the next pass rather than
        // being silently marked sent.
        await db.runAsync(
          `UPDATE food_entries SET dirty = 0, remote = 1, last_error = NULL
            WHERE id = ? AND user_id = ? AND updated_at = ? AND deleted_at IS NULL`,
          r.id, userId, r.updated_at,
        );
      }
      result.pushed += 1;
    } catch (err) {
      const kind = classify(err);
      const message = err instanceof Error ? err.message : 'could not be sent';
      result.failed += 1;
      result.error = result.error ?? message;
      result.errorKind = worseKind(result.errorKind, kind);
      // THE SAME COMPARE-AND-SWAP AS THE SUCCESS PATH, and for the same reason.
      // Without it, an edit made while this push was in flight is stomped by
      // the failure of the payload that PRECEDED it: `dirty` is cleared on a
      // row that is now newer than anything the server has, and the correction
      // never leaves the phone. The success branch guarded this from the start;
      // the failure branch did not, which is the quieter half of one bug.
      await db.runAsync(
        `UPDATE food_entries SET last_error = ?
          WHERE id = ? AND user_id = ? AND updated_at = ?`,
        message, r.id, userId, r.updated_at,
      );
      if (kind === 'permanent') {
        // A 4xx will not become a 2xx. Stop owing it; keep the row and the
        // reason so the sync screen can explain it — with one honest exception:
        // a rejected TOMBSTONE keeps both and is invisible to every read, all
        // of which filter `deleted_at IS NULL`. Near-unreachable, since the
        // delete is 204-always server-side, but the sentence above is not true
        // of that case and should not pretend to be.
        await db.runAsync(
          `UPDATE food_entries SET dirty = 0
            WHERE id = ? AND user_id = ? AND updated_at = ?`,
          r.id, userId, r.updated_at,
        );
      }
      if (kind === 'offline') {
        // No point walking the queue with no connection — and no point
        // starting the SECOND queue either, which a bare `break` would do.
        stalled = true;
        break;
      }
    }
  }

  const foods = stalled
    ? []
    : await db.getAllAsync<Food & { updated_at: string }>(
    `SELECT id, kind, name, brand, serving_label, serving_grams,
            kcal, protein_g, carb_g, fat_g, fibre_g, updated_at
       FROM foods WHERE user_id = ? AND dirty = 1 AND deleted_at IS NULL`,
    userId,
  );
  for (const f of foods) {
    try {
      await api.saveFood(getToken, f.id, {
        kind: f.kind, name: f.name, brand: f.brand,
        serving_label: f.serving_label, serving_grams: f.serving_grams,
        kcal: f.kcal, protein_g: f.protein_g, carb_g: f.carb_g, fat_g: f.fat_g, fibre_g: f.fibre_g,
      });
      await db.runAsync(
        `UPDATE foods SET dirty = 0, remote = 1, last_error = NULL
          WHERE id = ? AND user_id = ? AND updated_at = ?`,
        f.id, userId, f.updated_at,
      );
      result.pushed += 1;
    } catch (err) {
      const kind = classify(err);
      const message = err instanceof Error ? err.message : 'could not be sent';
      result.failed += 1;
      result.error = result.error ?? message;
      result.errorKind = worseKind(result.errorKind, kind);
      await db.runAsync(
        `UPDATE foods SET last_error = ? WHERE id = ? AND user_id = ? AND updated_at = ?`,
        message, f.id, userId, f.updated_at,
      );
      if (kind === 'permanent') {
        await db.runAsync(
          `UPDATE foods SET dirty = 0 WHERE id = ? AND user_id = ? AND updated_at = ?`,
          f.id, userId, f.updated_at,
        );
      }
      if (kind === 'offline') break;
    }
  }

  // The foods PULL. `foods` is the half of this outbox that is not push-only —
  // web authors recipes and the phone saves what it just ate, and both have to
  // survive the other, which is why this table copies `workout_cache`'s shape
  // rather than `sequences.ts`'s. Runs last and only while the connection held
  // — NOT only when every push succeeded: after a permanent rejection the
  // server's copy IS the truth, because the local values are the ones it
  // refused, so the upsert takes them and clears the now-meaningless
  // `last_error`. What it must never overwrite is a row still owed, which is
  // what the `dirty = 0` guard in `cacheFoods` is for.
  if (!stalled && result.errorKind !== 'offline') {
    try {
      await cacheFoods(userId, await api.listFoods(getToken));
    } catch (err) {
      // A failed pull is not a failed sync — everything owed has already gone,
      // and the recents list is built from local entries and does not need
      // this. But it is RECORDED rather than swallowed: the first version of
      // this catch hid a NOT NULL violation that made the pull incapable of
      // writing a single row, in production, silently and forever. A branch
      // that cannot fail is a branch nobody finds out about.
      result.error = result.error ?? (err instanceof Error ? err.message : 'pull failed');
    }
  }

  return result;
}

/**
 * Merge the server's foods in, never over a row this device still owes.
 *
 * The `dirty = 0` guard is the whole of it: a food edited here and not yet
 * pushed must win against the copy the server still holds, or the athlete's
 * correction is undone by the sync that was meant to carry it. Absent-from-the
 * server does NOT delete, because a food saved here and not yet pushed is
 * absent for the ordinary reason that the server has never heard of it.
 */
async function cacheFoods(userId: string, foods: Food[]): Promise<void> {
  const db = await getDb();
  await withTransaction(db, async () => {
    const now = stamp();
    const ids = foods.map((f) => f.id);
    const placeholders = ids.length ? ids.map(() => '?').join(',') : `''`;
    // A food dropped on the server goes here too — but ONLY one this device has
    // no stake in. `remote = 1 AND dirty = 0` is the whole guard: a food saved
    // here and not yet pushed is absent from the server for the ordinary reason
    // that it has never heard of it, and deleting it would throw away the
    // athlete's work. Same rule `cacheEntries` states.
    await db.runAsync(
      `DELETE FROM foods
        WHERE user_id = ? AND id NOT IN (${placeholders})
          AND dirty = 0 AND remote = 1 AND deleted_at IS NULL`,
      userId, ...ids,
    );
    for (const f of foods) {
      await db.runAsync(
        `INSERT INTO foods (
           id, user_id, kind, name, brand, serving_label, serving_grams,
           kcal, protein_g, carb_g, fat_g, fibre_g,
           created_at, updated_at, cached_at, dirty, remote)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, brand = excluded.brand,
           serving_label = excluded.serving_label, serving_grams = excluded.serving_grams,
           kcal = excluded.kcal, protein_g = excluded.protein_g,
           carb_g = excluded.carb_g, fat_g = excluded.fat_g, fibre_g = excluded.fibre_g,
           cached_at = excluded.cached_at, remote = 1,
           -- The row now holds the server's numbers, so a reason that described
           -- the local ones is no longer about anything in it.
           last_error = NULL
         WHERE foods.dirty = 0 AND foods.deleted_at IS NULL`,
        f.id, userId, f.kind, f.name, f.brand, f.serving_label, f.serving_grams,
        f.kcal, f.protein_g, f.carb_g, f.fat_g, f.fibre_g, now, now, now,
      );
    }
  });
}

/**
 * What is owed, across BOTH tables.
 *
 * `sync.ts` gates its whole machinery on this number — a timer is refused at
 * zero and the foreground trigger declines to run — so a count that missed one
 * table would be a sync that never fires with nothing on screen explaining why.
 */
export async function pendingFoodCount(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM food_entries WHERE user_id = ? AND dirty = 1)
          + (SELECT COUNT(*) FROM foods WHERE user_id = ? AND dirty = 1) AS n`,
    userId, userId,
  );
  return row?.n ?? 0;
}
