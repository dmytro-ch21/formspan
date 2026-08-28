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
 * **Entries push only IN STEADY STATE** — `sequences.ts`'s shape. The phone is
 * where food is logged, and nothing on web writes an entry, so there is
 * nothing to routinely pull. The one exception is `push()`'s fresh-install
 * backfill (N428, #686): a reinstall starts `food_entries` at zero, and
 * without a ONE-TIME pull of history the server already has, every meal
 * logged before that install would be permanently invisible on the new
 * device — the routine push/no-pull rule above still holds once that backfill
 * has run.
 *
 * **Foods pull as well as push, routinely** — `workout_cache`'s shape. Web
 * authors recipes, the phone saves what it just ate, and both must survive
 * the other.
 */

import { randomUUID } from 'expo-crypto';

import { isPermanentRejection, isTransportFailure, retryAfterOf } from './apiError';
import { addDays, dayString } from './calendar';
import { getDb, withTransaction } from './db';
import type { Entry, Food, Macros, Meal, RecipeItem, Target, TargetView } from './nutrition';
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
  saturated_fat_g: number | null;
  sugar_g: number | null;
  added_sugar_g: number | null;
  sodium_mg: number | null;
  cholesterol_mg: number | null;
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
    saturated_fat_g: r.saturated_fat_g,
    sugar_g: r.sugar_g,
    added_sugar_g: r.added_sugar_g,
    sodium_mg: r.sodium_mg,
    cholesterol_mg: r.cholesterol_mg,
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
       kcal, protein_g, carb_g, fat_g, fibre_g,
       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
       source_food_id, notes, logged_at, updated_at, dirty, remote)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0)`,
    id, userId, input.eaten_on, input.meal, input.name, input.servings, input.serving_label,
    input.kcal, input.protein_g, input.carb_g, input.fat_g, input.fibre_g,
    input.saturated_fat_g, input.sugar_g, input.added_sugar_g, input.sodium_mg, input.cholesterol_mg,
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
            saturated_fat_g = ?, sugar_g = ?, added_sugar_g = ?, sodium_mg = ?, cholesterol_mg = ?,
            source_food_id = ?, notes = ?, dirty = 1, updated_at = ?, last_error = NULL
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    input.eaten_on, input.meal, input.name, input.servings, input.serving_label,
    input.kcal, input.protein_g, input.carb_g, input.fat_g, input.fibre_g,
    input.saturated_fat_g, input.sugar_g, input.added_sugar_g, input.sodium_mg, input.cholesterol_mg,
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
 * **Wired to exactly one caller as of N428 (#686): `push()`'s fresh-install
 * backfill below, and nothing routine.** `food_entries` is still push-only in
 * steady state — nothing on web writes an entry, so there is still nothing to
 * routinely pull. This was written and tested well before that backfill
 * existed, against the day web can correct an entry (N28) and the day a fresh
 * install needs a merge that does not clobber what it still owes; N428 is the
 * second of those two days, not the first — a web writer still has no caller
 * here.
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
           kcal, protein_g, carb_g, fat_g, fibre_g,
           saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
           source_food_id, notes, logged_at, updated_at, dirty, remote)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)
         ON CONFLICT(id) DO UPDATE SET
           eaten_on = excluded.eaten_on, meal = excluded.meal, name = excluded.name,
           servings = excluded.servings, serving_label = excluded.serving_label,
           kcal = excluded.kcal, protein_g = excluded.protein_g,
           carb_g = excluded.carb_g, fat_g = excluded.fat_g, fibre_g = excluded.fibre_g,
           saturated_fat_g = excluded.saturated_fat_g, sugar_g = excluded.sugar_g,
           added_sugar_g = excluded.added_sugar_g, sodium_mg = excluded.sodium_mg,
           cholesterol_mg = excluded.cholesterol_mg,
           source_food_id = excluded.source_food_id, notes = excluded.notes, remote = 1
         WHERE food_entries.dirty = 0 AND food_entries.deleted_at IS NULL`,
        e.id, userId, e.eaten_on, e.meal, e.name, e.servings, e.serving_label,
        e.kcal, e.protein_g, e.carb_g, e.fat_g, e.fibre_g,
        e.saturated_fat_g, e.sugar_g, e.added_sugar_g, e.sodium_mg, e.cholesterol_mg,
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

/**
 * The columns every read of `foods` selects. One constant rather than five
 * copies, because this list has already been the place a new column was
 * forgotten — a food read through a SELECT that predates it loses the value
 * silently, and an empty recipe looks like an empty recipe rather than a bug.
 */
const FOOD_COL_NAMES = [
  'id', 'kind', 'name', 'brand', 'serving_label', 'serving_grams',
  'kcal', 'protein_g', 'carb_g', 'fat_g', 'fibre_g',
  'saturated_fat_g', 'sugar_g', 'added_sugar_g', 'sodium_mg', 'cholesterol_mg',
  'source', 'yield_servings', 'items',
] as const;

const FOOD_COLS = FOOD_COL_NAMES.join(', ');

/** The same list against an aliased table, for the one read that joins. */
const foodColsFrom = (alias: string) => FOOD_COL_NAMES.map((c) => `${alias}.${c}`).join(', ');

/** How a `foods` row arrives: `items` is the TEXT column, not the array. */
type FoodRow = Omit<Food, 'items'> & { items: string | null };

/**
 * Turn a stored row into a `Food`.
 *
 * **A malformed or absent `items` becomes `[]`, never a throw.** The column is
 * NOT NULL DEFAULT '[]' so neither should happen — but this is the read path
 * for every saved food on the device, and a single unparseable row taking the
 * whole quick-add list down with it is a far worse failure than one recipe
 * showing no ingredients. The parse is defensive precisely because the write
 * side is the thing under test.
 */
function hydrate(row: FoodRow): Food {
  let items: RecipeItem[] = [];
  if (row.items) {
    try {
      const parsed: unknown = JSON.parse(row.items);
      if (Array.isArray(parsed)) items = parsed as RecipeItem[];
    } catch {
      items = [];
    }
  }
  return { ...row, yield_servings: row.yield_servings ?? null, items };
}

export async function localFoods(userId: string, q = ''): Promise<Food[]> {
  const db = await getDb();
  // `%` and `_` are LIKE metacharacters, so a search for "100%" would otherwise
  // match every saved food. The backend's own search escapes them for the same
  // reason; two search surfaces disagreeing about what a query means is worse
  // than either being wrong.
  const escaped = q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped}%`;
  const rows = await db.getAllAsync<FoodRow>(
    `SELECT ${FOOD_COLS}
       FROM foods
      WHERE user_id = ? AND deleted_at IS NULL AND lower(name) LIKE ? ESCAPE '\\'
      ORDER BY lower(name)`,
    userId, like,
  );
  return rows.map(hydrate);
}

/** One saved food, for the screen that corrects it. Null when it is not here. */
export async function localFood(userId: string, id: string): Promise<Food | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<FoodRow>(
    `SELECT ${FOOD_COLS}
       FROM foods
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    id, userId,
  );
  return row ? hydrate(row) : null;
}

/**
 * What a caller must say to save a food, and what it may leave out.
 *
 * **The recipe fields are optional on the WRITE and required on the READ**, and
 * that asymmetry is the point. A screen saving a plain food has nothing to say
 * about ingredients, so making it write `items: []` would be ceremony — and
 * ceremony is what gets copy-pasted wrong. A screen READING a food always gets
 * an answer, because "does this have ingredients" is a question the store can
 * always settle and a caller left to interpret `undefined` cannot.
 */
export type FoodDraft = Omit<Food, 'id' | 'yield_servings' | 'items'> & {
  id?: string;
  yield_servings?: number | null;
  items?: RecipeItem[];
};

/** Save a food locally: owed to the server, and usable immediately. */
export async function saveFoodLocally(
  userId: string, input: FoodDraft,
): Promise<string> {
  const db = await getDb();
  const id = input.id ?? randomUUID();
  const now = stamp();
  await db.runAsync(
    `INSERT INTO foods (
       id, user_id, kind, name, brand, serving_label, serving_grams,
       kcal, protein_g, carb_g, fat_g, fibre_g,
       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source,
       yield_servings, items, created_at, updated_at,
       dirty, remote, cached_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind, name = excluded.name, brand = excluded.brand,
       serving_label = excluded.serving_label, serving_grams = excluded.serving_grams,
       kcal = excluded.kcal, protein_g = excluded.protein_g, carb_g = excluded.carb_g,
       fat_g = excluded.fat_g, fibre_g = excluded.fibre_g,
       saturated_fat_g = excluded.saturated_fat_g, sugar_g = excluded.sugar_g,
       added_sugar_g = excluded.added_sugar_g, sodium_mg = excluded.sodium_mg,
       cholesterol_mg = excluded.cholesterol_mg,
       -- **"excluded", NOT a COALESCE, and the asymmetry with "source" below is
       -- deliberate.** An absent "source" means "I am not claiming a
       -- provenance", so the stored one survives. An absent ingredient list
       -- means the athlete took everything out of the recipe, and there is no
       -- other way for them to express that — the server's own write path says
       -- the same thing by DELETEing the items before re-INSERTing whatever it
       -- was sent. Making this a COALESCE would compile, read as defensive, and
       -- make an ingredient impossible to remove.
       yield_servings = excluded.yield_servings, items = excluded.items,
       -- **NOT "excluded.source"**, and this is the same guard the server's own
       -- upsert carries. A caller that says nothing about provenance is editing
       -- the macros, not relabelling the row: "COALESCE" keeps what is stored,
       -- so correcting an AI-drafted food's calories cannot silently turn it
       -- into one the athlete measured. "excluded.source" is what the row WOULD
       -- have been inserted as, i.e. already defaulted, so reading it here can
       -- never see the absent case — exactly the trap postgres.go documents.
       source = COALESCE(?, foods.source),
       dirty = 1, updated_at = excluded.updated_at, last_error = NULL`,
    id, userId, input.kind, input.name, input.brand, input.serving_label, input.serving_grams,
    input.kcal, input.protein_g, input.carb_g, input.fat_g, input.fibre_g,
    input.saturated_fat_g, input.sugar_g, input.added_sugar_g, input.sodium_mg, input.cholesterol_mg,
    input.source ?? 'user',
    // A plain food must store NULL rather than 0 here: the server refuses
    // `kind: 'food'` carrying a yield at all, and 0 is a value.
    input.yield_servings ?? null, JSON.stringify(input.items ?? []),
    now, now, now,
    // The same value again, as its own binding for the COALESCE above — and
    // `?? null` rather than `?? 'user'`, because on an UPDATE "unstated" must
    // fall through to the stored value rather than to a default.
    input.source ?? null,
  );
  return id;
}

/**
 * Remove a saved food or recipe (N79 — the management surface `deleteFood`
 * was written for but never had a caller).
 *
 * The exact shape of `removeEntry` above, for the exact same reason: a TOMBSTONE
 * for anything the server has seen, because a hard delete of a row the server
 * still holds would have `cacheFoods`'s pull bring it straight back on the next
 * sync — the athlete would be deleting the same recipe every time they open the
 * app. A row this device has never pushed successfully (`remote = 0 AND
 * dirty = 0` — the state a PERMANENTLY rejected, never-confirmed save leaves
 * behind, see the `push` loop's `kind === 'permanent'` branch) is hard-deleted
 * immediately, since there is nothing on the server to leave a tombstone for.
 *
 * **Deleting a food changes nothing about what it was logged as.** The server's
 * `source_food_id` foreign key is `ON DELETE SET NULL` (migration 000059), and
 * every `food_entries` row already carries its own copied macros regardless —
 * the nutrition module's whole design is that a logged entry owns its numbers,
 * so a day already eaten stays exactly as it read.
 */
export async function removeFood(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ remote: number; dirty: number }>(
    `SELECT remote, dirty FROM foods WHERE id = ? AND user_id = ?`, id, userId,
  );
  if (!row) return; // Already gone. Deleting twice is not an error.

  // **Sever any UNSYNCED entry's reference to this food FIRST — found in
  // review (N79, #413).** This mirrors the server's own `ON DELETE SET NULL`
  // (migration 000059) locally, and it has to happen before either branch
  // below, not after. `push()` sends the foods queue before the entries
  // queue (see that function's own N114 comment on why the order is a
  // correctness constraint) — so an entry that is still DIRTY and carries
  // `source_food_id = id` would otherwise be pushed, in the SAME sync pass,
  // naming a food the server either never had (this food was never synced)
  // or has just been told to delete. Either way the composite FK on
  // `nutrition_entries` refuses it with a 23503 the server maps to
  // `invalid_input`; `classify` reads a 400 as PERMANENT and clears `dirty`
  // on the ENTRY. The meal survives on THIS phone — its macros are a copy,
  // not a join — but never reaches the server or any other device again,
  // silently: no error, nothing on the sync screen, exactly the failure mode
  // `push()`'s own N114 comment exists to prevent, now reachable from ONE
  // phone rather than two devices racing, because before this ticket nothing
  // on the phone could delete a saved food at all.
  //
  // An already-synced (`dirty = 0`) entry is left alone: the server's own
  // cascade will null its copy of `source_food_id` once this delete lands,
  // and nothing here ever re-reads that column to sync it back — same as a
  // web-side delete already left a phone's local copy pointing at a since-
  // deleted id, which is harmless because no query ever joins through it.
  await db.runAsync(
    `UPDATE food_entries SET source_food_id = NULL
      WHERE user_id = ? AND source_food_id = ? AND dirty = 1`,
    userId, id,
  );

  if (row.remote === 0 && row.dirty === 0) {
    await db.runAsync(`DELETE FROM foods WHERE id = ? AND user_id = ?`, id, userId);
    return;
  }
  const now = stamp();
  await db.runAsync(
    `UPDATE foods SET deleted_at = ?, dirty = 1, updated_at = ?, last_error = NULL
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    now, now, id, userId,
  );
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
  // `FoodRow`, not `Food`, and the difference is not cosmetic. The generic here
  // is an ASSERTION about what the SELECT returns, not a check of it — so
  // naming `Food` would tell the typechecker that `items` is present while the
  // column list never asked for it, and every recipe in the quick-add list
  // would carry `items: undefined` with nothing anywhere going red. Selecting
  // through `FOOD_COLS` and mapping through `hydrate` is what makes the two
  // agree.
  const rows = await db.getAllAsync<FoodRow & { uses: number; last_used_on: string | null }>(
    `SELECT ${foodColsFrom('f')},
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
  // Destructured rather than `hydrate(r)`, so the aggregate columns cannot ride
  // along into the food object as stray runtime properties the type never
  // mentions.
  return rows.map(({ uses, last_used_on, ...row }) => ({
    food: hydrate(row),
    uses,
    lastUsedOn: last_used_on,
  }));
}

export type FoodSyncResult = {
  pushed: number;
  failed: number;
  error?: string;
  errorKind?: 'offline' | 'permanent' | 'transient';
  /** The largest `Retry-After` seen this run, in ms (F17, #403). */
  retryAfterMs?: number;
  /** Entries fetched by the fresh-install backfill below (N428, #686). */
  pulled?: number;
};

/**
 * The server's own `maxEntryWindowDays` (`nutrition/handler.go`), matched
 * exactly. The server rejects a `from`/`to` pair with `daysBetween >= 31`, so
 * a window spanning 31 CALENDAR days (30 days back from the end date) is the
 * widest one call can ever ask for without a 400 — one day wider and the
 * fresh-install backfill below would fail on its very first request.
 */
const BACKFILL_WINDOW_DAYS = 31;

/**
 * A hard ceiling on how many 31-day windows one fresh-install backfill will
 * fetch, so a long logging history can't turn one sync call into an unbounded
 * fetch loop — the same discipline `sessionStore.ts`'s `BACKFILL_MAX_PAGES`
 * documents for training history. `BACKFILL_MAX_WINDOWS * BACKFILL_WINDOW_DAYS`
 * ≈ 1 year, deliberately generous for a log kept 3–6×/day.
 */
const BACKFILL_MAX_WINDOWS = 12;

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

/** Fold one failure's `Retry-After` into the run's running maximum. */
function noteRetryAfter(result: { retryAfterMs?: number }, err: unknown): void {
  const ms = retryAfterOf(err);
  if (ms != null) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, ms);
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

  // **FOODS FIRST, AND THIS ORDER IS A CORRECTNESS CONSTRAINT, NOT A
  // PREFERENCE (N114).**
  //
  // `nutrition_entries` carries a composite foreign key
  // `(user_id, source_food_id) -> nutrition_foods (user_id, id)`. Until N114
  // every drafted meal pushed `source_food_id: null`, so the order of these two
  // queues could not matter and entries went first. Confirming a draft now
  // saves the food and points the entry at it, so an entry sent first names a
  // row the server has never seen.
  //
  // **And the loss is permanent, not a retry.** The server maps the 23503 to
  // `invalid_input` and answers 400; `classify` reads a 400 as a permanent
  // rejection and clears `dirty` — correctly in general, a 4xx will not become
  // a 2xx — so the entry leaves the outbox, the meal lives only on the phone,
  // and nothing anywhere says so. Pinned by
  // `savedFoods.test.ts`'s "sends the food BEFORE the entry that references it"
  // and by the consequence test beside it.
  // **No `AND deleted_at IS NULL` here, unlike every other read of this
  // table (N79).** Those all show the athlete a saved food and must not show
  // a tombstone; this is what OWES a request, and a delete owes one exactly as
  // much as a save does. Dropping the filter without adding the branch below
  // would silently strand every mobile delete on the phone forever — the
  // fixed version of the bug this ticket exists to close.
  const foodRows = await db.getAllAsync<FoodRow & { updated_at: string; deleted_at: string | null }>(
    `SELECT ${FOOD_COLS}, updated_at, deleted_at
       FROM foods WHERE user_id = ? AND dirty = 1`,
    userId,
  );
  const foods = foodRows.map((r) => {
    const { updated_at, deleted_at, ...row } = r;
    return { ...hydrate(row), updated_at, deleted_at };
  });
  for (const f of foods) {
    try {
      if (f.deleted_at) {
        // Same shape as the entry queue's tombstone branch below: the server
        // answers 204 whether or not it had heard of this row, so this
        // resolves for a food already removed from another device. Hard-delete
        // only once the server confirms — until then the tombstone IS the
        // record that a delete is owed.
        await api.deleteFood(getToken, f.id);
        await db.runAsync(`DELETE FROM foods WHERE id = ? AND user_id = ?`, f.id, userId);
        result.pushed += 1;
        continue;
      }
      await api.saveFood(getToken, f.id, {
        kind: f.kind, name: f.name, brand: f.brand,
        serving_label: f.serving_label, serving_grams: f.serving_grams,
        kcal: f.kcal, protein_g: f.protein_g, carb_g: f.carb_g, fat_g: f.fat_g, fibre_g: f.fibre_g,
        saturated_fat_g: f.saturated_fat_g, sugar_g: f.sugar_g, added_sugar_g: f.added_sugar_g,
        sodium_mg: f.sodium_mg, cholesterol_mg: f.cholesterol_mg,
        // **A recipe MUST carry both of these or it is a permanent 400** — the
        // server's `Food.Validate` checks `(kind == recipe) != (yield_servings
        // != null)` and rejects either half of the mismatch, and `classify`
        // reads a 400 as permanent, so the row leaves the outbox with the
        // athlete's recipe living only on this phone.
        //
        // Before N87 the phone had no way to author a recipe, but it could
        // still PULL one authored on the web and then push it back after an
        // edit — dropping the yield on the way, which was exactly that
        // permanent rejection. Pinned by `recipeStore.test.ts`.
        //
        // Sent as `null`/`[]` for a plain food rather than omitted, because the
        // biconditional bites in BOTH directions: a food carrying a yield is
        // refused too.
        yield_servings: f.yield_servings, items: f.items,
        // Sent on EVERY push, not only when it changed. The server keeps what
        // it stores when this is absent, which is the right default for an old
        // client — but this one knows the answer, and a row whose provenance
        // only exists on the phone is one a reinstall loses.
        //
        // Restricted to what a client may claim: the server refuses anything
        // outside {user, ai} with a 400, which would strand the row as a
        // permanent rejection. A pulled row carrying a vocabulary this build
        // does not know (a future value, or `usda`/`off` from an importer) is
        // therefore sent as nothing at all — "keep what you have" — rather than
        // coerced to `user`, which would DESTROY the very distinction it is
        // being sent to preserve.
        // Written as nested ternaries rather than `a || b ? f.source : …`
        // because `FoodSource` includes `(string & {})` — the open arm that
        // keeps a server-added value from being coerced — and TypeScript will
        // not narrow that arm down to a literal through a disjunction. The
        // narrow form yields the literal types the wire contract asks for.
        source: f.source === 'ai' ? 'ai' : f.source === 'user' ? 'user' : undefined,
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
      noteRetryAfter(result, err);
      await db.runAsync(
        `UPDATE foods SET last_error = ? WHERE id = ? AND user_id = ? AND updated_at = ?`,
        message, f.id, userId, f.updated_at,
      );
      if (kind === 'permanent') {
        // Same guard as the entry queue's own comment on this branch: a
        // rejected DELETE is near-unreachable (the server answers 204 always,
        // it does not refuse tombstones), but if it ever happens the tombstone
        // survives with `dirty` cleared, invisible to every read here — all of
        // which filter `deleted_at IS NULL` — which is the least-wrong outcome
        // for a delete this device can no longer explain.
        await db.runAsync(
          `UPDATE foods SET dirty = 0 WHERE id = ? AND user_id = ? AND updated_at = ?`,
          f.id, userId, f.updated_at,
        );
      }
      if (kind === 'offline') {
        // Sets `stalled` as well as breaking, so the ENTRY queue below is not
        // even read — the same reasoning the entry loop has always carried,
        // now on the queue that runs first.
        stalled = true;
        break;
      }
    }
  }

  // Entries SECOND — see the note on the foods queue above. Skipped entirely
  // when that queue found no connection: an entry whose food has not left the
  // phone would be refused, and refused permanently.
  const rows = stalled
    ? []
    : await db.getAllAsync<EntryRow & { remote: number }>(
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
          fibre_g: r.fibre_g,
          saturated_fat_g: r.saturated_fat_g, sugar_g: r.sugar_g, added_sugar_g: r.added_sugar_g,
          sodium_mg: r.sodium_mg, cholesterol_mg: r.cholesterol_mg,
          source_food_id: r.source_food_id, notes: r.notes,
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
      noteRetryAfter(result, err);
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

  // The entries BACKFILL (N428, #686) — for a FRESH INSTALL (or reinstall)
  // ONLY. Nothing else pulls `food_entries`: this file's own doc comment
  // above states entries are push-only in steady state, because nothing on
  // web writes one yet (`cacheEntries` exists and is tested for exactly that
  // day — "wire it when there is a second writer" — this is not that day).
  // But a fresh install starts this device's `food_entries` table at zero,
  // and with no pull at all every meal ever logged before this install
  // becomes permanently invisible on THIS phone — the athlete's history is
  // still on the server, the app simply never asks for it. Same defect shape
  // N85 fixed for `local_sessions`, filed here after a device uninstall wiped
  // a real athlete's local food log and the reinstall after it showed nothing
  // at all.
  //
  // Detected the same way N85 detects it: an empty local table for THIS
  // user, not a persisted flag — the first backfilled window makes the table
  // non-empty, so this branch stops firing on its own once history has
  // landed, with no extra state to keep in sync with reality.
  //
  // Windowed by CALENDAR DATE rather than paged by offset, because
  // `GET /nutrition/entries` takes `from`/`to` (bound to the server's own
  // `maxEntryWindowDays`, matched by `BACKFILL_WINDOW_DAYS` above) rather
  // than limit/offset — `nutritionApi.ts`'s `listEntries` has no other shape
  // to page through. Walked BACKWARD from today, newest window first, so the
  // history Today/Progress actually read lands first if
  // `BACKFILL_MAX_WINDOWS` is ever what stops the loop — mirroring
  // `runSync`'s own most-recent-first session pages.
  //
  // No short-window early exit, unlike `runSync`'s "a short page means the
  // server has nothing left". That inference only holds for offset paging
  // over one ordered list; a CALENDAR window can come back empty because an
  // athlete took a quiet month, not because history stops there, so an empty
  // window here is not evidence of anything and every window in the budget
  // runs regardless.
  if (!stalled && result.errorKind !== 'offline') {
    try {
      const localCount = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM food_entries WHERE user_id = ?`, userId,
      );
      if ((localCount?.n ?? 0) === 0) {
        let windowEnd = new Date();
        for (let i = 0; i < BACKFILL_MAX_WINDOWS; i++) {
          const to = dayString(windowEnd);
          const windowStart = addDays(windowEnd, -(BACKFILL_WINDOW_DAYS - 1));
          const from = dayString(windowStart);
          const entries = await api.listEntries(getToken, { from, to });
          if (entries.length) {
            await cacheEntries(userId, from, to, entries);
            result.pulled = (result.pulled ?? 0) + entries.length;
          }
          windowEnd = addDays(windowStart, -1);
        }
      }
    } catch (err) {
      // A failed backfill is not a failed sync — everything owed has already
      // gone, and this device simply stays exactly as empty as it was before
      // this attempt, to be retried on the next sync. Recorded rather than
      // swallowed, matching the foods-pull catch above, for the same reason:
      // a catch that cannot fail is a catch nobody finds out about.
      result.error = result.error ?? (err instanceof Error ? err.message : 'backfill failed');
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
           saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source,
           yield_servings, items,
           created_at, updated_at, cached_at, dirty, remote)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, brand = excluded.brand,
           serving_label = excluded.serving_label, serving_grams = excluded.serving_grams,
           kcal = excluded.kcal, protein_g = excluded.protein_g,
           carb_g = excluded.carb_g, fat_g = excluded.fat_g, fibre_g = excluded.fibre_g,
           saturated_fat_g = excluded.saturated_fat_g, sugar_g = excluded.sugar_g,
           added_sugar_g = excluded.added_sugar_g, sodium_mg = excluded.sodium_mg,
           cholesterol_mg = excluded.cholesterol_mg,
           -- The server is authoritative for a recipe's shape as much as for
           -- its numbers, and this branch only runs for "dirty = 0", so there
           -- is no local claim to protect. A recipe edited on the web arrives
           -- here with its new ingredients and replaces the cached ones.
           yield_servings = excluded.yield_servings, items = excluded.items,
           -- The server is authoritative here, unlike in "saveFoodLocally":
           -- this branch only ever runs for a row with "dirty = 0", so there is
           -- no local claim to protect. A server that sends nothing (an older
           -- deploy, mid-rollout) leaves the stored value rather than blanking
           -- it.
           --
           -- **Its own "?", not "excluded.source".** "excluded" is the row that
           -- WOULD have been inserted, and the VALUES list above has already
           -- turned an absent source into "'user'" — it has to, because the
           -- column is NOT NULL and an explicit NULL is a constraint violation
           -- rather than a fall-through to the DEFAULT. So "excluded.source"
           -- can never be null here, and reading it would quietly overwrite a
           -- stored "ai" with "user" on every pull from an older deploy.
           source = COALESCE(?, foods.source),
           cached_at = excluded.cached_at, remote = 1,
           -- The row now holds the server's numbers, so a reason that described
           -- the local ones is no longer about anything in it.
           last_error = NULL
         WHERE foods.dirty = 0 AND foods.deleted_at IS NULL`,
        f.id, userId, f.kind, f.name, f.brand, f.serving_label, f.serving_grams,
        f.kcal, f.protein_g, f.carb_g, f.fat_g, f.fibre_g,
        f.saturated_fat_g, f.sugar_g, f.added_sugar_g, f.sodium_mg, f.cholesterol_mg,
        // The INSERT arm: a real value, because the column is NOT NULL and an
        // explicitly-bound NULL does NOT fall through to a column DEFAULT in
        // SQLite — it fails the constraint. A brand-new row we are being told
        // nothing about is the athlete's own, which is what `user` means.
        f.source ?? 'user',
        // `?? null` / `?? []` cover a server older than N87 that sends neither
        // field. That reads as a plain food, which is what every pre-N87 row
        // is — and `items` gets a real `'[]'` for the same NOT NULL reason as
        // `source` above.
        f.yield_servings ?? null, JSON.stringify(f.items ?? []),
        now, now, now,
        // The UPDATE arm's own binding, nullable: silence means "keep what is
        // stored", which is the opposite of the default above and the reason
        // these are two bindings rather than one.
        f.source ?? null,
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
