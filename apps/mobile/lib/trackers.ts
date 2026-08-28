/**
 * Daily trackers, offline first.
 *
 * Two tables, two directions, and the split is the design:
 *
 * **Entries PUSH.** A tap is written to SQLite and returned from immediately;
 * the network is never awaited. Water is logged in a kitchen and coffee in a
 * gym café, which are the two places a phone is least likely to have signal,
 * and a tap that needed a round trip would be a tap that sometimes silently did
 * nothing. The id is generated here, which is what makes the retry idempotent.
 *
 * **Definitions PULL as well as push.** The server provisions water on first
 * list, so a definition this device has not seen is one to adopt. Editing the
 * target marks the row dirty and the outbox pushes it — so changing a target
 * works with no signal, which is the mobile-first half of this feature.
 *
 * The outbox mechanics are `foodLog.ts`'s, deliberately and almost line for
 * line: the monotonic `stamp()`, the compare-and-swap on `updated_at` on BOTH
 * the success and failure branches, tombstones for anything the server has
 * seen, `break` on offline. Those were not invented there either — they are the
 * accumulated repairs of several real data-loss bugs, and a third outbox that
 * reinvented them would reintroduce whichever one it forgot.
 */

import { randomUUID } from 'expo-crypto';
import type { SQLiteBindValue } from 'expo-sqlite';

import { dayString } from './calendar';
import { ApiError, isOffline, isPermanentRejection, retryAfterOf } from './apiError';
import { getDb, withTransaction } from './db';
import type { RenderStyle, Tracker, TrackerEntry, TrackerUnit } from './trackerModel';
import * as api from './trackersApi';
import type { TrackerPatch } from './trackersApi';
import type { TokenGetter } from './useAuthToken';

/**
 * A strictly increasing timestamp, per process.
 *
 * `updated_at` is the revision token the push compare-and-swaps on. ISO strings
 * have millisecond resolution, so two writes inside one millisecond produce the
 * identical token, the CAS matches, and the second write is silently marked
 * sent. Tapping a cup row is exactly the burst that hits this — four taps in a
 * second is normal use, not a stress test. Copied from `foodLog.ts`, where the
 * bug was found the hard way.
 */
let lastStamp = '';
function stamp(): string {
  let s = new Date().toISOString();
  if (s <= lastStamp) s = new Date(Date.parse(lastStamp) + 1).toISOString();
  lastStamp = s;
  return s;
}

type TrackerRow = {
  id: string;
  user_id: string;
  preset: string;
  name: string;
  icon: string;
  color_key: string;
  unit: string;
  increment: number;
  target: number | null;
  render_style: string;
  sort_order: number;
  count_noun: string;
  cutoff_minutes: number | null;
  provisioned: number;
  archived_at: string | null;
  restore_pending: number;
  destroyed_at: string | null;
  updated_at: string;
  dirty: number;
  remote: number;
};

function toTracker(r: TrackerRow): Tracker {
  return {
    id: r.id,
    preset: r.preset,
    name: r.name,
    icon: r.icon,
    color_key: r.color_key,
    unit: r.unit as TrackerUnit,
    increment: r.increment,
    target: r.target,
    render_style: r.render_style as RenderStyle,
    sort_order: r.sort_order,
    count_noun: r.count_noun,
    cutoff_minutes: r.cutoff_minutes,
    provisioned: r.provisioned === 1,
  };
}

/**
 * What this device can say about an athlete's trackers with no network.
 *
 * `unknown` rather than an empty list when nothing has ever been fetched, and
 * the distinction is the whole reason this is a union. Both cases have zero
 * rows; rendering the second as "you have no trackers" tells somebody with a
 * water card that they have none, on the one screen whose job is reminding
 * them. Same shape as `TargetView` in `lib/nutrition.ts`, for the same reason.
 */
export type TrackerView =
  | { state: 'unknown' }
  | { state: 'ready'; trackers: Tracker[] };

/** The live trackers this device knows about. Pure SQLite. */
export async function localTrackers(userId: string): Promise<TrackerView> {
  const db = await getDb();
  const rows = await db.getAllAsync<TrackerRow>(
    `SELECT * FROM daily_trackers
      WHERE user_id = ? AND archived_at IS NULL AND destroyed_at IS NULL
      ORDER BY sort_order, id`,
    userId,
  );
  if (rows.length > 0) return { state: 'ready', trackers: rows.map(toTracker) };
  // Zero rows is ambiguous: never fetched, or fetched and genuinely empty
  // (every tracker archived). Distinguished by whether ANY row exists for this
  // athlete, archived included — which is why archiving is a timestamp rather
  // than a delete on this side too.
  //
  // A tracker the athlete DESTROYED is not evidence either way and is excluded
  // from both queries: its row survives only as a tombstone carrying a delete
  // this device still owes, and counting it would make "I deleted my only
  // tracker" render an empty list where "this device has not asked yet" is the
  // truthful state — the exact confusion this union exists to prevent.
  const any = await db.getFirstAsync<{ n: number }>(
    `SELECT count(*) AS n FROM daily_trackers WHERE user_id = ? AND destroyed_at IS NULL`,
    userId,
  );
  return (any?.n ?? 0) > 0 ? { state: 'ready', trackers: [] } : { state: 'unknown' };
}

/**
 * The trackers this athlete has stopped, newest-archived first.
 *
 * Its own query rather than a flag on `localTrackers`, for the reason the
 * backend gives: a screen showing both would have to decide what an archived
 * card's `+` does, and the honest answer is that it has none.
 */
export async function localArchivedTrackers(userId: string): Promise<Tracker[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<TrackerRow>(
    `SELECT * FROM daily_trackers
      WHERE user_id = ? AND archived_at IS NOT NULL AND destroyed_at IS NULL
      ORDER BY archived_at DESC, id`,
    userId,
  );
  return rows.map(toTracker);
}

/**
 * Store the server's list.
 *
 * Never clobbers a row this device still owes: the `WHERE dirty = 0` on the
 * conflict clause is what stops a pull landing mid-edit from throwing away a
 * target the athlete just typed. `cacheEntries` in `foodLog.ts` documents the
 * same trap at length.
 *
 * Rows the server did not return are ARCHIVED locally rather than deleted, so
 * a tracker removed on another device stops appearing without taking its
 * entries with it — and `dirty = 0` scopes that too, so a tracker created here
 * and not yet pushed is not archived for being absent from a list the server
 * assembled before it existed.
 */
export async function cacheTrackers(userId: string, trackers: api.WireTracker[]): Promise<void> {
  const db = await getDb();
  await withTransaction(db, async () => {
    const ids = trackers.map((t) => t.id);
    const placeholders = ids.length ? ids.map(() => '?').join(',') : `''`;
    await db.runAsync(
      `UPDATE daily_trackers SET archived_at = ?
        WHERE user_id = ? AND id NOT IN (${placeholders})
          AND dirty = 0 AND remote = 1 AND archived_at IS NULL`,
      stamp(), userId, ...ids,
    );
    await upsertTrackers(db, userId, trackers);
  });
}

/**
 * Store a list of ARCHIVED trackers, without the sweep above.
 *
 * The sweep in `cacheTrackers` reads "anything the server did not return is
 * gone", which is only true of a request for the LIVE list. Running it against
 * a response that deliberately contains only archived rows would archive every
 * live tracker the athlete has — the whole of Today, from opening a screen that
 * only reads.
 *
 * Same upsert, no sweep. That is the entire difference, and it is why this is a
 * separate function rather than a boolean argument: a boolean at the call site
 * does not say which of those two things is about to happen.
 */
export async function cacheArchivedTrackers(
  userId: string,
  trackers: api.WireTracker[],
): Promise<void> {
  const db = await getDb();
  await withTransaction(db, () => upsertTrackers(db, userId, trackers));
}

/**
 * Store ONE tracker the server just handed back, without the live-list sweep.
 *
 * For a response that is a single row rather than a list — turning a preset on,
 * which is the one write in this feature that cannot happen offline because the
 * server derives the id.
 *
 * **Without this, `POST /tracker-presets/{key}` lands nowhere the athlete can
 * see.** `requestSync` only PUSHES; there is no pull. So the athlete taps
 * "Coffee", the server creates it, the screen navigates back to a list that
 * reads SQLite — and coffee is not in it, until some other screen happens to
 * refetch. It also would not count against the local cap until then. That is
 * the acceptance criterion "a created tracker appears on Today without further
 * setup" failing on the first screen they actually look at.
 */
export async function cacheTracker(userId: string, tracker: api.WireTracker): Promise<void> {
  const db = await getDb();
  await withTransaction(db, () => upsertTrackers(db, userId, [tracker]));
}

async function upsertTrackers(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  trackers: api.WireTracker[],
): Promise<void> {
  for (const t of trackers) {
    await db.runAsync(
      `INSERT INTO daily_trackers (
         id, user_id, preset, name, icon, color_key, unit, increment, target,
         render_style, sort_order, count_noun, cutoff_minutes, provisioned, archived_at,
         updated_at, dirty, remote)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)
       ON CONFLICT(id) DO UPDATE SET
         preset = excluded.preset, name = excluded.name, icon = excluded.icon,
         color_key = excluded.color_key, unit = excluded.unit,
         increment = excluded.increment, target = excluded.target,
         render_style = excluded.render_style, sort_order = excluded.sort_order,
         count_noun = excluded.count_noun, cutoff_minutes = excluded.cutoff_minutes,
         provisioned = excluded.provisioned,
         archived_at = excluded.archived_at, remote = 1
       WHERE daily_trackers.dirty = 0`,
      t.id, userId, t.preset, t.name, t.icon, t.color_key, t.unit, t.increment,
      t.target, t.render_style, t.sort_order, t.count_noun ?? '', t.cutoff_minutes ?? null,
      t.provisioned ? 1 : 0, t.archived_at, t.updated_at,
    );
  }
}

/**
 * Change part of a tracker, locally and now.
 *
 * **Partial in the same sense the API is partial**: the caller names the fields
 * it means and the rest of the row is untouched. The SET clause is built from
 * the patch rather than written out, for exactly the reason the backend's is —
 * a fixed SET clause that grows a column blanks whatever the caller did not
 * mention, which is the bug `exercise.updateWithin` shipped three times.
 *
 * The whole row is what gets PUSHED (this device owns its local copy and the
 * server's PATCH is happy to receive every field), so the partial half is about
 * what happens HERE, between the edit screen and SQLite.
 */
export async function updateTrackerLocally(
  userId: string,
  id: string,
  patch: TrackerPatch,
): Promise<void> {
  const sets: string[] = [];
  const args: SQLiteBindValue[] = [];
  // One entry per patch key, and nothing for a key the caller omitted. Written
  // out rather than looped over Object.keys so a column name can never come
  // from a caller.
  // `undefined` means the caller did not name this field, so the column stays
  // out of the statement entirely and cannot be blanked. `null` is a VALUE and
  // passes straight through — it is how an athlete says "I want no target".
  // Keyed on the value rather than on a separate `present` flag, so the two can
  // never disagree about which one this is.
  const add = (column: string, value: SQLiteBindValue | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    args.push(value);
  };
  add('name', patch.name);
  add('icon', patch.icon);
  add('color_key', patch.color_key);
  add('unit', patch.unit);
  add('increment', patch.increment);
  add('target', patch.target);
  add('render_style', patch.render_style);
  add('sort_order', patch.sort_order);
  add('count_noun', patch.count_noun);
  add('cutoff_minutes', patch.cutoff_minutes);
  if (sets.length === 0) return;

  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE daily_trackers
        SET ${sets.join(', ')}, dirty = 1, updated_at = ?, last_error = NULL
      WHERE id = ? AND user_id = ? AND archived_at IS NULL`,
    ...args, stamp(), id, userId,
  );
  if (r.changes === 0) throw new Error('That tracker no longer exists on this device.');
}

/**
 * How many trackers an athlete may have running at once.
 *
 * **Mirrors the server's `MaxLiveTrackers` and is checked here as well**, so an
 * athlete who fills up offline is told at the moment they tap Create rather
 * than by a 409 surfacing on a sync screen an hour later — by which time they
 * have typed a name, a unit, a target and an increment, and the app throws it
 * away.
 *
 * The server's copy is the one that decides. This one exists to be timely, and
 * `trackerCap.test.ts` asserts the two numbers are equal by reading the Go
 * constant, so they cannot drift.
 */
export const MAX_LIVE_TRACKERS = 8;

/** What creating a tracker on this device needs. */
export type NewTrackerInput = {
  name: string;
  icon: string;
  color_key: string;
  unit: TrackerUnit;
  increment: number;
  target: number | null;
  render_style: RenderStyle;
  count_noun: string;
  /** `null` for no cutoff, same reading as `target`. */
  cutoff_minutes: number | null;
};

/**
 * Create a tracker, locally and now.
 *
 * **The id is generated HERE**, which is what makes the push idempotent: a
 * create that reaches the server and whose response is lost is retried with the
 * same id and answered with the original row. The same property every tap has.
 *
 * `sort_order` puts it at the end of the athlete's list rather than at 0 — a
 * new tracker jumping to the top of Today, above the water they have been
 * logging for a month, is not what "add one" means.
 *
 * Returns the new id so the caller can navigate to it.
 */
export async function createTrackerLocally(
  userId: string,
  input: NewTrackerInput,
): Promise<string> {
  const db = await getDb();
  const live = await db.getFirstAsync<{ n: number }>(
    `SELECT count(*) AS n FROM daily_trackers
      WHERE user_id = ? AND archived_at IS NULL AND destroyed_at IS NULL`,
    userId,
  );
  if ((live?.n ?? 0) >= MAX_LIVE_TRACKERS) {
    throw new Error(
      `You can track ${MAX_LIVE_TRACKERS} things at once. Stop one first — ` +
        `everything it recorded is kept.`,
    );
  }
  const next = await db.getFirstAsync<{ n: number | null }>(
    `SELECT max(sort_order) AS n FROM daily_trackers WHERE user_id = ?`,
    userId,
  );
  const id = randomUUID();
  const now = stamp();
  await db.runAsync(
    `INSERT INTO daily_trackers (
       id, user_id, preset, name, icon, color_key, unit, increment, target,
       render_style, sort_order, count_noun, cutoff_minutes, updated_at, dirty, remote)
     VALUES (?,?,'',?,?,?,?,?,?,?,?,?,?,?,1,0)`,
    id, userId, input.name, input.icon, input.color_key, input.unit,
    input.increment, input.target, input.render_style, (next?.n ?? 0) + 10,
    input.count_noun, input.cutoff_minutes, now,
  );
  return id;
}

/**
 * Stop a tracker. It leaves Today and Food; every entry it recorded stays.
 *
 * A timestamp rather than a delete on this side too, and for a second reason
 * beyond mirroring the server: `localTrackers` distinguishes "this device has
 * never asked" from "there are genuinely none" by whether ANY row exists, so a
 * hard delete here would make an athlete who stopped their only tracker see a
 * loading state forever.
 */
export async function archiveTrackerLocally(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const now = stamp();
  const r = await db.runAsync(
    `UPDATE daily_trackers
        SET archived_at = ?, restore_pending = 0, dirty = 1, updated_at = ?, last_error = NULL
      WHERE id = ? AND user_id = ? AND archived_at IS NULL AND destroyed_at IS NULL`,
    now, now, id, userId,
  );
  if (r.changes === 0) throw new Error('That tracker is not on this device.');
}

/**
 * Put a stopped tracker back.
 *
 * `restore_pending` is what the push reads. It cannot be inferred from
 * `archived_at IS NULL AND dirty = 1`, because that is also what an ordinary
 * edit to a live tracker looks like — and a PATCH does not un-archive anything,
 * so the restore would silently never happen and the card would come back on
 * the next pull.
 */
export async function restoreTrackerLocally(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const live = await db.getFirstAsync<{ n: number }>(
    `SELECT count(*) AS n FROM daily_trackers
      WHERE user_id = ? AND archived_at IS NULL AND destroyed_at IS NULL`,
    userId,
  );
  if ((live?.n ?? 0) >= MAX_LIVE_TRACKERS) {
    throw new Error(
      `You are already tracking ${MAX_LIVE_TRACKERS} things. Stop one to make room.`,
    );
  }
  const now = stamp();
  const r = await db.runAsync(
    `UPDATE daily_trackers
        SET archived_at = NULL, restore_pending = 1, dirty = 1, updated_at = ?, last_error = NULL
      WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL AND destroyed_at IS NULL`,
    now, id, userId,
  );
  if (r.changes === 0) throw new Error('That tracker is not stopped on this device.');
}

/**
 * **Destroy a tracker and everything it ever recorded.** There is no undo.
 *
 * A TOMBSTONE rather than a local delete, exactly as `removeTap` uses one: a
 * destroy made in a dead spot would otherwise leave nothing carrying the
 * intent, the push would have no row to read, and the next pull would hand the
 * tracker back. The row is hard-deleted once the server confirms.
 *
 * The local entries go immediately, because nothing needs them again — the
 * server cascades its own, and any entry this device still owed is owed against
 * a tracker that is being destroyed.
 */
export async function destroyTrackerLocally(userId: string, id: string): Promise<void> {
  const db = await getDb();
  await withTransaction(db, async () => {
    const now = stamp();
    const r = await db.runAsync(
      `UPDATE daily_trackers
          SET destroyed_at = ?, dirty = 1, updated_at = ?, last_error = NULL
        WHERE id = ? AND user_id = ? AND destroyed_at IS NULL`,
      now, now, id, userId,
    );
    if (r.changes === 0) throw new Error('That tracker is not on this device.');
    await db.runAsync(
      `DELETE FROM tracker_entries WHERE tracker_id = ? AND user_id = ?`,
      id, userId,
    );
  });
}

/**
 * Write a new display order.
 *
 * Takes the ids in the order the athlete wants them and renumbers all of them,
 * rather than swapping two neighbours' values. Swapping is fine until two rows
 * share a `sort_order` — which they do the moment anything is created while a
 * reorder is unsynced — and then the tie is broken by id and the list appears
 * to reorder itself.
 *
 * Each row goes through `updateTrackerLocally`, so every one is marked dirty
 * and pushed. Ten apart so a later insert can land between two without a
 * renumber.
 */
export async function reorderTrackers(userId: string, orderedIds: string[]): Promise<void> {
  const db = await getDb();
  // **ONE transaction, not N statements.** Two things go wrong without it, and
  // the second is the one an athlete meets: a throw part-way through (a row
  // swept to archived by a concurrent pull, say) leaves a HALF-renumbered order
  // already marked dirty and pushed as-is — an order nobody chose; and a rapid
  // double-tap on the arrows starts two of these whose per-row writes
  // interleave, so what is stored is a mix of two arrays while the screen shows
  // the second. The screen also serialises its own calls, but a lock on the
  // data is the one that holds when a second screen appears.
  await withTransaction(db, async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      await updateTrackerLocally(userId, orderedIds[i], { sort_order: (i + 1) * 10 });
    }
  });
}

/**
 * Log one tap.
 *
 * Returns as soon as SQLite has it. `randomUUID` rather than a counter because
 * two devices log independently and offline, so the id has to be unique without
 * coordination — and it is the server's idempotency key, so a retry cannot
 * duplicate the cup.
 *
 * `on` defaults to the LOCAL calendar day. Never `toISOString().slice(0,10)`,
 * which for anyone west of Greenwich files an evening glass under tomorrow.
 */
export async function logTap(
  userId: string,
  tracker: Tracker,
  on: string = dayString(new Date()),
): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  const now = stamp();
  await db.runAsync(
    `INSERT INTO tracker_entries
       (id, tracker_id, user_id, logged_on, logged_at, amount, updated_at, dirty, remote)
     VALUES (?,?,?,?,?,?,?,1,0)`,
    id, tracker.id, userId, on, now, tracker.increment, now,
  );
  return id;
}

/**
 * Remove one tap — the tap-a-filled-cup correction.
 *
 * A TOMBSTONE for anything the server has seen, so the cup does not reappear on
 * the next pull and get removed twice.
 *
 * The hard-delete branch needs BOTH `remote = 0` and `dirty = 0`, and the second
 * half is easy to miss. A freshly logged tap is `dirty = 1, remote = 0`, and
 * those flags cannot distinguish never-attempted from attempt-in-flight — so
 * hard-deleting it would lose the delete whenever a push was already running:
 * the push succeeds, the server keeps a cup this device has forgotten, and
 * nothing is left carrying the intent to remove it. The same window
 * `foodLog.removeEntry` documents.
 *
 * So a fresh tap-and-untap tombstones and costs one idempotent DELETE the
 * server answers 204 to. That is more common here than in the food log — a cup
 * row invites mis-taps, which is why tap-to-remove exists at all — and it is
 * still the right trade against losing a correction.
 *
 * The branch that IS reachable is a tap the server refused permanently: the
 * push clears `dirty` and leaves `remote` at 0, so nothing is owed and nothing
 * is in flight, and the row can go with no request made.
 */
export async function removeTap(userId: string, entryId: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ remote: number; dirty: number }>(
    `SELECT remote, dirty FROM tracker_entries WHERE id = ? AND user_id = ?`,
    entryId, userId,
  );
  if (!row) return; // Already gone. Removing twice is not an error.
  if (row.remote === 0 && row.dirty === 0) {
    await db.runAsync(`DELETE FROM tracker_entries WHERE id = ? AND user_id = ?`, entryId, userId);
    return;
  }
  const now = stamp();
  await db.runAsync(
    `UPDATE tracker_entries SET deleted_at = ?, dirty = 1, updated_at = ?, last_error = NULL
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    now, now, entryId, userId,
  );
}

/**
 * Remove the newest tap on a tracker — what the row's own "minus" affordance
 * uses when there is no particular cup to point at.
 *
 * Newest rather than oldest: undoing a mis-tap should undo the tap you just
 * made, and on a row where every cup is identical the last one is the one the
 * athlete means.
 */
export async function removeLastTap(
  userId: string,
  trackerId: string,
  on: string,
): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM tracker_entries
      WHERE user_id = ? AND tracker_id = ? AND logged_on = ? AND deleted_at IS NULL
      ORDER BY logged_at DESC, id DESC LIMIT 1`,
    userId, trackerId, on,
  );
  if (row) await removeTap(userId, row.id);
}

/** One day's entries across every tracker. Pure SQLite — works offline. */
export async function localEntries(userId: string, on: string): Promise<TrackerEntry[]> {
  const db = await getDb();
  return db.getAllAsync<TrackerEntry>(
    `SELECT id, tracker_id, logged_on, logged_at, amount
       FROM tracker_entries
      WHERE user_id = ? AND logged_on = ? AND deleted_at IS NULL
      ORDER BY logged_at, id`,
    userId, on,
  );
}

/** Group a day's entries by tracker, so a card can be handed only its own. */
export function byTracker(entries: TrackerEntry[]): Map<string, TrackerEntry[]> {
  const out = new Map<string, TrackerEntry[]>();
  for (const e of entries) {
    const list = out.get(e.tracker_id);
    if (list) list.push(e);
    else out.set(e.tracker_id, [e]);
  }
  return out;
}

/** Store a server window of entries without clobbering what this device owes. */
export async function cacheEntries(
  userId: string,
  from: string,
  to: string,
  entries: (TrackerEntry & { user_id: string })[],
): Promise<void> {
  const db = await getDb();
  await withTransaction(db, async () => {
    const ids = entries.map((e) => e.id);
    const placeholders = ids.length ? ids.map(() => '?').join(',') : `''`;
    await db.runAsync(
      `DELETE FROM tracker_entries
        WHERE user_id = ? AND logged_on BETWEEN ? AND ?
          AND id NOT IN (${placeholders})
          AND dirty = 0 AND remote = 1 AND deleted_at IS NULL`,
      userId, from, to, ...ids,
    );
    const now = stamp();
    for (const e of entries) {
      await db.runAsync(
        `INSERT INTO tracker_entries
           (id, tracker_id, user_id, logged_on, logged_at, amount, updated_at, dirty, remote)
         VALUES (?,?,?,?,?,?,?,0,1)
         ON CONFLICT(id) DO UPDATE SET
           tracker_id = excluded.tracker_id, logged_on = excluded.logged_on,
           logged_at = excluded.logged_at, amount = excluded.amount, remote = 1
         WHERE tracker_entries.dirty = 0 AND tracker_entries.deleted_at IS NULL`,
        e.id, e.tracker_id, userId, e.logged_on, e.logged_at, e.amount, now,
      );
    }
  });
}

export async function pendingTrackerCount(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT (SELECT count(*) FROM tracker_entries WHERE user_id = ? AND dirty = 1)
          + (SELECT count(*) FROM daily_trackers  WHERE user_id = ? AND dirty = 1) AS n`,
    userId, userId,
  );
  return row?.n ?? 0;
}

export type TrackerSyncResult = {
  pushed: number;
  failed: number;
  error?: string;
  errorKind?: 'offline' | 'permanent' | 'transient';
  /** The largest `Retry-After` seen this run, in ms (F17, #403). */
  retryAfterMs?: number;
};

function classify(err: unknown): 'offline' | 'permanent' | 'transient' {
  if (isOffline(err)) return 'offline';
  if (isPermanentRejection(err)) return 'permanent';
  return 'transient';
}

/** Fold one failure's `Retry-After` into the run's running maximum. */
function noteRetryAfter(result: { retryAfterMs?: number }, err: unknown): void {
  const ms = retryAfterOf(err);
  if (ms != null) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, ms);
}

function worseKind(
  a: TrackerSyncResult['errorKind'],
  b: TrackerSyncResult['errorKind'],
): TrackerSyncResult['errorKind'] {
  if (a === 'offline' || b === 'offline') return 'offline';
  if (a === 'permanent' || b === 'permanent') return 'permanent';
  return a ?? b;
}

let inFlight: Promise<TrackerSyncResult> | null = null;

/** Serialised, like every other outbox here: two passes would race each other. */
export function syncTrackers(userId: string, getToken: TokenGetter): Promise<TrackerSyncResult> {
  const run = (inFlight ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => push(userId, getToken));
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}

async function push(userId: string, getToken: TokenGetter): Promise<TrackerSyncResult> {
  const db = await getDb();
  const result: TrackerSyncResult = { pushed: 0, failed: 0 };
  let stalled = false;

  // DEFINITIONS FIRST, and the order is load-bearing: `tracker_entries.tracker_id`
  // is a real foreign key server-side, so an entry logged against a tracker the
  // athlete created offline would be refused with a 404 — which classifies as
  // permanent and would make the outbox give up on a perfectly good cup.
  const defs = await db.getAllAsync<TrackerRow>(
    `SELECT * FROM daily_trackers WHERE user_id = ? AND dirty = 1 ORDER BY sort_order, id`,
    userId,
  );
  for (const d of defs) {
    try {
      // **A DESTROY takes precedence over everything else on the row**, and the
      // ordering is the point: a tracker the athlete deleted must not have its
      // name, target or archive state pushed first. Those are edits to a thing
      // that is going away, and one of them failing would strand the delete.
      if (d.destroyed_at) {
        // `remote === 0` means the server never saw it, so there is nothing to
        // destroy — skipping the request is not an optimisation, it is the
        // difference between 204 and a 404 that classifies as permanent.
        if (d.remote === 1) {
          try {
            await api.destroyTracker(getToken, d.id);
          } catch (err) {
            // **A 404 means it is already gone, which is success.** The server
            // answers 204 to a repeat destroy, so this is the other device
            // having destroyed it first — or a row that never existed. Falling
            // through to the generic handler would mark the row `dirty = 0` and
            // leave the tombstone in place forever: invisible on every screen,
            // never retried, and unrecoverable because `cacheTrackers`' upsert
            // does not clear `destroyed_at`. That is the one lifecycle state
            // with no exit, so it is closed here rather than left as a shape
            // nobody would find again.
            if (!(err instanceof ApiError && err.status === 404)) throw err;
          }
        }
        // Hard-deleted only once the server confirms. Until then the tombstone
        // IS the record that a destroy is owed — same rule as a removed tap.
        await db.runAsync(
          `DELETE FROM daily_trackers WHERE id = ? AND user_id = ?`, d.id, userId);
        result.pushed += 1;
        continue;
      }

      if (d.remote === 0) {
        await api.createTracker(getToken, {
          id: d.id, name: d.name, icon: d.icon, color_key: d.color_key,
          unit: d.unit as TrackerUnit, increment: d.increment, target: d.target,
          render_style: d.render_style as RenderStyle, sort_order: d.sort_order,
          count_noun: d.count_noun, cutoff_minutes: d.cutoff_minutes,
        });
        // Created offline and then stopped before it ever reached the server.
        // Uncommon, and silently wrong without this: the create alone would put
        // a card the athlete already removed back on Today.
        if (d.archived_at) await api.archiveTracker(getToken, d.id);
      } else {
        // BEFORE the patch. A PATCH does not un-archive anything, so a restore
        // that ran afterwards would be writing fields onto a row the server
        // still considers stopped.
        if (d.restore_pending) await api.restoreTracker(getToken, d.id);
        await api.patchTracker(getToken, d.id, {
          name: d.name, icon: d.icon, color_key: d.color_key,
          unit: d.unit as TrackerUnit, increment: d.increment, target: d.target,
          render_style: d.render_style as RenderStyle, sort_order: d.sort_order,
          count_noun: d.count_noun, cutoff_minutes: d.cutoff_minutes,
        });
        // AFTER the patch, so an edit made in the same offline stretch as the
        // archive is not lost — the server accepts a patch on an archived row,
        // but doing it in this order needs no such assumption.
        if (d.archived_at) await api.archiveTracker(getToken, d.id);
      }
      // COMPARE-AND-SWAP on updated_at: an edit that landed while this push was
      // in flight leaves the row dirty for the next pass rather than being
      // silently marked sent.
      await db.runAsync(
        `UPDATE daily_trackers
            SET dirty = 0, remote = 1, restore_pending = 0, last_error = NULL
          WHERE id = ? AND user_id = ? AND updated_at = ?`,
        d.id, userId, d.updated_at,
      );
      result.pushed += 1;
    } catch (err) {
      const kind = classify(err);
      const message = err instanceof Error ? err.message : 'could not be sent';
      result.failed += 1;
      result.error = result.error ?? message;
      result.errorKind = worseKind(result.errorKind, kind);
      noteRetryAfter(result, err);
      // The same CAS on the failure branch, and for the same reason: without it
      // an edit made while this push was in flight is stomped by the failure of
      // the payload that preceded it.
      await db.runAsync(
        `UPDATE daily_trackers SET last_error = ? WHERE id = ? AND user_id = ? AND updated_at = ?`,
        message, d.id, userId, d.updated_at,
      );
      if (kind === 'permanent') {
        await db.runAsync(
          `UPDATE daily_trackers SET dirty = 0 WHERE id = ? AND user_id = ? AND updated_at = ?`,
          d.id, userId, d.updated_at,
        );
      }
      if (kind === 'offline') {
        stalled = true;
        break;
      }
    }
  }

  const rows = stalled
    ? []
    : await db.getAllAsync<{
        id: string;
        tracker_id: string;
        logged_on: string;
        logged_at: string;
        amount: number;
        updated_at: string;
        deleted_at: string | null;
      }>(
        `SELECT id, tracker_id, logged_on, logged_at, amount, updated_at, deleted_at
           FROM tracker_entries WHERE user_id = ? AND dirty = 1 ORDER BY logged_at`,
        userId,
      );

  for (const e of rows) {
    try {
      if (e.deleted_at) {
        await api.deleteEntry(getToken, e.tracker_id, e.id);
        // Hard-delete only once the server confirms. Until then the tombstone
        // IS the record that a delete is owed.
        await db.runAsync(`DELETE FROM tracker_entries WHERE id = ? AND user_id = ?`, e.id, userId);
      } else {
        await api.logEntry(getToken, e.tracker_id, e.id, {
          logged_on: e.logged_on, logged_at: e.logged_at, amount: e.amount,
        });
        await db.runAsync(
          `UPDATE tracker_entries SET dirty = 0, remote = 1, last_error = NULL
            WHERE id = ? AND user_id = ? AND updated_at = ? AND deleted_at IS NULL`,
          e.id, userId, e.updated_at,
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
      await db.runAsync(
        `UPDATE tracker_entries SET last_error = ? WHERE id = ? AND user_id = ? AND updated_at = ?`,
        message, e.id, userId, e.updated_at,
      );
      if (kind === 'permanent') {
        await db.runAsync(
          `UPDATE tracker_entries SET dirty = 0 WHERE id = ? AND user_id = ? AND updated_at = ?`,
          e.id, userId, e.updated_at,
        );
      }
      if (kind === 'offline') break;
    }
  }

  return result;
}

/**
 * Fetch the definitions and a day's entries, and cache both.
 *
 * Separate from the push so a screen can refresh without owing anything, and so
 * a failure here is a stale card rather than a lost tap.
 */
export async function fetchTrackerDay(
  userId: string,
  getToken: TokenGetter,
  on: string,
): Promise<void> {
  // Both requests in flight at once: they are independent, and this runs on
  // every focus of TWO tab screens, so a sequential pair doubles the wait for
  // no reason. Cached in order afterwards.
  const [trackers, entries] = await Promise.all([
    api.listTrackers(getToken),
    api.listEntries(getToken, { from: on, to: on }),
  ]);
  await cacheTrackers(userId, trackers);
  await cacheEntries(userId, on, on, entries);
}
