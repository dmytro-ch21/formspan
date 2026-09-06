import { listPlannedBetween, planSession, plannedFor, unplanSession } from '../plan';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * The week plan, against a real database.
 *
 * Two halves, and both have already bitten this codebase in other modules:
 *
 *  1. **The migration actually creates the table.** `migratedFixture()` runs
 *     the app's own `migrate()` from version 0, so a `planned_sessions` that
 *     is declared but never created fails here. That is not hypothetical — it
 *     is exactly what happened on the Simulator while this was being built
 *     (the version got stamped by a hot reload before the CREATE existed), and
 *     the symptom was `no such table` at the moment a user taps Add.
 *
 *  2. **Scoping and range are enforced by SQL, not by hope.** A plan leaking
 *     across users is the shared-device bug `db.ts` warns about in its header;
 *     a range query that is off by a day silently drops Sunday.
 *
 * Every assertion here fails if the guard it covers is deleted — the bar this
 * suite was created to hold.
 */

let db: FixtureDb;
// `mock`-prefixed so the jest.mock factory may close over it.
let mockFixture: FixtureDb;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

/**
 * Unique ids, because jest-expo's stub does not give any.
 *
 * `jest-expo` mocks `expo-crypto.randomUUID()` to the **constant string**
 * `"generated-uuid"`, so two plans in one test collide on the primary key and
 * the second insert fails. That is a fixture artifact, not app behaviour — a
 * device returns a real UUID every time — and mocking it here is what lets the
 * two-a-day and multi-row cases below test what they claim to.
 */
// `mock`-prefixed for the same reason `mockFixture` above is: jest hoists the
// factory above every declaration, and only that prefix is allowed through.
let mockUuidSeq = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `uuid-${++mockUuidSeq}`,
}));

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

describe('planned_sessions', () => {
  test('the migration creates the table', async () => {
    const row = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'planned_sessions'`,
    );
    expect(row?.name).toBe('planned_sessions');
  });

  test('a plan round-trips, workout and all', async () => {
    const made = await planSession('user-1', '2026-08-05', 'strength', 'workout-9');
    const read = await plannedFor('user-1', '2026-08-05');

    expect(read).toHaveLength(1);
    expect(read[0]).toEqual({
      id: made.id,
      day: '2026-08-05',
      sport: 'strength',
      workoutId: 'workout-9',
      classPlanId: null,
      timeOfDayMinutes: null,
      notes: '',
    });
  });

  // N442: this device never SCHEDULES a class (see PlannedSession.classPlanId's
  // own comment), but it has to READ one back correctly once the sync pull has
  // written it — inserted directly here rather than through `planSession`,
  // which has no parameter for it, to prove the column and the read path
  // rather than a function that deliberately cannot produce this state.
  test('a class-plan-linked row round-trips class_plan_id', async () => {
    await db.runAsync(
      `INSERT INTO planned_sessions
         (id, user_id, day, sport, workout_id, class_plan_id, notes, created_at, updated_at, dirty, remote)
       VALUES ('plan-cp-1', 'user-1', '2026-08-05', 'bjj', NULL, 'classplan-1', '', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 0, 1)`,
    );

    const [plan] = await plannedFor('user-1', '2026-08-05');
    expect(plan.classPlanId).toBe('classplan-1');
    expect(plan.workoutId).toBeNull();
  });

  test('a day can be planned as a bare discipline', async () => {
    // "Tuesday is BJJ" is a complete plan — the mat sessions this app is built
    // around have no template at all, so a null workout must survive the round
    // trip rather than being coerced to a string.
    await planSession('user-1', '2026-08-05', 'bjj', null);
    const [plan] = await plannedFor('user-1', '2026-08-05');
    expect(plan.workoutId).toBeNull();
  });

  test('a day holds more than one session', async () => {
    // Two-a-days are normal here: lift in the morning, mat in the evening.
    await planSession('user-1', '2026-08-05', 'strength', 'w1');
    await planSession('user-1', '2026-08-05', 'bjj', null);
    expect(await plannedFor('user-1', '2026-08-05')).toHaveLength(2);
  });

  test('one account never sees another account’s plan', async () => {
    await planSession('user-1', '2026-08-05', 'strength', null);
    await planSession('user-2', '2026-08-05', 'bjj', null);

    const mine = await plannedFor('user-1', '2026-08-05');
    expect(mine).toHaveLength(1);
    expect(mine[0].sport).toBe('strength');
  });

  test('the range is inclusive at both ends', async () => {
    await planSession('user-1', '2026-08-03', 'strength', null); // Monday
    await planSession('user-1', '2026-08-09', 'bjj', null); // Sunday
    await planSession('user-1', '2026-08-10', 'strength', null); // next Monday

    const week = await listPlannedBetween('user-1', '2026-08-03', '2026-08-09');
    expect(week.map((p) => p.day)).toEqual(['2026-08-03', '2026-08-09']);
  });

  test('unplan removes only that entry', async () => {
    const a = await planSession('user-1', '2026-08-05', 'strength', null);
    await planSession('user-1', '2026-08-05', 'bjj', null);

    await unplanSession('user-1', a.id);

    const left = await plannedFor('user-1', '2026-08-05');
    expect(left).toHaveLength(1);
    expect(left[0].sport).toBe('bjj');
  });

  // N126/#520: a planned session can carry a time.
  //
  // This whole suite runs under TZ=America/Los_Angeles (see
  // apps/mobile/package.json's `test` script) — a wall-clock bug that only
  // shows up west of Greenwich is invisible under UTC, so every assertion
  // below is already exercising the non-UTC case the ticket's acceptance
  // criteria asks for, with no special per-test setup.
  test('a time round-trips as minutes since local midnight', async () => {
    const made = await planSession('user-1', '2026-08-05', 'strength', null, '', 1140); // 7:00 PM
    const [plan] = await plannedFor('user-1', '2026-08-05');
    expect(plan.timeOfDayMinutes).toBe(1140);
    expect(made.timeOfDayMinutes).toBe(1140);
  });

  test('no time given is a real, permanent absence — not midnight', async () => {
    await planSession('user-1', '2026-08-05', 'bjj', null);
    const [plan] = await plannedFor('user-1', '2026-08-05');
    expect(plan.timeOfDayMinutes).toBeNull();
  });

  // The ordering half of the acceptance criteria: two sessions on the same
  // day sort by time_of_day_minutes, untimed last. Deleting the ORDER BY
  // clause (or its "IS NULL" tiebreak) from listPlannedBetween's query makes
  // this fail — asserting the order itself, not just membership, is the
  // point (see the vola-testing skill's "assert the order" rule).
  test('two sessions on the same day sort by time, untimed last', async () => {
    // Inserted deliberately OUT of the order they should read back in, so
    // passing this test cannot be an accident of insertion order (which
    // `created_at ASC` would otherwise supply for free).
    await planSession('user-1', '2026-08-05', 'strength', null, '', 18 * 60); // 6:00 PM
    await planSession('user-1', '2026-08-05', 'bjj', null); // untimed
    await planSession('user-1', '2026-08-05', 'running', null, '', 7 * 60); // 7:00 AM

    const day = await plannedFor('user-1', '2026-08-05');
    expect(day.map((p) => p.sport)).toEqual(['running', 'strength', 'bjj']);
  });

  test('unplan cannot delete another account’s row', async () => {
    // Ids are client-generated and therefore guessable, which is the same
    // reason the backend's session routes check ownership rather than trusting
    // the id.
    const theirs = await planSession('user-2', '2026-08-05', 'bjj', null);

    await unplanSession('user-1', theirs.id);

    expect(await plannedFor('user-2', '2026-08-05')).toHaveLength(1);
  });
});
