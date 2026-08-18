import {
  countPendingSessions,
  deleteLocalSession,
  pushSession,
  renameLocalSession,
} from '../sessionStore';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * A rename that lands mid-push — T7.
 *
 * Sibling of T6, and strictly worse. T6 cost one cycle and self-healed; this
 * one never does.
 *
 * `pushRow` cleared `name_dirty = 0` in its OWN statement with no
 * compare-and-swap at all — no `updated_at`, no `deleted_at` — while the
 * terminal swap below it carried both guards. So:
 *
 *   1. the push snapshots the row with name "A"
 *   2. the athlete renames to "B": `dirty = 1`, `name_dirty = 1`, new
 *      `updated_at`
 *   3. `pushRename` sends "A" — correct, it is what was snapshotted — and the
 *      unguarded clear sets `name_dirty = 0`
 *   4. the terminal swap CORRECTLY declines on `updated_at`, so the row stays
 *      `dirty = 1` and is picked up again
 *   5. the next pass sends the sets and NOT the name, because `name_dirty` is
 *      already 0
 *
 * The phone keeps "B", the server keeps "A", and the pull's newer-than guard
 * stops the server copy from overwriting the local one — so nothing ever
 * reconciles. Permanent silent divergence on a row the athlete deliberately
 * edited.
 *
 * `workout_cache` never had it: it clears both flags inside the guarded swap.
 * One of two near-identical outboxes was right, for a reason recorded only in
 * the right one — the same shape T6 was found in.
 *
 * The third test is the one that matters. The first two describe the flag; only
 * a second push proves the NAME actually goes.
 */

const AT = '2026-08-01T10:00:00.000Z';

const mockSets = jest.fn();
const mockRename = jest.fn();
jest.mock('../sessions', () => ({
  // `requireActual` first: sessionStore pulls `repairSet` from here too.
  ...jest.requireActual('../sessions'),
  startSession: jest.fn().mockResolvedValue({ session: {}, volume: {} }),
  replaceSets: (...a: unknown[]) => mockSets(...a),
  finishSession: jest.fn().mockResolvedValue(undefined),
  renameSession: (...a: unknown[]) => mockRename(...a),
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
  [mockSets, mockRename].forEach((m) => m.mockReset());
  mockSets.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);

  // `remote = 1` is required: the rename PATCH is only sent for a row the
  // server already knows about. A session created offline and renamed before
  // its first push is CREATED with the new name, so there is nothing to race.
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, name_dirty, bjj_json)
     VALUES ('s1','u1',NULL,'strength','A','2026-08-01T09:00:00Z',?,'',
             '[]',1,1,NULL,?,1,NULL)`,
    AT,
    AT,
  );
});

const flags = async () =>
  (await db.getFirstAsync<{ dirty: number; name_dirty: number; name: string }>(
    `SELECT dirty, name_dirty, name FROM local_sessions WHERE id = 's1'`,
  ))!;

describe('a session renamed while its push is in flight', () => {
  it('still owes the name, so the next pass sends it', async () => {
    // The rename lands during the reflection, which is ordered BEFORE the
    // rename push — so the row on disk says "B" while this push is still
    // carrying "A".
    mockSets.mockImplementationOnce(async () => {
      await renameLocalSession('u1', 's1', 'B');
    });

    await pushSession('u1', 's1', token);

    const after = await flags();
    expect(after.name).toBe('B');
    // The whole bug in one assertion. Cleared, the row is still `dirty = 1` so
    // the loop picks it up — and then never sends the name again, because this
    // flag is what decides that.
    expect(after.name_dirty).toBe(1);
    expect(after.dirty).toBe(1);
    expect(await countPendingSessions('u1')).toBe(1);
  });

  it('actually delivers the new name on the following push', async () => {
    // The flag assertion above is a proxy. This is the property: after the
    // race, does the server end up with "B"?
    mockSets.mockImplementationOnce(async () => {
      await renameLocalSession('u1', 's1', 'B');
    });
    await pushSession('u1', 's1', token);

    // Second pass, nothing racing this time.
    await pushSession('u1', 's1', token);

    const sent = mockRename.mock.calls.map((c) => c[2]);
    expect(sent).toContain('B');
    // And the row is finally settled — otherwise "sends B forever" would also
    // satisfy the assertion above.
    const after = await flags();
    expect(after.dirty).toBe(0);
    expect(after.name_dirty).toBe(0);
  });

  it('composes with the tombstone guard when both land in the same push', async () => {
    // T6 and T7 guard the same statement with different clauses, and the
    // scenarios doc claims they compose. Claiming is not testing — this is the
    // only line of that section that had no counterpart here.
    const mockDelete = jest.requireMock('../sessions').deleteSession as jest.Mock;
    mockDelete.mockResolvedValue(undefined);

    mockSets.mockImplementationOnce(async () => {
      await renameLocalSession('u1', 's1', 'B');
      await deleteLocalSession('u1', 's1');
    });

    await pushSession('u1', 's1', token);

    // Declined on BOTH counts, so the row still owes everything.
    const after = await db.getFirstAsync<{
      dirty: number;
      name_dirty: number;
      deleted_at: string | null;
    }>(`SELECT dirty, name_dirty, deleted_at FROM local_sessions WHERE id = 's1'`);
    expect(after).toMatchObject({ dirty: 1, name_dirty: 1 });
    expect(after!.deleted_at).not.toBeNull();
    expect(await countPendingSessions('u1')).toBe(1);

    // And the next pass deletes. The rename is subsumed rather than sent — the
    // athlete's later intent was to remove the session, so a PATCH naming it
    // would be a request for a row about to stop existing.
    await pushSession('u1', 's1', token);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('goes clean when nothing was renamed underneath it', async () => {
    // The control. Without this, "never clear name_dirty" passes the tests
    // above while the row re-sends the same PATCH on every push it is ever
    // picked up for again. (Not "every foreground" — sessions are selected on
    // `dirty = 1`, so a settled row is not re-picked; it is every push after
    // any later edit, which for a live session is every debounced save. The
    // workout loop, which also reads `name_dirty`, IS the every-foreground
    // case.)
    await pushSession('u1', 's1', token);

    const after = await flags();
    expect(after.dirty).toBe(0);
    expect(after.name_dirty).toBe(0);
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(await countPendingSessions('u1')).toBe(0);
  });
});
