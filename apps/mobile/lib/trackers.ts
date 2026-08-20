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
import { isOffline, isPermanentRejection } from './apiError';
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
  archived_at: string | null;
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
      WHERE user_id = ? AND archived_at IS NULL
      ORDER BY sort_order, id`,
    userId,
  );
  if (rows.length > 0) return { state: 'ready', trackers: rows.map(toTracker) };
  // Zero rows is ambiguous: never fetched, or fetched and genuinely empty
  // (every tracker archived). Distinguished by whether ANY row exists for this
  // athlete, archived included — which is why archiving is a timestamp rather
  // than a delete on this side too.
  const any = await db.getFirstAsync<{ n: number }>(
    `SELECT count(*) AS n FROM daily_trackers WHERE user_id = ?`,
    userId,
  );
  return (any?.n ?? 0) > 0 ? { state: 'ready', trackers: [] } : { state: 'unknown' };
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
    for (const t of trackers) {
      await db.runAsync(
        `INSERT INTO daily_trackers (
           id, user_id, preset, name, icon, color_key, unit, increment, target,
           render_style, sort_order, archived_at, updated_at, dirty, remote)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)
         ON CONFLICT(id) DO UPDATE SET
           preset = excluded.preset, name = excluded.name, icon = excluded.icon,
           color_key = excluded.color_key, unit = excluded.unit,
           increment = excluded.increment, target = excluded.target,
           render_style = excluded.render_style, sort_order = excluded.sort_order,
           archived_at = excluded.archived_at, remote = 1
         WHERE daily_trackers.dirty = 0`,
        t.id, userId, t.preset, t.name, t.icon, t.color_key, t.unit, t.increment,
        t.target, t.render_style, t.sort_order, t.archived_at, t.updated_at,
      );
    }
  });
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
};

function classify(err: unknown): 'offline' | 'permanent' | 'transient' {
  if (isOffline(err)) return 'offline';
  if (isPermanentRejection(err)) return 'permanent';
  return 'transient';
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
      if (d.remote === 0) {
        await api.createTracker(getToken, {
          id: d.id, name: d.name, icon: d.icon, color_key: d.color_key,
          unit: d.unit as TrackerUnit, increment: d.increment, target: d.target,
          render_style: d.render_style as RenderStyle, sort_order: d.sort_order,
        });
      } else {
        await api.patchTracker(getToken, d.id, {
          name: d.name, icon: d.icon, color_key: d.color_key,
          unit: d.unit as TrackerUnit, increment: d.increment, target: d.target,
          render_style: d.render_style as RenderStyle, sort_order: d.sort_order,
        });
      }
      // COMPARE-AND-SWAP on updated_at: an edit that landed while this push was
      // in flight leaves the row dirty for the next pass rather than being
      // silently marked sent.
      await db.runAsync(
        `UPDATE daily_trackers SET dirty = 0, remote = 1, last_error = NULL
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
  const trackers = await api.listTrackers(getToken);
  await cacheTrackers(userId, trackers);
  const entries = await api.listEntries(getToken, { from: on, to: on });
  await cacheEntries(userId, on, on, entries);
}
