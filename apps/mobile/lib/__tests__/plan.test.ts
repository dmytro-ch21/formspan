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
      notes: '',
    });
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

  test('unplan cannot delete another account’s row', async () => {
    // Ids are client-generated and therefore guessable, which is the same
    // reason the backend's session routes check ownership rather than trusting
    // the id.
    const theirs = await planSession('user-2', '2026-08-05', 'bjj', null);

    await unplanSession('user-1', theirs.id);

    expect(await plannedFor('user-2', '2026-08-05')).toHaveLength(1);
  });
});
