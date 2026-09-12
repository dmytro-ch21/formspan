import { localCheckinView, localPhaseView } from '../../bodyCache';
import { dayString } from '../../calendar';
import { assembleDay, type DayFact, type DayPanel, type RowRef } from '../../dayPanel';
import { localEntries as localFoodEntries, localTargetView } from '../../foodLog';
import type { Module } from '../../modules';
import { listPlannedBetween } from '../../plan';
import { cachedWorkouts, listLocalSessions } from '../../sessionStore';
import { buildTodayBoard, todayPlanWindow } from '../../todayBoard';
import { localEntries as localTrackerEntries, localTrackers } from '../../trackers';
import type { Source } from '../../trainBoard';
import type { FixtureDb } from './sqlite';

/**
 * N541 (#972) — every fact the day panel asserts, checked against SQLite.
 *
 * Returns one line per problem, so a passing check is `[]` and a failing one
 * says which fact and which row. Three problems count:
 *
 * - **A fact with no rows at all.** Provenance that is an empty list is not
 *   provenance, and `assembleDay`'s `done` branch has exactly that fallback.
 * - **A row that is not there** — never written, written for another athlete,
 *   or tombstoned. A tombstoned plan is the sharp case: the athlete deleted it,
 *   the row still exists, and a panel that still named it would be asserting an
 *   intention they withdrew.
 * - **A cached fact claiming a fresher time than its row (N568).** A cached
 *   check-in or phase is only as current as the fetch that last returned it, so
 *   its ref names that `fetched_at` and must match the row. A cached row the
 *   server no longer has is DELETED by the next fetch that covers it, and a
 *   phase that ended is no longer a phase goal — both then report here.
 *
 * **This is the invariant tranche 2's fabricated-fact guard extends**, not a
 * test detail. Narration that cites a key outside `panelFacts`, or a fact whose
 * rows this reports, is the failure the ticket names — "an LLM returns a
 * session that is not in the plan" — and it is answered here by asking the
 * database, which is the one party in the test that cannot be talked into
 * agreeing with the code.
 */
export async function unbackedFacts(
  db: FixtureDb,
  userId: string,
  facts: DayFact[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const fact of facts) {
    if (fact.refs.length === 0) {
      problems.push(`${fact.key}: no rows behind it`);
      continue;
    }
    for (const ref of fact.refs) {
      if (!(await rowExists(db, userId, ref))) {
        problems.push(`${fact.key}: ${describe(ref)} is not a live row for ${userId}`);
      }
    }
  }
  return problems;
}

async function settle<T>(p: Promise<T>): Promise<Source<T>> {
  return p.then(
    (value) => ({ state: 'ready', value }),
    () => ({ state: 'unavailable' }),
  );
}

/**
 * The day, read the way `useDayPanel` reads it: the same functions, the same
 * 30-session cap, the same plan window `useTodayBoard` asks for.
 *
 * A test-side mirror of the hook, so the unit tests can assemble a panel from a
 * fixture without rendering, and the screen test can compare what it rendered
 * against what the assembly says. If the hook's reads change, this has to change
 * with them — the screen test's rendered-equals-assembled assertion is what
 * notices when it does not.
 */
export async function readDayPanel(
  userId: string,
  modules: Module[],
  now: Date,
): Promise<DayPanel> {
  const day = dayString(now);
  const noon = new Date(`${day}T12:00:00`);
  const { from, to } = todayPlanWindow(noon, noon);
  const sessions = await settle(listLocalSessions(userId, 30));
  const plans = await settle(listPlannedBetween(userId, from, to));
  const workouts = await settle(cachedWorkouts(userId));
  const board = buildTodayBoard({ sessions, plans, workouts, modules, now });
  const dated = <T>(p: Promise<T>) => settle(p.then((value) => ({ on: day, value })));
  return assembleDay({
    day,
    board,
    plans,
    trackers: await settle(localTrackers(userId)),
    trackerEntries: await dated(localTrackerEntries(userId, day)),
    foodEntries: await dated(localFoodEntries(userId, day)),
    target: await dated(localTargetView(userId, day)),
    checkins: await dated(localCheckinView(userId, day)),
    phases: await settle(localPhaseView(userId)),
    modules,
  });
}

function describe(ref: RowRef): string {
  switch (ref.table) {
    case 'nutrition_targets':
      return `nutrition_targets@${ref.effectiveOn}`;
    case 'body_checkins_cache':
      return `body_checkins_cache@${ref.measuredOn} fetched ${ref.fetchedAt}`;
    case 'body_phases_cache':
      return `body_phases_cache#${ref.id} fetched ${ref.fetchedAt}`;
    default:
      return `${ref.table}#${ref.id}`;
  }
}

async function rowExists(db: FixtureDb, userId: string, ref: RowRef): Promise<boolean> {
  const one = (sql: string, ...params: unknown[]) =>
    db.getFirstAsync<{ one: number }>(sql, ...params).then((r) => r !== null);
  switch (ref.table) {
    case 'local_sessions':
      return one(
        `SELECT 1 AS one FROM local_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        ref.id,
        userId,
      );
    case 'planned_sessions':
      return one(
        `SELECT 1 AS one FROM planned_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        ref.id,
        userId,
      );
    case 'daily_trackers':
      return one(
        `SELECT 1 AS one FROM daily_trackers
          WHERE id = ? AND user_id = ? AND archived_at IS NULL AND destroyed_at IS NULL`,
        ref.id,
        userId,
      );
    case 'tracker_entries':
      return one(
        `SELECT 1 AS one FROM tracker_entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        ref.id,
        userId,
      );
    case 'food_entries':
      return one(
        `SELECT 1 AS one FROM food_entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        ref.id,
        userId,
      );
    case 'nutrition_targets':
      return one(
        `SELECT 1 AS one FROM nutrition_targets WHERE user_id = ? AND effective_on = ?`,
        userId,
        ref.effectiveOn,
      );
    case 'body_checkins_cache':
      return one(
        `SELECT 1 AS one FROM body_checkins_cache
          WHERE user_id = ? AND measured_on = ? AND fetched_at = ?`,
        userId,
        ref.measuredOn,
        ref.fetchedAt,
      );
    case 'body_phases_cache':
      return one(
        `SELECT 1 AS one FROM body_phases_cache
          WHERE user_id = ? AND id = ? AND fetched_at = ? AND ended_on IS NULL`,
        userId,
        ref.id,
        ref.fetchedAt,
      );
  }
}
