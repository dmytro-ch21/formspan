import { randomUUID } from 'expo-crypto';
import type * as SQLite from 'expo-sqlite';

import { ApiError, isNotFound, isOffline, isPermanentRejection } from '@/lib/apiError';
import { dayString } from '@/lib/calendar';
import { getDb } from '@/lib/db';
import {
  createPlan as createRemotePlan,
  deletePlan as deleteRemotePlan,
  fetchPlans,
  updatePlan as updateRemotePlan,
} from '@/lib/plansApi';
import { unsyncedWorkoutIDs } from '@/lib/sessionStore';
import type { TokenGetter } from '@/lib/useAuthToken';

/**
 * The week's plan — what the athlete intends to train, and when.
 *
 * Offline-first, exactly like sessions: **write locally, push when the
 * network allows**. The device is the one that can always be reached, so a
 * plan made on a gym floor with no signal is a plan, and the outbox carries it
 * out later.
 *
 * A plan is an *intention*, never a session. Starting a planned day creates a
 * real session through the ordinary path and the plan row is left alone — so a
 * day can be trained twice, a plan can be ignored, and nothing here has to be
 * reconciled against `local_sessions`. Deleting a session must not silently
 * un-plan the day it was on. The server holds the same line; see the
 * `plans` migration.
 */

export type PlannedSession = {
  id: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  day: string;
  sport: string;
  /** The template to start from, when the day is planned as a specific one. */
  workoutId: string | null;
  notes: string;
};

type Row = {
  id: string;
  user_id: string;
  day: string;
  sport: string;
  workout_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  dirty: number;
  remote: number;
  deleted_at: string | null;
};

function rowToPlan(r: {
  id: string;
  day: string;
  sport: string;
  workout_id: string | null;
  notes: string | null;
}): PlannedSession {
  return {
    id: r.id,
    day: r.day,
    sport: r.sport,
    workoutId: r.workout_id,
    notes: r.notes ?? '',
  };
}

/**
 * Everything planned between two calendar days, inclusive.
 *
 * String comparison works because `YYYY-MM-DD` is lexicographically ordered —
 * the reason the column is that format and not a locale-rendered date.
 *
 * Tombstoned rows are excluded: a plan the athlete has deleted must disappear
 * from every screen immediately, whether or not the server has been told yet.
 */
export async function listPlannedBetween(
  userId: string,
  from: string,
  to: string,
): Promise<PlannedSession[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    day: string;
    sport: string;
    workout_id: string | null;
    notes: string | null;
  }>(
    `SELECT id, day, sport, workout_id, notes
       FROM planned_sessions
      WHERE user_id = ? AND deleted_at IS NULL AND day >= ? AND day <= ?
      ORDER BY day ASC, created_at ASC`,
    userId,
    from,
    to,
  );
  return rows.map(rowToPlan);
}

/** What is planned for one day, in the order it was added. */
export async function plannedFor(userId: string, day: string): Promise<PlannedSession[]> {
  return listPlannedBetween(userId, day, day);
}

/**
 * Plan a day.
 *
 * The id is generated client-side, matching every other local write in this
 * app — it is what lets a row be created offline and still be referred to
 * before any server has seen it, and what makes the eventual push idempotent
 * on retry rather than duplicating.
 */
export async function planSession(
  userId: string,
  day: string,
  sport: string,
  workoutId: string | null,
  notes = '',
): Promise<PlannedSession> {
  const db = await getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO planned_sessions
       (id, user_id, day, sport, workout_id, notes, created_at, updated_at, dirty, remote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    id,
    userId,
    day,
    sport,
    workoutId,
    notes,
    now,
    now,
  );
  return { id, day, sport, workoutId, notes };
}

/**
 * Remove one planned entry.
 *
 * **ALWAYS a tombstone — never a hard delete here**, however certain we look
 * that the server has not seen the row. `deleteLocalSession` in `sessionStore`
 * makes the same unconditional choice, and this function briefly did not,
 * which was a bug:
 *
 *   1. a sync is mid-flight, awaiting `createRemotePlan` for this row, which
 *      still reads `remote = 0` because that flag is only set once the create
 *      RESOLVES;
 *   2. the athlete taps Remove, reads `remote = 0`, and hard-deletes;
 *   3. the create lands — its `SET remote = 1` and the CAS both match zero
 *      rows and raise nothing;
 *   4. the pull, in the same run, finds no tombstone (a hard delete leaves
 *      none) and no local row, so both the `buried` and `dirty` guards are
 *      vacuous, and it re-inserts the plan.
 *
 * The plan the athlete just deleted reappears seconds later. The window is the
 * whole duration of a network round trip, which on a phone is not small.
 *
 * The hard delete still exists — in `pushRow`, INSIDE the serialised sync,
 * where `remote` is finally trustworthy and no create can be in flight. That
 * is the only place the question can be answered correctly.
 */
export async function unplanSession(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE planned_sessions SET deleted_at = ?, updated_at = ?, dirty = 1
      WHERE id = ? AND user_id = ?`,
    now,
    now,
    id,
    userId,
  );
}

/** Ids this device has buried but not yet told the server about. */
export async function tombstonedPlanIDs(userId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM planned_sessions WHERE user_id = ? AND deleted_at IS NOT NULL`,
    userId,
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * How many plans are owed to the server.
 *
 * Tombstones count: a delete that has not reached the server is as unsynced as
 * a create that hasn't.
 */
export async function countPendingPlans(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM planned_sessions WHERE user_id = ? AND dirty = 1`,
    userId,
  );
  return row?.n ?? 0;
}

export type PlanSyncResult = {
  pushed: number;
  pulled: number;
  failed: number;
  /** Held back because the workout they reference has not synced yet. */
  deferred: number;
  error?: string;
  errorKind?: 'offline' | 'permanent' | 'transient';
};

function classify(err: unknown): 'offline' | 'permanent' | 'transient' {
  if (isOffline(err)) return 'offline';
  if (isPermanentRejection(err)) return 'permanent';
  return 'transient';
}

/** Keep the most actionable classification seen this run. */
function worseKind(
  a: PlanSyncResult['errorKind'],
  b: NonNullable<PlanSyncResult['errorKind']>,
): NonNullable<PlanSyncResult['errorKind']> {
  if (a === 'offline' || b === 'offline') return 'offline';
  if (a === 'permanent' || b === 'permanent') return 'permanent';
  return 'transient';
}

/**
 * Serialised, like `syncSessions`.
 *
 * Two overlapping runs would push the same dirty rows twice and interleave
 * their pulls, and the pull's compare-and-swap is only sound if one run at a
 * time is writing.
 */
let inFlight: Promise<PlanSyncResult> | null = null;

export function syncPlans(userId: string, getToken: TokenGetter): Promise<PlanSyncResult> {
  const run = (inFlight ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => runSync(userId, getToken));
  inFlight = run.catch(
    () => ({ pushed: 0, pulled: 0, failed: 0, deferred: 0 }) as PlanSyncResult,
  );
  return run;
}

/**
 * The window the pull reconciles.
 *
 * Deliberately bounded and anchored on today rather than "everything": the
 * plan is a forward-looking artifact, the screens only ever render the current
 * week and the browsed month, and an unbounded pull would grow forever for a
 * table nobody scrolls back through. Wide enough that paging a month either
 * way is already local.
 */
const PULL_BEFORE_DAYS = 45;
const PULL_AFTER_DAYS = 120;

/**
 * Whether `a` is at or before `b`, comparing instants rather than strings.
 *
 * An unparseable timestamp returns false — "do not treat this as stale" — so a
 * malformed value can never be the reason a pull is skipped.
 */
function olderOrSame(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta <= tb;
}

function pullWindow(now: Date): { from: string; to: string } {
  const from = new Date(now);
  from.setDate(from.getDate() - PULL_BEFORE_DAYS);
  const to = new Date(now);
  to.setDate(to.getDate() + PULL_AFTER_DAYS);
  return { from: dayString(from), to: dayString(to) };
}

async function runSync(userId: string, getToken: TokenGetter): Promise<PlanSyncResult> {
  const db = await getDb();
  const result: PlanSyncResult = { pushed: 0, pulled: 0, failed: 0, deferred: 0 };

  const dirty = await db.getAllAsync<Row>(
    `SELECT * FROM planned_sessions WHERE user_id = ? AND dirty = 1 ORDER BY day`,
    userId,
  );

  /**
   * Ids this run pushed, excluded from the "deleted elsewhere" sweep below.
   *
   * Our own write is newer information than any list we fetch. Without this,
   * a plan created and pushed in this pass is deleted again moments later by
   * the sweep whenever the fetched list does not echo it back — a lagging
   * read replica, or simply a server that has not committed by the time the
   * list query runs. The row would vanish from under the athlete seconds
   * after they planned it, and the next pull would bring it back.
   */
  const pushedThisRun = new Set<string>();

  // Workouts the server still has not acknowledged.
  //
  // `plans.workout_id` is a real FK server-side, so a plan referencing a
  // workout the server has never seen is refused with a 4xx — which classifies
  // as `permanent` and would make the orchestrator give up on a plan that is
  // perfectly fine. Sessions carry the identical guard for the identical
  // reason; this relies on `syncSessions` having already run this pass, which
  // is why the orchestrator calls it first.
  const unsynced = await unsyncedWorkoutIDs(userId);

  for (const row of dirty) {
    // Held back, and NOT counted as a failure — it is waiting on a dependency,
    // not broken. It stays dirty and goes out on the next pass.
    if (!row.deleted_at && row.workout_id && unsynced.has(row.workout_id)) {
      result.deferred++;
      continue;
    }
    try {
      await pushRow(db, row, userId, getToken);
      result.pushed++;
      pushedThisRun.add(row.id);
      await noteRowError(db, row.id, userId, null);
    } catch (err) {
      result.failed++;
      result.error = err instanceof Error ? err.message : String(err);
      result.errorKind = worseKind(result.errorKind, classify(err));
      await noteRowError(db, row.id, userId, err);
    }
  }

  try {
    // ONE window, computed once and used for both the fetch and the sweep
    // below.
    //
    // These were two independent `pullWindow(new Date())` calls. If local
    // midnight fell between them the sweep's window sat a day ahead of the one
    // actually fetched, so its last day had never been asked about — and every
    // clean plan on that day was absent from the response, absent from
    // `pushedThisRun`, and deleted. Deleting on evidence you did not request is
    // the wrong shape for the most destructive operation in this module.
    const window = pullWindow(new Date());
    const remote = await fetchPlans(getToken, window);

    // **Prove the response is this user's before reading ANY of it.**
    //
    // `getToken` follows the *current* Clerk user, while this run holds the
    // `userId` it started with, and `setSyncIdentity` does not abort a run in
    // flight. So an account switch mid-run hands us user B's plans while every
    // write below is scoped to user A. Two separate harms, which is why this
    // guards the whole reconciliation and not just the sweep: the loop would
    // ADOPT B's plans into A's account (it inserts with the local `userId`),
    // and the sweep would then delete all of A's real plans as "missing".
    //
    // The same check covers a 200 whose body is not the shape we expect, since
    // `fetchPlans` turns that into `[]` — otherwise indistinguishable from
    // "the server has nothing", which empties the table.
    //
    // Abandoning the pull is always safe: stale local rows are cosmetic and
    // the next good sync fixes them. A wrongly-deleted plan is not
    // recoverable, and a plan adopted from another account is a privacy leak.
    if (remote.some((r) => r.user_id !== userId)) {
      return result;
    }
    // Ids this device has deleted but hasn't managed to tell the server about.
    // The server still lists them, so without this the pull writes each one
    // straight back — the exact resurrection tombstones exist to stop.
    const buried = await tombstonedPlanIDs(userId);

    for (const r of remote) {
      if (buried.has(r.id)) continue;
      // Anything this run pushed is skipped, and that covers DELETES as well
      // as creates — a successful delete removes the tombstone, so `buried` no
      // longer knows about it and the row is gone locally, which makes both
      // guards below vacuous. A server that still lists it (a lagging read
      // replica, or a list query that raced the delete's commit) would then be
      // re-inserted as a brand new plan.
      //
      // Same principle as the sweep's use of this set: our own write, which we
      // watched succeed, is newer information than any list we fetch.
      if (pushedThisRun.has(r.id)) continue;
      const local = await db.getFirstAsync<{ dirty: number; updated_at: string }>(
        `SELECT dirty, updated_at FROM planned_sessions WHERE id = ? AND user_id = ?`,
        r.id,
        userId,
      );
      // The device is authoritative for anything it is still holding dirty.
      if (local?.dirty === 1) continue;
      // Refuse to go backwards: if the local row is newer than the copy we
      // fetched, this snapshot is stale and writing it would erase whatever
      // landed in between.
      //
      // Compared as INSTANTS, not strings. Local writes are
      // `toISOString()` (always `Z`, always three fraction digits); the
      // server's is Go RFC3339Nano, which trims trailing zeros from the
      // fraction — so `.1Z` vs `.15Z` compares wrong lexicographically ('Z'
      // sorts above '5'), and a non-UTC offset would sort below every digit
      // and turn this into "refuse every pull".
      if (local && olderOrSame(r.updated_at, local.updated_at)) continue;

      // NOTE: this WHERE is the one guard in this function the suite cannot
      // pin by mutation — it is a backstop for an interleaving (a user write
      // landing between the SELECT above and this statement) that the test
      // harness cannot orchestrate, and the two JS guards above already cover
      // every state a test can construct. Deleting it turns nothing red. It
      // stays because the race is real on a device, and because the failure it
      // prevents is permanent and silent.
      //
      // The two guards above are re-stated in the UPDATE's own WHERE, because
      // the read above and this write are separate round trips and a user
      // write can interleave between them. Two outcomes if it does, both bad
      // and one permanent: a row tombstoned in the gap gets `dirty = 0` while
      // `deleted_at` stays set, which makes it invisible to every read, to the
      // push, to the sweep and to the pending count — gone from the phone and
      // alive on the server, forever; and a row edited in the gap is marked
      // already-sent and never pushed. Moving the checks into the statement
      // makes the read and the write one operation.
      await db.runAsync(
        `INSERT INTO planned_sessions
           (id, user_id, day, sport, workout_id, notes, created_at, updated_at, dirty, remote)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
         ON CONFLICT(id) DO UPDATE SET
           day = excluded.day,
           sport = excluded.sport,
           workout_id = excluded.workout_id,
           notes = excluded.notes,
           updated_at = excluded.updated_at,
           dirty = 0,
           remote = 1,
           last_error = NULL
         WHERE planned_sessions.dirty = 0
           AND planned_sessions.deleted_at IS NULL`,
        r.id,
        userId,
        r.day,
        r.sport,
        r.workout_id,
        r.notes ?? '',
        r.created_at,
        r.updated_at,
      );
      result.pulled++;
    }

    // Anything the server no longer has, that we believed it did, is gone.
    //
    // Without this a plan removed on the web stays on the phone forever: the
    // pull only ever writes rows it received, so a deletion elsewhere is
    // invisible. Scoped to the pulled window and to rows that are clean and
    // `remote` — a dirty row is a local edit in flight, and a `remote = 0` row
    // was never on the server to be missing from its response.
    //
    // The response was proven to be this user's before the pull loop above ran
    // — see the guard right after `fetchPlans`.
    const seen = new Set(remote.map((r) => r.id));
    const local = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM planned_sessions
        WHERE user_id = ? AND dirty = 0 AND remote = 1 AND deleted_at IS NULL
          AND day >= ? AND day <= ?`,
      userId,
      window.from,
      window.to,
    );
    for (const row of local) {
      if (seen.has(row.id) || pushedThisRun.has(row.id)) continue;
      await db.runAsync(`DELETE FROM planned_sessions WHERE id = ? AND user_id = ?`, row.id, userId);
    }
  } catch (err) {
    if (result.failed === 0) {
      result.failed++;
      result.error = err instanceof Error ? err.message : String(err);
    }
    result.errorKind = worseKind(result.errorKind, classify(err));
  }

  return result;
}

async function pushRow(
  db: SQLite.SQLiteDatabase,
  row: Row,
  userId: string,
  getToken: TokenGetter,
): Promise<void> {
  if (row.deleted_at) {
    // Never pushed, so there is nothing to tell the server. Decided HERE, not
    // at delete time, because `remote` is only trustworthy inside the
    // serialised sync.
    if (row.remote === 0) {
      await db.runAsync(`DELETE FROM planned_sessions WHERE id = ? AND user_id = ?`, row.id, userId);
      return;
    }
    try {
      await deleteRemotePlan(getToken, row.id);
    } catch (err) {
      if (isNotFound(err)) {
        // The server agreeing it is gone IS the state being asked for.
      } else if (isPermanentRejection(err)) {
        // It will refuse identically forever. Keeping the tombstone would hide
        // the plan for the life of the install while `pending` never reached
        // zero. Restore it: the plan was not deleted.
        await db.runAsync(
          `UPDATE planned_sessions SET deleted_at = NULL, dirty = 0 WHERE id = ? AND user_id = ?`,
          row.id,
          userId,
        );
        throw err;
      } else {
        throw err;
      }
    }
    await db.runAsync(`DELETE FROM planned_sessions WHERE id = ? AND user_id = ?`, row.id, userId);
    return;
  }

  const payload = {
    day: row.day,
    sport: row.sport,
    workout_id: row.workout_id,
    notes: row.notes ?? '',
  };

  if (row.remote === 0) {
    try {
      await createRemotePlan(getToken, { id: row.id, ...payload });
    } catch (err) {
      // Already there — this device pushed it and lost the response, or a
      // retry overlapped. The id is ours, so a 409 means *our* row is on the
      // server; bring it up to date rather than failing forever.
      //
      // Without this branch the offline retry story has a hole exactly where
      // it matters: a create that succeeds server-side but whose response
      // never arrives leaves the row dirty, and every subsequent attempt gets
      // the same 409 — a permanent classification, so the orchestrator stops
      // and reports a perfectly good plan as doomed.
      if (err instanceof ApiError && err.status === 409) {
        await updateRemotePlan(getToken, row.id, payload);
      } else {
        throw err;
      }
    }
    await db.runAsync(
      `UPDATE planned_sessions SET remote = 1 WHERE id = ? AND user_id = ?`,
      row.id,
      userId,
    );
  } else {
    await updateRemotePlan(getToken, row.id, payload);
  }

  await db.runAsync(
    `UPDATE planned_sessions SET dirty = 0 WHERE id = ? AND user_id = ?
     -- Only if nothing changed underneath us mid-push, or we would mark a
     -- newer edit as already sent and silently drop it.
     AND updated_at = ?
     -- And never on a row that became a TOMBSTONE while this push was in
     -- flight. updated_at is millisecond-resolution ISO text, so a delete
     -- landing in the same millisecond as the snapshot produces an identical
     -- string and the CAS above matches -- marking the tombstone as already
     -- sent. The delete is then never pushed: the plan is gone from the phone
     -- and alive on the server forever, with pending reading zero so nothing
     -- ever retries. Observed in a test, not theorised.
     AND deleted_at IS NULL`,
    row.id,
    userId,
    row.updated_at,
  );
}

/**
 * Record — or clear — why one plan could not sync.
 *
 * Only PERMANENT rejections are stored, matching `sessionStore.noteRowError`:
 * a transient failure is the ordinary state of a phone in a basement, and
 * writing "Network request failed" onto every row would turn a repair list
 * into a list of everything ever planned offline.
 */
async function noteRowError(
  db: SQLite.SQLiteDatabase,
  id: string,
  userId: string,
  err: unknown,
): Promise<void> {
  if (err !== null && !isPermanentRejection(err)) return;
  const message = err === null ? null : err instanceof Error ? err.message : String(err);
  await db.runAsync(
    `UPDATE planned_sessions SET last_error = ? WHERE id = ? AND user_id = ?`,
    message,
    id,
    userId,
  );
}
