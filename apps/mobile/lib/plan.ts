import { randomUUID } from 'expo-crypto';
import type * as SQLite from 'expo-sqlite';

import {
  ApiError,
  isNotFound,
  isPermanentRejection,
  isTransportFailure,
  retryAfterOf,
} from '@/lib/apiError';
import { dayString } from '@/lib/calendar';
import { getDb } from '@/lib/db';
import { BLOCKED_ROW, REFUSED_ROW } from '@/lib/outboxPredicates';
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
 * day can be trained twice, a plan can be ignored, and deleting a session
 * cannot silently un-plan the day it was on. **Nothing in this module writes a
 * completion status, and there is no column for one.** The server holds the
 * same line; see the `plans` migration.
 *
 * What a *reader* sees is a different question, and `lib/adherence.ts` answers
 * it: a plan met by a logged session stops being drawn as a second, pending
 * row. That is computed on every read from these rows and the session rows,
 * so it cannot drift out of step with either. This module deliberately knows
 * nothing about it — `listPlannedBetween` returns every plan, met or not,
 * because the Plan tab exists to edit them.
 */

export type PlannedSession = {
  id: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  day: string;
  sport: string;
  /** The template to start from, when the day is planned as a specific one. */
  workoutId: string | null;
  /**
   * N442: the coach's class plan this day is scheduled from, instead of a
   * workout template — mutually exclusive with `workoutId` server-side.
   *
   * READ-ONLY on this platform. Scheduling a class is a web-only action (the
   * same split N440/N441 already draw between authoring/scheduling and
   * running), so nothing in this module ever sets it on a local write —
   * `planSession` below has no parameter for it. It only ever arrives
   * through a sync pull, exactly like a class plan name it might resolve to.
   */
  classPlanId: string | null;
  /**
   * N126/#520: when on `day` this is planned for, or `null` when the athlete
   * gave only a day. Minutes since LOCAL midnight, wall-clock, no timezone
   * attached — e.g. `1140` for 7:00 PM. Never converted through any zone,
   * exactly like `day` itself: "7pm" means 7pm wherever the athlete is
   * standing that day. See `db.ts`'s `time_of_day_minutes` column comment for
   * the full reasoning (a plain integer rather than a stored clock string, so
   * sorting is a numeric ORDER BY and there is no time-string parsing on
   * either side of a sync round trip).
   *
   * `null` is a real, permanent state, not a default of midnight (`0`) —
   * every plan made before this field existed has it, and it renders as "day
   * only" forever rather than a guessed time.
   */
  timeOfDayMinutes: number | null;
  notes: string;
};

type Row = {
  id: string;
  user_id: string;
  day: string;
  sport: string;
  workout_id: string | null;
  class_plan_id: string | null;
  time_of_day_minutes: number | null;
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
  class_plan_id: string | null;
  time_of_day_minutes: number | null;
  notes: string | null;
}): PlannedSession {
  return {
    id: r.id,
    day: r.day,
    sport: r.sport,
    workoutId: r.workout_id,
    classPlanId: r.class_plan_id,
    timeOfDayMinutes: r.time_of_day_minutes,
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
    class_plan_id: string | null;
    time_of_day_minutes: number | null;
    notes: string | null;
  }>(
    `SELECT id, day, sport, workout_id, class_plan_id, time_of_day_minutes, notes
       FROM planned_sessions
      WHERE user_id = ? AND deleted_at IS NULL AND day >= ? AND day <= ?
      -- N126/#520: within a day, ordered by time_of_day_minutes ascending
      -- with untimed plans LAST. SQLite (unlike Postgres) has no NULLS LAST,
      -- so "(time_of_day_minutes IS NULL)" is the portable substitute —
      -- FALSE (0) sorts before TRUE (1), which puts every timed plan ahead
      -- of every untimed one before the numeric comparison even runs.
      -- created_at is the tiebreak for two plans that share a time, or share
      -- having none — the original "insertion order within a day" behavior,
      -- preserved for everything this column cannot distinguish.
      ORDER BY day ASC, (time_of_day_minutes IS NULL) ASC, time_of_day_minutes ASC, created_at ASC`,
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
  timeOfDayMinutes: number | null = null,
): Promise<PlannedSession> {
  const db = await getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO planned_sessions
       (id, user_id, day, sport, workout_id, time_of_day_minutes, notes, created_at, updated_at, dirty, remote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    id,
    userId,
    day,
    sport,
    workoutId,
    timeOfDayMinutes,
    notes,
    now,
    now,
  );
  // classPlanId: null — this device never schedules a class; see
  // PlannedSession.classPlanId's own comment.
  return { id, day, sport, workoutId, classPlanId: null, timeOfDayMinutes, notes };
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
 *
 * **It also clears `last_error` (N564/#1106).** A recorded refusal describes
 * the request that was refused — a create, usually — and removing the plan
 * replaces that request with a different one. Kept, the stale reason would
 * ride on the tombstone: harmless to the counters (`BLOCKED_ROW` excludes
 * tombstones, so it is still pending and still sent), but wrong about what the
 * phone is now trying to do, and a later refusal of the delete would be
 * indistinguishable from the old one until `noteRowError` overwrote it.
 *
 * This is ONE of the two local edits a plan has on this device — the other is
 * `planSession`, whose INSERT starts every row with `last_error` NULL. There
 * is no update path: a plan is changed on the phone by removing it and
 * planning the day again. `planRefused.test.ts` pins that list against this
 * module's exports, so a third edit path cannot arrive without being asked
 * whether it clears the refusal.
 *
 * It is also the recovery the sync screen offers for a refused plan: the
 * athlete's own Remove, not a second, subtly different delete.
 */
export async function unplanSession(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE planned_sessions SET deleted_at = ?, updated_at = ?, dirty = 1, last_error = NULL
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
 * How many plans are owed to the server and will go out on their own.
 *
 * Tombstones count: a delete that has not reached the server is as unsynced as
 * a create that hasn't — including a tombstone that still carries an old
 * refusal, which `BLOCKED_ROW` deliberately does not class as blocked.
 *
 * **Blocked plans do not count (N564/#1106).** This used to be every
 * `dirty = 1` row, and the push loop never clears `dirty` on a refusal — so a
 * plan the server refused permanently counted here for the life of the
 * install. `pending` gates the backoff timer and the foreground trigger, so
 * the refused request was re-sent on every app open and the badge never
 * reached zero. Those rows are counted by {@link countRefusedPlans} instead,
 * into `SyncState.needsAttention`, and the two share `BLOCKED_ROW` so that
 * pending + blocked covers every owed plan exactly once.
 */
export async function countPendingPlans(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM planned_sessions
      WHERE user_id = ? AND dirty = 1 AND NOT (${BLOCKED_ROW})`,
    userId,
  );
  return row?.n ?? 0;
}

/**
 * The plans that need a person — N564/#1106. Shared by {@link refusedPlans} and
 * {@link countRefusedPlans}, so the list and the number cannot disagree.
 *
 * Two states, and a plan is in at most one of them because they differ on
 * `dirty`:
 *
 * - **`BLOCKED_ROW`** — the plan itself was refused (a create, in practice) and
 *   is still owed. Excluded from pending by the same constant.
 * - **`REFUSED_ROW`** — the athlete removed the plan and the server refused the
 *   delete. `pushRow` does not leave that as a tombstone: it puts the plan back
 *   (`deleted_at = NULL, dirty = 0`) because a tombstone the server will refuse
 *   forever would hide the plan for the life of the install. So the refusal
 *   lands on a live, clean row — not owed, so never pending — and before this
 *   list it was shown nowhere: the plan simply reappeared on the calendar with
 *   no word about why.
 *
 * **Where a refused TOMBSTONE goes, deliberately.** Two shapes, two answers:
 *
 * 1. A tombstone whose delete was refused never stays one — it becomes the
 *    `REFUSED_ROW` state above and is listed here, as a removal that did not
 *    happen, with the server's reason. That is the case the athlete can see
 *    (the plan came back), so it is the one that has to be explained.
 * 2. A tombstone still CARRYING an error (`dirty = 1`, `deleted_at` set) —
 *    a refusal recorded before the removal on an install older than
 *    `unplanSession` clearing it, or the athlete removing the plan again in the
 *    instant between `pushRow`'s restore and `noteRowError` — is PENDING, and
 *    not listed. It is owed and goes out on its own (`remote = 0`: dropped
 *    locally; otherwise the delete is sent), it has nothing to open, and
 *    listing it would show the athlete a plan they have already removed. This
 *    matches sessions and workouts exactly, because it is the same constant.
 */
const PLAN_NEEDS_ATTENTION = `((${BLOCKED_ROW}) OR (${REFUSED_ROW}))`;

/** A plan on the sync screen's repair list. */
export type RefusedPlan = PlannedSession & {
  /** The server's own words. Never paraphrased — see `app/sync.tsx`. */
  reason: string;
  /**
   * `'plan'` — the plan was refused and is still queued; the recovery is to
   * remove it (and plan the day again, correctly). `'removal'` — the athlete
   * removed it, the server refused, and the plan is back; the recovery is to
   * keep it, because the phone cannot delete what the server will not.
   */
  refused: 'plan' | 'removal';
  /** The template's name, when the plan names one this device has cached. */
  workoutName: string | null;
};

/**
 * Every plan waiting on a person, soonest day first.
 *
 * The workout's name is a correlated subquery rather than a JOIN on purpose:
 * `workout_cache` shares `id`, `user_id`, `dirty`, `deleted_at` and
 * `last_error` with this table, so a join makes the unqualified columns here
 * and in the shared predicates ambiguous. Measured, not assumed: rewritten as a
 * LEFT JOIN, SQLite refuses the statement with `ambiguous column name: id`
 * and nine tests in `planRefused.test.ts` go red. See `outboxPredicates.ts`'s
 * interpolation rule.
 */
export async function refusedPlans(userId: string): Promise<RefusedPlan[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    day: string;
    sport: string;
    workout_id: string | null;
    class_plan_id: string | null;
    time_of_day_minutes: number | null;
    notes: string | null;
    last_error: string;
    dirty: number;
    workout_name: string | null;
  }>(
    `SELECT id, day, sport, workout_id, class_plan_id, time_of_day_minutes, notes,
            last_error, dirty,
            (SELECT w.name FROM workout_cache w
              WHERE w.id = planned_sessions.workout_id
                AND w.user_id = planned_sessions.user_id) AS workout_name
       FROM planned_sessions
      WHERE user_id = ? AND ${PLAN_NEEDS_ATTENTION}
      ORDER BY day ASC, created_at ASC`,
    userId,
  );
  return rows.map((r) => ({
    ...rowToPlan(r),
    reason: r.last_error,
    // `dirty` is what separates the two halves of PLAN_NEEDS_ATTENTION.
    refused: r.dirty === 1 ? ('plan' as const) : ('removal' as const),
    workoutName: r.workout_name,
  }));
}

/**
 * How many plans {@link refusedPlans} would list — one half of
 * `SyncState.needsAttention`'s plan share. Built on the same constant.
 */
export async function countRefusedPlans(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM planned_sessions WHERE user_id = ? AND ${PLAN_NEEDS_ATTENTION}`,
    userId,
  );
  return row?.n ?? 0;
}

/**
 * Keep a plan whose removal the server refused, and stop listing it.
 *
 * The only recovery that exists for that state on this device. The server
 * still has the plan and will refuse the delete identically, so sending it
 * again changes nothing; discarding the local row changes nothing either,
 * because the next pull puts it straight back. What the athlete can decide is
 * that they have seen it — so this clears the reason and leaves the plan where
 * it is, which moves it off the repair list and out of `needsAttention`
 * without sending anything.
 *
 * Compare-and-swap on `REFUSED_ROW`: a plan that has moved on since the list
 * was read (removed again, or overwritten by a newer pull) is left alone.
 * Returns whether anything changed.
 */
export async function acknowledgeRefusedRemoval(userId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE planned_sessions SET last_error = NULL
      WHERE id = ? AND user_id = ? AND ${REFUSED_ROW}`,
    id,
    userId,
  );
  return r.changes > 0;
}

export type PlanSyncResult = {
  pushed: number;
  pulled: number;
  failed: number;
  /** Held back because the workout they reference has not synced yet. */
  deferred: number;
  error?: string;
  errorKind?: 'offline' | 'permanent' | 'transient';
  /** The largest `Retry-After` seen this run, in ms (F17, #403). */
  retryAfterMs?: number;
};

function classify(err: unknown): 'offline' | 'permanent' | 'transient' {
  if (isTransportFailure(err)) return 'offline';
  if (isPermanentRejection(err)) return 'permanent';
  return 'transient';
}

/** Fold one failure's `Retry-After` into the run's running maximum. */
function noteRetryAfter(result: { retryAfterMs?: number }, err: unknown): void {
  const ms = retryAfterOf(err);
  if (ms != null) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, ms);
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
      noteRetryAfter(result, err);
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
           (id, user_id, day, sport, workout_id, class_plan_id, time_of_day_minutes, notes, created_at, updated_at, dirty, remote)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
         ON CONFLICT(id) DO UPDATE SET
           day = excluded.day,
           sport = excluded.sport,
           workout_id = excluded.workout_id,
           class_plan_id = excluded.class_plan_id,
           time_of_day_minutes = excluded.time_of_day_minutes,
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
        r.class_plan_id,
        r.time_of_day_minutes,
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
    noteRetryAfter(result, err);
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
        //
        // The caller's `noteRowError` then records why on the restored row,
        // which is what puts it on the sync screen (`REFUSED_ROW`, see
        // `PLAN_NEEDS_ATTENTION`) instead of reappearing unexplained.
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
    time_of_day_minutes: row.time_of_day_minutes,
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
