import {
  cacheWorkouts,
  cachedWorkouts,
  countPendingWorkouts,
  createLocalWorkout,
  deleteLocalWorkout,
  saveLocalWorkoutItems,
  unsyncedWorkoutIDs,
} from '../sessionStore';
import type { Workout } from '../workouts';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * Workouts written offline.
 *
 * Against a real database, because every interesting property here is about
 * what the columns hold and which rows a statement touches.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;

// expo-crypto's native module is stubbed by jest-expo, so randomUUID returns
// undefined and the INSERT fails on a NOT NULL id. Real on a device; mocked
// here so the ids are also deterministic.
let mockUuid = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `uuid-${++mockUuid}`,
}));

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const serverWorkout = (over: Partial<Workout> = {}): Workout => ({
  id: 'w1',
  owner_user_id: 'u1',
  name: 'Legs',
  sport: 'strength',
  goal: 'hypertrophy',
  notes: '',
  visibility: 'private',
  items: [],
  created_at: '',
  updated_at: '',
  ...over,
});

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

describe('creating offline', () => {
  it('is readable immediately and owed to the server', async () => {
    const w = await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: 'hypertrophy', visibility: 'private',
    });

    expect((await cachedWorkouts('u1')).map((x) => x.name)).toEqual(['Push day']);
    expect(await countPendingWorkouts('u1')).toBe(1);
    // The server has never heard of it — what the session push consults.
    expect(await unsyncedWorkoutIDs('u1')).toEqual(new Set([w.id]));
  });

  it('survives a server refresh that does not include it', async () => {
    // The reconcile deletes rows absent from the server list. A workout the
    // server has never SEEN is absent for a different reason, and dropping it
    // would destroy the athlete's new plan.
    const w = await createLocalWorkout('u1', {
      name: 'Push day', sport: 'strength', goal: null, visibility: 'private',
    });
    await cacheWorkouts('u1', [serverWorkout({ id: 'other' })]);

    expect((await cachedWorkouts('u1')).map((x) => x.id).sort()).toEqual(['other', w.id].sort());
  });
});

describe('editing offline', () => {
  it('marks the row owed without touching the server copy of others', async () => {
    await cacheWorkouts('u1', [serverWorkout({ id: 'a' }), serverWorkout({ id: 'b' })]);
    expect(await countPendingWorkouts('u1')).toBe(0);

    await saveLocalWorkoutItems('u1', 'a', [
      { exercise_id: 'squat', position: 0, target_sets: 3, target_reps: 5 } as never,
    ]);

    expect(await countPendingWorkouts('u1')).toBe(1);
    expect((await cachedWorkouts('u1')).find((w) => w.id === 'a')!.items).toHaveLength(1);
    expect((await cachedWorkouts('u1')).find((w) => w.id === 'b')!.items).toHaveLength(0);
  });

  it('is not clobbered by a server refresh — the CAS decision', async () => {
    // Rows arriving from the server are older than anything unpushed here.
    await cacheWorkouts('u1', [serverWorkout({ id: 'a', name: 'Legs' })]);
    await saveLocalWorkoutItems('u1', 'a', [
      { exercise_id: 'squat', position: 0, target_sets: 5, target_reps: 3 } as never,
    ]);

    await cacheWorkouts('u1', [serverWorkout({ id: 'a', name: 'Legs', items: [] })]);

    const [w] = await cachedWorkouts('u1');
    expect(w.items).toHaveLength(1);
    expect(await countPendingWorkouts('u1')).toBe(1);
  });
});

describe('deleting offline', () => {
  it('hides it, keeps the row, and owes the server', async () => {
    await cacheWorkouts('u1', [serverWorkout()]);
    await deleteLocalWorkout('u1', 'w1');

    expect(await cachedWorkouts('u1')).toEqual([]);
    expect(await countPendingWorkouts('u1')).toBe(1);
    const row = await db.getFirstAsync<{ deleted_at: string }>(
      `SELECT deleted_at FROM workout_cache WHERE id = 'w1'`,
    );
    expect(row?.deleted_at).toEqual(expect.any(String));
  });

  it('is not resurrected by a server refresh that still lists it', async () => {
    await cacheWorkouts('u1', [serverWorkout()]);
    await deleteLocalWorkout('u1', 'w1');
    await cacheWorkouts('u1', [serverWorkout()]);

    expect(await cachedWorkouts('u1')).toEqual([]);
  });

  it('does not re-stamp an already-deleted workout', async () => {
    await cacheWorkouts('u1', [serverWorkout()]);
    await deleteLocalWorkout('u1', 'w1');
    const OLD = '2026-07-01T00:00:00.000Z';
    await db.runAsync(
      `UPDATE workout_cache SET deleted_at = ?, updated_at = ? WHERE id = 'w1'`, OLD, OLD,
    );
    await deleteLocalWorkout('u1', 'w1');

    const row = await db.getFirstAsync<{ deleted_at: string; updated_at: string }>(
      `SELECT deleted_at, updated_at FROM workout_cache WHERE id = 'w1'`,
    );
    expect(row).toEqual({ deleted_at: OLD, updated_at: OLD });
  });
});

it('an upgraded row is not owed to the server', async () => {
  // v9 defaults dirty = 0 / remote = 1. Everything cached before the upgrade
  // arrived FROM the server, so defaulting the other way would push every
  // cached workout straight back at it on first launch.
  await cacheWorkouts('u1', [serverWorkout()]);
  expect(await countPendingWorkouts('u1')).toBe(0);
  expect(await unsyncedWorkoutIDs('u1')).toEqual(new Set());
});
