import { withTransaction } from '../db';
import { cacheExercises, cacheWorkouts, cachedExercises, cachedWorkouts } from '../sessionStore';

import type { Exercise } from '../exercises';
import type { Workout } from '../workouts';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * Two transactions, one connection.
 *
 * The Plan tab intermittently rendered `cannot rollback - no transaction is
 * active` where the week's training goes. `expo-sqlite` gives the whole app a
 * single connection and its `withTransactionAsync` is an unguarded
 * `BEGIN`/`COMMIT`, so `cacheWorkouts` (Plan) and `cacheExercises` (Library,
 * the session screens, the seed) destroyed each other whenever they overlapped
 * — the second `BEGIN` throws, its `ROLLBACK` ends the FIRST one's
 * transaction, and the first then fails to commit and fails to roll back.
 *
 * Deterministic here because the collision is pure async ordering, not timing:
 * starting both without awaiting between them interleaves them at the first
 * `await` inside the transaction body, every run.
 *
 * **Verified by mutation, and it takes two different ones** — worth stating
 * precisely, since a vague claim here is worth nothing:
 *
 * - Remove the queue from `withTransaction` → the first two fail. The last two
 *   still pass, correctly: they call `withTransaction` directly and target the
 *   chain, which does not exist to be broken once the queue is gone.
 * - Remove only `.catch(() => {})` from `txChain` → the last two fail.
 *
 * Note what the first mutation does NOT produce: the athlete's own
 * `cannot rollback` message. `Promise.all` rejects with whichever settles
 * first, and that is the interloper's `cannot start a transaction within a
 * transaction` — the outer block has not reached its `COMMIT` yet. Both errors
 * come from the one collision; only the reporting order differs from what the
 * screen saw.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const workout = (over: Partial<Workout> = {}): Workout => ({
  id: 'w1',
  owner_user_id: 'u1',
  name: 'Legs',
  sport: 'strength',
  goal: 'hypertrophy' as const,
  notes: '',
  visibility: 'private' as const,
  items: [],
  created_at: '',
  updated_at: '',
  ...over,
});

const exercise = (over: Partial<Exercise> = {}): Exercise => ({
  id: 'e1',
  name: 'Back Squat',
  sport: 'strength',
  movement_pattern: 'squat',
  primary_muscles: ['quads'],
  secondary_muscles: [],
  equipment: ['barbell'],
  load_type: 'weight_reps',
  is_unilateral: false,
  instructions: 'Brace.',
  media: [],
  ...over,
});

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

it('caches the plan and the catalog concurrently without either failing', async () => {
  // The headline case: Plan loading while Library (or a sync, or a session
  // screen) caches the catalog. Both used to reject — `cacheWorkouts` with
  // "cannot rollback - no transaction is active", which is what reached the
  // screen's error slot.
  await expect(
    Promise.all([
      cacheWorkouts('u1', [workout({ id: 'a' }), workout({ id: 'b' }), workout({ id: 'c' })]),
      cacheExercises([exercise({ id: 'e1' }), exercise({ id: 'e2' })]),
    ]),
  ).resolves.toBeDefined();

  expect((await cachedWorkouts('u1')).map((w) => w.id)).toEqual(['a', 'b', 'c']);
  expect((await cachedExercises()).map((e) => e.id)).toEqual(['e1', 'e2']);
});

it('still reconciles away a deleted workout when a catalog write overlaps', async () => {
  // The quiet half of the bug, and the worse one. The interloper's ROLLBACK
  // discarded `cacheWorkouts`' reconcile DELETE, so a workout deleted on the
  // server stayed in the cache — flashing back on every tab focus and, offline,
  // listed as still existing and dead-ending on tap. Exactly what the RECONCILE
  // comment in `cacheWorkouts` exists to prevent, undone at random by a race.
  await cacheWorkouts('u1', [workout({ id: 'stale' }), workout({ id: 'keep' })]);

  await Promise.all([
    cacheWorkouts('u1', [workout({ id: 'keep' })]),
    cacheExercises([exercise({ id: 'e1' })]),
  ]);

  expect((await cachedWorkouts('u1')).map((w) => w.id)).toEqual(['keep']);
});

it('rolls a failed transaction back and keeps taking work afterwards', async () => {
  // Two things at once, and the second is the one that covers this file: the
  // write is rolled back (expo's own behaviour, characterised here because the
  // queue depends on it), AND the queue still runs what comes next. Drop the
  // `.catch` on `txChain` and this fails on the last line — one bad write
  // otherwise kills every transaction for the life of the process.
  await expect(
    withTransaction(db as never, async () => {
      await db.runAsync(`INSERT INTO workout_cache
                           (id, user_id, sport, name, items_json, visibility, cached_at)
                         VALUES ('x', 'u1', 'strength', 'X', '[]', 'private', '2026-01-01')`);
      throw new Error('body failed');
    }),
  ).rejects.toThrow('body failed');

  // Rolled back, and the connection is usable again.
  expect(await cachedWorkouts('u1')).toEqual([]);
  await cacheWorkouts('u1', [workout({ id: 'after' })]);
  expect((await cachedWorkouts('u1')).map((w) => w.id)).toEqual(['after']);
});

it('does not let one failed transaction reject the ones queued behind it', async () => {
  // The `.catch` on the chain. Without it, `txChain` stays rejected and every
  // subsequent transaction — for the rest of the process — rejects with a
  // failure it had nothing to do with.
  const failed = withTransaction(db as never, async () => {
    throw new Error('first');
  });
  const queued = cacheWorkouts('u1', [workout({ id: 'after' })]);

  await expect(failed).rejects.toThrow('first');
  await expect(queued).resolves.toBeUndefined();
  expect((await cachedWorkouts('u1')).map((w) => w.id)).toEqual(['after']);
});
