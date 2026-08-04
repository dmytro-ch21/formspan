import { randomUUID } from 'expo-crypto';
import type * as SQLite from 'expo-sqlite';

import { ApiError, isNotFound, isOffline, isPermanentRejection } from '@/lib/apiError';
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

/**
 * A `Date` as the local calendar day it falls on.
 *
 * Built from the local getters rather than `toISOString()`, which converts to
 * UTC first — so for anyone west of Greenwich an evening session lands on
 * tomorrow's date, and the plan they made for Tuesday shows up on Monday.
 */
export function dayString(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Monday 00:00 local — the same week boundary the Today screen uses. */
export function startOfWeek(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // getDay() is 0 on Sunday, which is six days into the week, not minus one.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** The seven `Date`s of the week containing `now`, Monday first. */
export function weekDays(now: Date): Date[] {
  const monday = startOfWeek(now);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

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
 * **A tombstone when the server has seen it, a hard delete when it hasn't.**
 * Deleting a row the server knows about would leave the server's copy alive
 * and the next pull would write it straight back — the resurrection the
 * sessions module already learned about the hard way. A row that has never
 * been pushed has nothing to tell anyone, so it simply goes.
 *
 * `remote` is read inside this function rather than trusted from a caller,
 * but the *decision* is re-checked in the push path too: `remote` is only
 * fully trustworthy inside the serialised sync.
 */
export async function unplanSession(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ remote: number }>(
    `SELECT remote FROM planned_sessions WHERE id = ? AND user_id = ?`,
    id,
    userId,
  );
  if (!row) return;

  if (row.remote === 0) {
    await db.runAsync(`DELETE FROM planned_sessions WHERE id = ? AND user_id = ?`, id, userId);
    return;
  }
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
    const remote = await fetchPlans(getToken, pullWindow(new Date()));
    // Ids this device has deleted but hasn't managed to tell the server about.
    // The server still lists them, so without this the pull writes each one
    // straight back — the exact resurrection tombstones exist to stop.
    const buried = await tombstonedPlanIDs(userId);

    for (const r of remote) {
      if (buried.has(r.id)) continue;
      const local = await db.getFirstAsync<{ dirty: number; updated_at: string }>(
        `SELECT dirty, updated_at FROM planned_sessions WHERE id = ? AND user_id = ?`,
        r.id,
        userId,
      );
      // The device is authoritative for anything it is still holding dirty.
      if (local?.dirty === 1) continue;
      // Refuse to go backwards: if the local row is newer than the copy we
      // fetched, this snapshot is stale and writing it would erase whatever
      // landed in between. The push side guards its own version of this with a
      // CAS on `updated_at`; the pull side needs the same check.
      if (local && local.updated_at > r.updated_at) continue;

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
           last_error = NULL`,
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
    const seen = new Set(remote.map((r) => r.id));
    const window = pullWindow(new Date());
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
     AND updated_at = ?`,
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
