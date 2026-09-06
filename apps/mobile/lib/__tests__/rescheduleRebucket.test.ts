import { listLocalSessions, readLocalSession, rescheduleLocalSession } from '../sessionStore';
import { matchPlans } from '../adherence';
import type { PlannedSession } from '../plan';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * N436's load-bearing property: correcting a BJJ session's date has to move
 * it EVERYWHERE the app reads that date, not just in the detail view.
 *
 * `local_sessions.started_at` is the only place a session's day lives — there
 * is no separate cache of "what day this session belongs to" anywhere in this
 * app (`grep -rl local_sessions apps/mobile/lib` finds only `db.ts`,
 * `foodLog.ts` and `sessionStore.ts` itself). Every consumer this file checks
 * — `listLocalSessions`, the raw `date(started_at, 'localtime')` grouping
 * `trainingSince` runs in SQL, and `matchPlans` — re-derives the day fresh
 * from this row on every call. So the correctness risk isn't "does the UPDATE
 * run" (trivial), it's "is that ONE UPDATE actually sufficient for every
 * reader", which only a test that exercises more than one reader against the
 * SAME migrated row can show. Real SQLite via `migratedFixture()`, not a
 * mock — this is exactly the SQL-bucketing behaviour `support/sqlite.ts`'s
 * own docblock says a mock can silently supply instead of testing.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const userID = 'u1';

/** An ISO instant for a given local wall-clock moment, so the test reads in
 *  calendar terms rather than in UTC-offset arithmetic. */
function local(y: number, m: number, d: number, h: number, mi: number): string {
  return new Date(y, m - 1, d, h, mi, 0).toISOString();
}

async function insertBjjSession(opts: {
  id: string;
  startedAt: string;
  endedAt: string | null;
  remote?: boolean;
}) {
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, name_dirty, bjj_json,
        started_at_dirty)
     VALUES (?, ?, NULL, 'bjj', ?, ?, ?, '', '[]', 0, ?, NULL, ?, 0, '{"tags":[]}', 0)`,
    opts.id,
    userID,
    opts.id,
    opts.startedAt,
    opts.endedAt,
    opts.remote === false ? 0 : 1,
    opts.startedAt,
  );
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

describe('rescheduleLocalSession moves a session everywhere its date is read', () => {
  test('a session logged under the wrong day matches its plan once corrected, and stops matching the old day', async () => {
    // Logged as Tuesday 26 Aug, meant Monday 25 Aug — the exact mistake the
    // ticket names. A one-hour class, so the duration check below has
    // something to preserve.
    await insertBjjSession({
      id: 'ses-wrong-day',
      startedAt: local(2026, 8, 26, 19, 0),
      endedAt: local(2026, 8, 26, 20, 0),
    });
    // Untouched control on a THIRD day — proves the reschedule doesn't leak
    // onto a session it was never asked to move.
    await insertBjjSession({
      id: 'ses-untouched',
      startedAt: local(2026, 8, 27, 18, 0),
      endedAt: local(2026, 8, 27, 19, 0),
    });

    const mondayPlan: PlannedSession = {
      id: 'plan-monday-bjj',
      day: '2026-08-25',
      sport: 'bjj',
      workoutId: null,
      classPlanId: null,
      timeOfDayMinutes: null,
      notes: '',
    };

    // BEFORE the correction: the session is on Tuesday, the plan is for
    // Monday. They must not match — this is the broken state the athlete is
    // trying to fix, and if the fixture already matched them the rest of
    // this test would prove nothing.
    const before = await listLocalSessions(userID);
    expect(matchPlans(before, [mondayPlan]).met.size).toBe(0);

    const moved = await rescheduleLocalSession(userID, 'ses-wrong-day', new Date(2026, 7, 25));
    expect(moved).toBe(true);

    // 1. The row itself, read back the ordinary way the session screen does.
    const reread = await readLocalSession(userID, 'ses-wrong-day');
    expect(reread).not.toBeNull();
    expect(reread!.started_at).toBe(local(2026, 8, 25, 19, 0));
    // ended_at shifted by the IDENTICAL amount, so the recorded duration —
    // what mat-time and rolling-time derive from — survives the move exactly.
    expect(reread!.ended_at).toBe(local(2026, 8, 25, 20, 0));
    const durationMs = new Date(reread!.ended_at!).getTime() - new Date(reread!.started_at).getTime();
    expect(durationMs).toBe(60 * 60 * 1000);

    // 2. `listLocalSessions` — what Today, the training calendar and history
    // all actually call — reflects the move with no separate step.
    const after = await listLocalSessions(userID);
    const afterRow = after.find((s) => s.id === 'ses-wrong-day')!;
    expect(afterRow.started_at).toBe(local(2026, 8, 25, 19, 0));
    // The control session is exactly where it started.
    const untouched = after.find((s) => s.id === 'ses-untouched')!;
    expect(untouched.started_at).toBe(local(2026, 8, 27, 18, 0));

    // 3. A REAL, independent downstream consumer — plan/session matching —
    // now sees the session on the day it actually belongs to. This is the
    // property the detail screen alone cannot prove: something that reads
    // `started_at` through a completely different code path agrees with the
    // move.
    const matchAfter = matchPlans(after, [mondayPlan]);
    expect(matchAfter.met.has('plan-monday-bjj')).toBe(true);
    expect(matchAfter.metBy.get('ses-wrong-day')).toBe('plan-monday-bjj');
  });

  test('the SQL day-bucket itself moves — not just the column value', async () => {
    // Same session, tested at the level `trainingSince` groups on
    // (`date(started_at, 'localtime')`) rather than through a JS re-parse —
    // so this fails if the column changed but somehow lands on a different
    // SQLite date than the app-level assertion above implies.
    await insertBjjSession({
      id: 'ses-bucket',
      startedAt: local(2026, 8, 26, 22, 30),
      endedAt: null,
    });

    const dayOf = async (id: string) =>
      (
        await db.getFirstAsync<{ d: string }>(
          `SELECT date(started_at, 'localtime') AS d FROM local_sessions WHERE id = ?`,
          id,
        )
      )?.d;

    expect(await dayOf('ses-bucket')).toBe('2026-08-26');

    await rescheduleLocalSession(userID, 'ses-bucket', new Date(2026, 7, 25));

    expect(await dayOf('ses-bucket')).toBe('2026-08-25');
  });

  test('a still-open session (no ended_at) moves started_at only — ended_at stays null', async () => {
    await insertBjjSession({ id: 'ses-open', startedAt: local(2026, 8, 26, 19, 0), endedAt: null });

    await rescheduleLocalSession(userID, 'ses-open', new Date(2026, 7, 25));

    const reread = await readLocalSession(userID, 'ses-open');
    expect(reread!.started_at).toBe(local(2026, 8, 25, 19, 0));
    expect(reread!.ended_at).toBeNull();
  });

  test('marks the row owed to the server, for a row the server already has', async () => {
    await insertBjjSession({
      id: 'ses-owed',
      startedAt: local(2026, 8, 26, 19, 0),
      endedAt: null,
      remote: true,
    });

    await rescheduleLocalSession(userID, 'ses-owed', new Date(2026, 7, 25));

    const flags = await db.getFirstAsync<{ dirty: number; started_at_dirty: number }>(
      `SELECT dirty, started_at_dirty FROM local_sessions WHERE id = ?`,
      'ses-owed',
    );
    expect(flags).toMatchObject({ dirty: 1, started_at_dirty: 1 });
  });

  test('a session that does not exist on this device is reported, not silently accepted', async () => {
    expect(await rescheduleLocalSession(userID, 'no-such-session', new Date(2026, 7, 25))).toBe(false);
  });

  test('never resurrects a tombstoned row', async () => {
    await insertBjjSession({ id: 'ses-deleted', startedAt: local(2026, 8, 26, 19, 0), endedAt: null });
    await db.runAsync(
      `UPDATE local_sessions SET deleted_at = ? WHERE id = ?`,
      new Date().toISOString(),
      'ses-deleted',
    );

    expect(await rescheduleLocalSession(userID, 'ses-deleted', new Date(2026, 7, 25))).toBe(false);
    // Untouched — still tombstoned, still on its original day.
    const row = await db.getFirstAsync<{ started_at: string; deleted_at: string | null }>(
      `SELECT started_at, deleted_at FROM local_sessions WHERE id = ?`,
      'ses-deleted',
    );
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.started_at).toBe(local(2026, 8, 26, 19, 0));
  });
});
