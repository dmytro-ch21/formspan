import { countPendingSessions, pushSession, rescheduleLocalSession } from '../sessionStore';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * A reschedule that lands mid-push — the T7 shape, reproduced for
 * `started_at_dirty` rather than `name_dirty`.
 *
 * `pushRow` clears BOTH the reschedule and rename flags inside the SAME
 * compare-and-swapped terminal statement `renameRace.test.ts` pins for the
 * name (`AND updated_at = ?`), so an edit landing after the row was snapshot
 * for push but before that terminal UPDATE runs must leave the row `dirty =
 * 1` with its flag still set — otherwise the corrected date is sent once,
 * the flag clears, and the phone and server diverge with nothing left
 * retrying. This is not a hypothetical shared with the name's: adding a
 * SECOND flag to the same guarded statement is exactly the kind of edit that
 * has silently dropped one half of a compound guard elsewhere in this file
 * before (see the `name_dirty` clause's own history in `upsert`'s comment).
 */

const AT = '2026-08-01T10:00:00.000Z';

const mockSets = jest.fn();
const mockReschedule = jest.fn();
jest.mock('../sessions', () => ({
  ...jest.requireActual('../sessions'),
  startSession: jest.fn().mockResolvedValue({ session: {}, volume: {} }),
  replaceSets: (...a: unknown[]) => mockSets(...a),
  finishSession: jest.fn().mockResolvedValue(undefined),
  renameSession: jest.fn().mockResolvedValue(undefined),
  rescheduleSession: (...a: unknown[]) => mockReschedule(...a),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
  listSessions: jest.fn(async () => []),
}));

jest.mock('../bjjSession', () => ({ putDetail: jest.fn() }));
jest.mock('../workouts', () => ({
  createWorkout: jest.fn(),
  replaceItems: jest.fn(),
  renameWorkout: jest.fn(),
  deleteWorkout: jest.fn(),
  listWorkouts: jest.fn(async () => []),
  getWorkout: jest.fn(),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'w-1' }));

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const token = async () => 'tok';

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  [mockSets, mockReschedule].forEach((m) => m.mockReset());
  mockSets.mockResolvedValue(undefined);
  mockReschedule.mockResolvedValue(undefined);

  // `remote = 1`: the reschedule PATCH is only sent for a row the server
  // already knows about — a session moved before its first push is CREATED
  // with the corrected date, so there is nothing to race.
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, name_dirty,
        started_at_dirty, bjj_json)
     VALUES ('s1','u1',NULL,'bjj','Class','2026-08-01T09:00:00Z',?,'',
             '[]',1,1,NULL,?,0,1,NULL)`,
    AT,
    AT,
  );
});

const flags = async () =>
  (await db.getFirstAsync<{ dirty: number; started_at_dirty: number; started_at: string }>(
    `SELECT dirty, started_at_dirty, started_at FROM local_sessions WHERE id = 's1'`,
  ))!;

describe('a session rescheduled while its push is in flight', () => {
  it('still owes the date, so the next pass sends it', async () => {
    // The correction lands during the sets push, which runs BEFORE the
    // reschedule call — so the row on disk already says "26 Aug" while this
    // push is still carrying the ORIGINAL "1 Aug" it snapshotted.
    mockSets.mockImplementationOnce(async () => {
      await rescheduleLocalSession('u1', 's1', new Date(2026, 7, 26));
    });

    await pushSession('u1', 's1', token);

    const after = await flags();
    expect(after.started_at.startsWith('2026-08-26')).toBe(true);
    // The whole bug in one assertion, mirroring renameRace.test.ts exactly:
    // cleared, the row is still `dirty = 1` so the loop picks it up — and
    // then never sends the date again, because this flag is what decides
    // that.
    expect(after.started_at_dirty).toBe(1);
    expect(after.dirty).toBe(1);
    expect(await countPendingSessions('u1')).toBe(1);
  });

  it('actually delivers the corrected date on the following push', async () => {
    mockSets.mockImplementationOnce(async () => {
      await rescheduleLocalSession('u1', 's1', new Date(2026, 7, 26));
    });
    await pushSession('u1', 's1', token);

    // Second pass, nothing racing this time.
    await pushSession('u1', 's1', token);

    // The FIRST pass already sent the snapshotted (pre-race) date — that is
    // correct, not a bug, exactly as `renameRace.test.ts` sends the
    // snapshotted "A" on its own first pass. The property under test is that
    // the CORRECTED date eventually goes out and the row ends up settled —
    // not that it is sent exactly once.
    const sent = mockReschedule.mock.calls.map((c) => String(c[2]));
    expect(sent.some((v) => v.startsWith('2026-08-26'))).toBe(true);

    // And the row is finally settled — otherwise "keeps sending the old
    // snapshot forever" would also satisfy the assertion above.
    const after = await flags();
    expect(after.dirty).toBe(0);
    expect(after.started_at_dirty).toBe(0);
  });

  it('goes clean when nothing was rescheduled underneath it', async () => {
    await pushSession('u1', 's1', token);

    const after = await flags();
    expect(after.dirty).toBe(0);
    expect(after.started_at_dirty).toBe(0);
    expect(mockReschedule).toHaveBeenCalledTimes(1);
    expect(await countPendingSessions('u1')).toBe(0);
  });

  it('never PATCHes the schedule for a session not yet known to the server', async () => {
    await db.runAsync(`UPDATE local_sessions SET remote = 0 WHERE id = 's1'`);

    await pushSession('u1', 's1', token);

    // The create call carries the row's current started_at already — see
    // `toSession(row)` in `pushRow` — so a separate PATCH would be a
    // redundant second request for a session the phone has never even told
    // the server about yet.
    expect(mockReschedule).not.toHaveBeenCalled();
    const after = await flags();
    expect(after.started_at_dirty).toBe(0);
  });
});
