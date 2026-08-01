import {
  cacheWorkouts,
  cachedWorkouts,
  countPendingWorkouts,
  createLocalWorkout,
  deleteLocalWorkout,
  saveLocalWorkoutItems,
  syncSessions,
} from '../sessionStore';
import { ApiError } from '../apiError';
import type { Workout } from '../workouts';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * The workout push, and the ordering rule that protects sessions.
 *
 * Driven through `syncSessions` rather than by exporting `pushWorkoutRow`,
 * because the interesting properties are not in the function — they are in the
 * ORDER it runs relative to the session push, and in what the sync reports
 * about rows it held back. Exporting it would have tested the easy half.
 */

let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `w-${++mockUuid}` }));

const mockCreate = jest.fn();
const mockReplace = jest.fn();
const mockDeleteW = jest.fn();
jest.mock('../workouts', () => ({
  createWorkout: (...a: unknown[]) => mockCreate(...a),
  replaceItems: (...a: unknown[]) => mockReplace(...a),
  deleteWorkout: (...a: unknown[]) => mockDeleteW(...a),
  listWorkouts: jest.fn(),
  getWorkout: jest.fn(),
}));

const mockPushSets = jest.fn();
const mockStartSession = jest.fn();
jest.mock('../sessions', () => ({
  startSession: (...a: unknown[]) => mockStartSession(...a),
  replaceSets: (...a: unknown[]) => mockPushSets(...a),
  finishSession: jest.fn(),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
  listSessions: jest.fn(async () => []),
}));

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const token = async () => 'tok';
const order: string[] = [];

const seedSession = async (over: { id?: string; workout_id?: string | null } = {}) => {
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at)
     VALUES (?, 'u1', ?, 'strength', 'Legs', '2026-08-01T10:00:00Z', NULL, '',
             '[]', 1, 1, NULL, '2026-08-01T10:00:00Z')`,
    over.id ?? 's1',
    over.workout_id ?? null,
  );
};

const serverWorkout = (over: Partial<Workout> = {}): Workout => ({
  id: 'w1', owner_user_id: 'u1', name: 'Legs', sport: 'strength',
  goal: 'hypertrophy', notes: '', visibility: 'private', items: [],
  created_at: '', updated_at: '', ...over,
});

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  order.length = 0;
  [mockCreate, mockReplace, mockDeleteW, mockPushSets, mockStartSession].forEach((m) => m.mockReset());
  mockCreate.mockImplementation(async () => void order.push('workout:create'));
  mockReplace.mockImplementation(async () => void order.push('workout:items'));
  mockDeleteW.mockImplementation(async () => void order.push('workout:delete'));
  mockPushSets.mockImplementation(async () => void order.push('session:sets'));
  mockStartSession.mockImplementation(async () => void order.push('session:create'));
});

describe('pushing a workout created offline', () => {
  it('creates it under the LOCAL id, then stops being owed', async () => {
    // The id must be the one the local row already holds: a session started
    // from this workout references it, and minting a fresh one server-side
    // would leave that session pointing at a workout that never arrives.
    const w = await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: null, visibility: 'private',
    });

    await syncSessions('u1', token);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ id: w.id, name: 'Push day' });
    expect(await countPendingWorkouts('u1')).toBe(0);
  });

  it('pushes its items too', async () => {
    await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: null, visibility: 'private',
    });
    await syncSessions('u1', token);
    expect(order).toEqual(['workout:create', 'workout:items']);
  });

  it('does not create it a SECOND time when edited after its first push', async () => {
    // The `remote` flip is what makes this idempotent. Without it the row
    // still looks never-pushed, and the next edit re-POSTs the same id —
    // which the server refuses as already_exists, i.e. a permanent rejection,
    // i.e. the edit is dropped and retries stop.
    const w = await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: null, visibility: 'private',
    });
    await syncSessions('u1', token);
    await saveLocalWorkoutItems('u1', w.id, []);
    await syncSessions('u1', token);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(2);
  });

  it('REFUSES to push a corrupt item list rather than emptying the server one', async () => {
    // replaceItems replaces. Sending [] because we could not read our own blob
    // would turn a local storage fault into permanent remote data loss.
    await cacheWorkouts('u1', [serverWorkout()]);
    await saveLocalWorkoutItems('u1', 'w1', []);
    await db.runAsync(`UPDATE workout_cache SET items_json = 'not json' WHERE id = 'w1'`);

    const result = await syncSessions('u1', token);

    expect(mockReplace).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });
});

describe('the CAS', () => {
  it('leaves the row dirty when an edit lands mid-push', async () => {
    await cacheWorkouts('u1', [serverWorkout()]);
    await saveLocalWorkoutItems('u1', 'w1', []);

    // The edit arrives while replaceItems is in flight, exactly as a save
    // during a slow push would.
    mockReplace.mockImplementation(async () => {
      await db.runAsync(
        `UPDATE workout_cache SET items_json = '[{}]', dirty = 1, updated_at = ? WHERE id = 'w1'`,
        '2099-01-01T00:00:00Z',
      );
    });

    await syncSessions('u1', token);

    // Still owed: the newer edit must not be marked as already sent.
    expect(await countPendingWorkouts('u1')).toBe(1);
  });

  it('clears dirty when nothing changed underneath', async () => {
    await cacheWorkouts('u1', [serverWorkout()]);
    await saveLocalWorkoutItems('u1', 'w1', []);
    await syncSessions('u1', token);
    expect(await countPendingWorkouts('u1')).toBe(0);
  });
});

describe('pushing a delete', () => {
  it('tells the server, then drops the row', async () => {
    await cacheWorkouts('u1', [serverWorkout()]);
    await deleteLocalWorkout('u1', 'w1');

    await syncSessions('u1', token);

    expect(mockDeleteW).toHaveBeenCalledTimes(1);
    const row = await db.getFirstAsync(`SELECT id FROM workout_cache WHERE id = 'w1'`);
    expect(row).toBeNull();
  });

  it('never asks the server about one it never knew', async () => {
    const w = await createLocalWorkout('u1', {
      name: 'Oops', sport: 'strength', goal: null, visibility: 'private',
    });
    await deleteLocalWorkout('u1', w.id);

    await syncSessions('u1', token);

    expect(mockDeleteW).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await cachedWorkouts('u1')).toEqual([]);
  });

  it('treats a 404 as success', async () => {
    await cacheWorkouts('u1', [serverWorkout()]);
    await deleteLocalWorkout('u1', 'w1');
    mockDeleteW.mockRejectedValue(new ApiError('gone', 'not_found', 404));

    await syncSessions('u1', token);

    expect(await db.getFirstAsync(`SELECT id FROM workout_cache WHERE id = 'w1'`)).toBeNull();
  });

  it('RESTORES the workout when the server refuses permanently', async () => {
    // Otherwise the plan stays hidden for the life of the install while
    // pending never reaches zero — the failure PR2 fixed for updates.
    await cacheWorkouts('u1', [serverWorkout()]);
    await deleteLocalWorkout('u1', 'w1');
    mockDeleteW.mockRejectedValue(new ApiError('nope', 'invalid_input', 400));

    await syncSessions('u1', token);

    expect((await cachedWorkouts('u1')).map((w) => w.id)).toEqual(['w1']);
    expect(await countPendingWorkouts('u1')).toBe(0);
  });
});

describe('ordering and deferral', () => {
  it('pushes the workout before any session referencing it', async () => {
    const w = await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: null, visibility: 'private',
    });
    await seedSession({ workout_id: w.id });

    await syncSessions('u1', token);

    // The FK exists server-side, so this order is correctness, not tidiness.
    expect(order.indexOf('workout:create')).toBeLessThan(order.indexOf('session:sets'));
  });

  it('DEFERS a session whose workout could not be pushed — and does not call it a failure', async () => {
    const w = await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: null, visibility: 'private',
    });
    await seedSession({ workout_id: w.id });
    mockCreate.mockRejectedValue(new Error('Network request failed'));

    const result = await syncSessions('u1', token);

    expect(order).not.toContain('session:sets');
    expect(result.deferred).toBe(1);
    // One failure — the workout. NOT two: the session is waiting, and a 4xx
    // FK error would classify as permanent and end its retries.
    expect(result.failed).toBe(1);
  });

  it('pushes a session with no workout regardless', async () => {
    await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: null, visibility: 'private',
    });
    await seedSession({ workout_id: null });
    mockCreate.mockRejectedValue(new Error('Network request failed'));

    const result = await syncSessions('u1', token);

    // A freeform session depends on nothing.
    expect(order).toContain('session:sets');
    expect(result.deferred).toBe(0);
  });
});
