import { cacheWorkouts, cachedWorkouts } from '../sessionStore';
import type { Workout } from '../workouts';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * The workout cache, and the ownership it used to invent.
 *
 * `cachedWorkouts` returned `owner_user_id: userID` and a hardcoded
 * `visibility: 'private'`. `app/workout/[id].tsx` derives `canEdit` from
 * exactly that field — so offline, **every** cached workout looked editable,
 * including VOLA's ownerless templates and other athletes' public ones. The
 * Save button appeared for things the server refuses, and the "VOLA template"
 * label vanished because nothing was ever null.
 *
 * Run against a real database, because the bug was in what the columns hold.
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

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

it("keeps a VOLA template's null owner, so it never looks editable", async () => {
  // The headline case. `canEdit` is `owner_user_id !== null && === userId`,
  // so inventing an owner here hands the athlete a Save button the server
  // will refuse — and hides the "VOLA template" label that explains why.
  await cacheWorkouts('u1', [workout({ id: 'vola1', owner_user_id: null })]);

  const [cached] = await cachedWorkouts('u1');
  expect(cached.owner_user_id).toBeNull();
});

it("keeps another athlete's ownership rather than claiming it", async () => {
  await cacheWorkouts('u1', [workout({ id: 'w2', owner_user_id: 'u2', visibility: 'public' })]);

  const [cached] = await cachedWorkouts('u1');
  expect(cached.owner_user_id).toBe('u2');
  expect(cached.visibility).toBe('public');
});

it('keeps your own ownership, so your templates stay editable', async () => {
  await cacheWorkouts('u1', [workout({ owner_user_id: 'u1' })]);
  expect((await cachedWorkouts('u1'))[0].owner_user_id).toBe('u1');
});

it('re-caching an updated workout corrects a changed visibility', async () => {
  await cacheWorkouts('u1', [workout({ visibility: 'private' })]);
  await cacheWorkouts('u1', [workout({ visibility: 'public' })]);
  expect((await cachedWorkouts('u1'))[0].visibility).toBe('public');
});

it('returns every discipline when no sport is given', async () => {
  // What the Plan tab needs — it lists across disciplines.
  await cacheWorkouts('u1', [
    workout({ id: 'a', sport: 'strength' }),
    workout({ id: 'b', sport: 'bjj' }),
  ]);
  expect((await cachedWorkouts('u1')).map((w) => w.id).sort()).toEqual(['a', 'b']);
});

it('narrows to one discipline when asked', async () => {
  await cacheWorkouts('u1', [
    workout({ id: 'a', sport: 'strength' }),
    workout({ id: 'b', sport: 'bjj' }),
  ]);
  expect((await cachedWorkouts('u1', 'bjj')).map((w) => w.id)).toEqual(['b']);
});

it("does not serve one athlete's cache to another", async () => {
  await cacheWorkouts('u1', [workout()]);
  expect(await cachedWorkouts('u2')).toEqual([]);
});

it('re-caching corrects a stale owner, not just a stale visibility', async () => {
  // The ON CONFLICT clause refreshes owner_user_id, and the v8 backfill's
  // "self-corrects on the next refresh" story depends entirely on it — but
  // the only conflict-path test asserted visibility, so removing just the
  // owner half survived every test.
  await cacheWorkouts('u1', [workout({ owner_user_id: null })]);
  await cacheWorkouts('u1', [workout({ owner_user_id: 'u1' })]);
  expect((await cachedWorkouts('u1'))[0].owner_user_id).toBe('u1');
});

it('keeps athletes apart in the sport-filtered read too', async () => {
  // The isolation test used the no-sport branch and the sport test used one
  // athlete, so the sport branch's `user_id = ?` was unpinned — and that is
  // the branch the offline session-start screen actually calls.
  await cacheWorkouts('u1', [workout({ id: 'a', sport: 'bjj' })]);
  await cacheWorkouts('u2', [workout({ id: 'b', sport: 'bjj' })]);
  expect((await cachedWorkouts('u1', 'bjj')).map((w) => w.id)).toEqual(['a']);
});

it('round-trips items and goal', async () => {
  // Nothing asserted either. The Plan tab renders items.length from cache,
  // and carrying `goal` offline was the entire point of schema v6 — without
  // it a session started offline progresses on a different rep range than
  // the same session once it has signal.
  await cacheWorkouts('u1', [
    workout({
      goal: 'powerlifting',
      items: [{ exercise_id: 'squat', position: 0, target_sets: 5, target_reps: 3 }] as never,
    }),
  ]);
  const [cached] = await cachedWorkouts('u1');
  expect(cached.goal).toBe('powerlifting');
  expect(cached.items).toHaveLength(1);
  expect(cached.items[0].exercise_id).toBe('squat');
});

it('drops a workout that is no longer in the list', async () => {
  // Reconciliation. Nothing ever deleted from this table, so a workout
  // deleted here or on the web stayed cached forever — flashing back on
  // every Plan-tab focus, and offline simply listed as still existing.
  await cacheWorkouts('u1', [workout({ id: 'a' }), workout({ id: 'b' })]);
  await cacheWorkouts('u1', [workout({ id: 'a' })]);
  expect((await cachedWorkouts('u1')).map((w) => w.id)).toEqual(['a']);
});

it('an empty list clears this athlete cache and leaves others alone', async () => {
  await cacheWorkouts('u1', [workout({ id: 'a' })]);
  await cacheWorkouts('u2', [workout({ id: 'b' })]);
  await cacheWorkouts('u1', []);
  expect(await cachedWorkouts('u1')).toEqual([]);
  expect((await cachedWorkouts('u2')).map((w) => w.id)).toEqual(['b']);
});
