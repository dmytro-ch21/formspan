import { ApiError } from '../apiError';
import {
  countPendingSessions,
  countPendingWorkouts,
  createLocalWorkout,
  deleteLocalSession,
  deleteLocalWorkout,
  pushSession,
  syncSessions,
} from '../sessionStore';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * A delete that lands mid-push — T6.
 *
 * Every outbox here ends by clearing `dirty` under a compare-and-swap on
 * `updated_at`, and the doc comment on `deleteLocalSession` used to call that
 * sufficient: "the interleaving is safe because the tombstone bumps
 * `updated_at`". It is not, and the gap is the clock. The delete stamps
 * `updated_at` from the same wall clock the swap compares against, so a delete
 * landing in the SAME MILLISECOND as the push's snapshot writes an identical
 * string. The swap matches, the tombstone is marked clean — and the push loop
 * selects on `dirty = 1`, so it is then never sent at all.
 *
 * What that costs: the session or workout is gone from this phone, alive on the
 * server, `pending` reads zero, and nothing ever retries. Silent, and only on
 * the rows somebody deliberately deleted.
 *
 * `plan.ts` carries the second clause — `AND deleted_at IS NULL` — and T5 pinned
 * it there. It did not start with it either: it was added by a `/pre-merge`
 * review finding on that PR, and the two older outboxes were never swept. So one
 * of the three was guarded, for a reason recorded only in the guarded one.
 * Found by review again here, while checking T5's WORDING rather than its code,
 * reproduced with a control, then fixed.
 *
 * Both cases below force the collision rather than waiting for one: two
 * `Date.now()` calls cannot be made to collide on demand, so the tombstone is
 * written by the real delete function and only the clock is then closed by
 * hand. The state that produces is `deleted_at = now, updated_at = snapshot`,
 * where a true collision gives both as the snapshot — and the clause reads
 * `deleted_at IS NULL`, never its value, so the difference is invisible to the
 * guard under test.
 */

const AT = '2026-08-01T10:00:00.000Z';

const mockSets = jest.fn();
const mockStart = jest.fn();
jest.mock('../sessions', () => ({
  // `requireActual` FIRST: `sessionStore` imports `repairSet` from here too,
  // and these fixtures are set-bearing.
  ...jest.requireActual('../sessions'),
  startSession: (...a: unknown[]) => mockStart(...a),
  replaceSets: (...a: unknown[]) => mockSets(...a),
  finishSession: jest.fn().mockResolvedValue(undefined),
  renameSession: jest.fn(),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
  listSessions: jest.fn(async () => []),
}));

jest.mock('../bjjSession', () => ({ putDetail: jest.fn() }));

const mockCreateW = jest.fn();
const mockReplaceW = jest.fn();
const mockDeleteW = jest.fn();
jest.mock('../workouts', () => ({
  createWorkout: (...a: unknown[]) => mockCreateW(...a),
  replaceItems: (...a: unknown[]) => mockReplaceW(...a),
  renameWorkout: jest.fn(),
  deleteWorkout: (...a: unknown[]) => mockDeleteW(...a),
  listWorkouts: jest.fn(async () => []),
  getWorkout: jest.fn(),
}));

let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `w-${++mockUuid}` }));

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
  [mockSets, mockStart, mockCreateW, mockReplaceW, mockDeleteW].forEach((m) => m.mockReset());
  mockSets.mockResolvedValue(undefined);
  mockStart.mockResolvedValue({ session: {}, volume: {} });
  mockCreateW.mockResolvedValue(undefined);
  mockReplaceW.mockResolvedValue(undefined);
  mockDeleteW.mockResolvedValue(undefined);
});

/** Close the millisecond the wall clock would not have closed for us. */
async function collideClock(table: 'local_sessions' | 'workout_cache', id: string) {
  await db.runAsync(`UPDATE ${table} SET updated_at = ? WHERE id = ?`, AT, id);
}

describe('a session deleted while its push is in flight', () => {
  beforeEach(async () => {
    await db.runAsync(
      `INSERT INTO local_sessions
         (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
          sets_json, dirty, remote, deleted_at, updated_at, name_dirty, bjj_json)
       VALUES ('s1','u1',NULL,'strength','Bench','2026-08-01T09:00:00Z',?,'',
               '[]',1,1,NULL,?,0,NULL)`,
      AT,
      AT,
    );
  });

  const row = async () =>
    (await db.getFirstAsync<{ dirty: number; deleted_at: string | null }>(
      `SELECT dirty, deleted_at FROM local_sessions WHERE id = 's1'`,
    ))!;

  it('stays owed, so the delete still reaches the server', async () => {
    mockSets.mockImplementationOnce(async () => {
      await deleteLocalSession('u1', 's1');
      await collideClock('local_sessions', 's1');
    });

    await pushSession('u1', 's1', token);

    const after = await row();
    expect(after.deleted_at).not.toBeNull();
    // The whole bug in one assertion. Cleared, the push loop's `dirty = 1`
    // SELECT never sees this row again — gone here, alive on the server.
    expect(after.dirty).toBe(1);
    expect(await countPendingSessions('u1')).toBe(1);
  });

  it('still goes clean when nothing was deleted underneath it', async () => {
    // Or "never clear dirty" would satisfy the case above.
    await pushSession('u1', 's1', token);

    const after = await row();
    expect(after.deleted_at).toBeNull();
    expect(after.dirty).toBe(0);
    expect(await countPendingSessions('u1')).toBe(0);
  });

  it('still declines for an ordinary edit, which is the other half of the swap', async () => {
    // The `updated_at` clause was already here and must stay: this fails if
    // the tombstone clause were added by REPLACING it rather than alongside.
    mockSets.mockImplementationOnce(async () => {
      await db.runAsync(
        `UPDATE local_sessions SET sets_json = '[]', dirty = 1, updated_at = ? WHERE id = 's1'`,
        '2026-08-01T10:00:01.000Z',
      );
    });

    await pushSession('u1', 's1', token);

    expect((await row()).dirty).toBe(1);
  });
});

describe('a workout deleted while its push is in flight', () => {
  const row = async (id: string) =>
    (await db.getFirstAsync<{ dirty: number; deleted_at: string | null }>(
      `SELECT dirty, deleted_at FROM workout_cache WHERE id = ?`,
      id,
    ))!;

  /** Created, pushed clean, then dirtied at a known instant. */
  async function pushableWorkout() {
    const w = await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: null, visibility: 'private',
    });
    await syncSessions('u1', token);
    await db.runAsync(
      `UPDATE workout_cache SET dirty = 1, updated_at = ? WHERE id = ?`,
      AT,
      w.id,
    );
    return w.id;
  }

  it('stays owed, so the delete still reaches the server', async () => {
    const id = await pushableWorkout();
    mockReplaceW.mockImplementationOnce(async () => {
      await deleteLocalWorkout('u1', id);
      await collideClock('workout_cache', id);
    });

    await syncSessions('u1', token);

    const after = await row(id);
    expect(after.deleted_at).not.toBeNull();
    expect(after.dirty).toBe(1);
    expect(await countPendingWorkouts('u1')).toBe(1);
  });

  it('and the delete goes out on the very next sync', async () => {
    // The consequence worth stating: staying dirty is only useful because the
    // next pass then carries the tombstone out for real.
    const id = await pushableWorkout();
    mockReplaceW.mockImplementationOnce(async () => {
      await deleteLocalWorkout('u1', id);
      await collideClock('workout_cache', id);
    });
    await syncSessions('u1', token);

    await syncSessions('u1', token);

    expect(mockDeleteW).toHaveBeenCalledTimes(1);
    expect(await countPendingWorkouts('u1')).toBe(0);
  });

  it('still goes clean when nothing was deleted underneath it', async () => {
    const id = await pushableWorkout();

    await syncSessions('u1', token);

    expect(await row(id)).toMatchObject({ dirty: 0, deleted_at: null });
  });
});

describe('the guards are independent', () => {
  it('a permanently refused push leaves the row owed rather than going clean', async () => {
    // Guards against a fix that made the swap decline for the wrong reason.
    await db.runAsync(
      `INSERT INTO local_sessions
         (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
          sets_json, dirty, remote, deleted_at, updated_at, name_dirty, bjj_json)
       VALUES ('s2','u1',NULL,'strength','Bench','2026-08-01T09:00:00Z',?,'',
               '[]',1,1,NULL,?,0,NULL)`,
      AT,
      AT,
    );
    mockSets.mockRejectedValueOnce(new ApiError('nope', 'invalid_input', 400));

    await expect(pushSession('u1', 's2', token)).rejects.toThrow();

    const after = await db.getFirstAsync<{ dirty: number }>(
      `SELECT dirty FROM local_sessions WHERE id = 's2'`,
    );
    expect(after?.dirty).toBe(1);
  });
});
