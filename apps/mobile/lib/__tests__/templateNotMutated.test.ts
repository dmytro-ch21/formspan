import {
  cacheWorkouts,
  cachedWorkouts,
  finishLocalSession,
  renameLocalSession,
  saveLocalSets,
  startLocalSession,
} from '../sessionStore';
import type { LoggedSet } from '../sessions';
import type { Workout } from '../workouts';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * Running a session must never edit the template it came from.
 *
 * #587's original body called this out as "a correctness requirement, not just
 * a UX one", and asked for exactly this test: *logging a session's set does not
 * change the template it came from*. It did not exist. That the current write
 * paths happen not to touch `workout_cache` is not the same as a guard against
 * one that does — a `saveLocalSets` that "helpfully" wrote the achieved weights
 * back onto the plan is a plausible feature request, and it would silently
 * rewrite every athlete's programming from the rack.
 *
 * **Against a real database, not a mock.** The claim is about which ROWS
 * changed, and an array mock can only tell you which functions were called.
 * `migratedFixture` runs the app's own `migrate()`, so the schema under test is
 * the schema that ships — and a future migration that adds a trigger or an
 * `ON UPDATE CASCADE` between the two tables would fail here rather than on a
 * phone.
 *
 * The whole cached row is compared, not a field list. A field list only covers
 * the columns whoever wrote it thought of, and the interesting damage is always
 * to the one they did not.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const template: Workout = {
  id: 'w-push-a',
  owner_user_id: 'u1',
  name: 'Push A',
  sport: 'strength',
  goal: 'hypertrophy',
  notes: 'Two minutes between working sets.',
  visibility: 'private',
  // Every field set explicitly rather than cast past the type. A fixture that
  // lies about its own shape is the one thing this test cannot afford: the
  // assertion is that the stored row survives a round trip, so the row has to
  // be the row the app actually stores.
  items: [
    {
      exercise_id: 'bench-press',
      position: 1,
      target_sets: 3,
      target_reps: 8,
      target_weight_kg: 80,
      target_seconds: null,
      target_distance_m: null,
      notes: '',
    },
    {
      exercise_id: 'overhead-press',
      position: 2,
      target_sets: 3,
      target_reps: 10,
      target_weight_kg: 40,
      target_seconds: null,
      target_distance_m: null,
      notes: '',
    },
  ],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

/** Deliberately nothing like the template's targets — heavier, and one short. */
const logged: LoggedSet[] = [
  {
    exercise_id: 'bench-press',
    position: 1,
    set_type: 'working',
    // Both sets are done. `completed` is the flag whose write-without-read-back
    // once zeroed every session's volume, so a fixture that omits it is not the
    // row the app stores.
    completed: true,
    reps: 5,
    weight_kg: 100,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    notes: '',
  },
  {
    exercise_id: 'bench-press',
    position: 2,
    set_type: 'working',
    // Both sets are done. `completed` is the flag whose write-without-read-back
    // once zeroed every session's volume, so a fixture that omits it is not the
    // row the app stores.
    completed: true,
    reps: 4,
    weight_kg: 100,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    notes: '',
  },
];

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  await cacheWorkouts('u1', [template]);
});

it('leaves the template byte-identical after a whole session is logged against it', async () => {
  const before = await cachedWorkouts('u1');

  const session = await startLocalSession('u1', {
    sport: 'strength',
    name: 'Push A',
    workout_id: template.id,
  });
  await saveLocalSets('u1', session.id, logged);
  await renameLocalSession('u1', session.id, 'Push A — felt strong');
  await finishLocalSession('u1', session.id);

  expect(await cachedWorkouts('u1')).toEqual(before);
});

it('does not let the achieved sets overwrite the planned targets', async () => {
  // The specific damage the criterion is about, asserted on the values rather
  // than on deep equality — so a future change that rewrites only the targets
  // fails here with a legible message instead of a whole-object diff.
  const session = await startLocalSession('u1', {
    sport: 'strength',
    name: 'Push A',
    workout_id: template.id,
  });
  await saveLocalSets('u1', session.id, logged);

  const [after] = await cachedWorkouts('u1');
  expect(after.items[0].target_weight_kg).toBe(80);
  expect(after.items[0].target_reps).toBe(8);
  expect(after.items[0].target_sets).toBe(3);
  // And the exercise the athlete never touched is still there. A write-back
  // that replaced the item list with what was logged would drop it silently.
  expect(after.items).toHaveLength(2);
  expect(after.items[1].exercise_id).toBe('overhead-press');
});

it('does not mark the template dirty, so nothing is pushed on the session’s behalf', async () => {
  // A row flagged dirty is a row the outbox will PUT. Flipping the flag without
  // changing a value is the quiet half of this bug: the template survives on
  // this device and is overwritten on every other one at the next sync.
  const session = await startLocalSession('u1', {
    sport: 'strength',
    name: 'Push A',
    workout_id: template.id,
  });
  await saveLocalSets('u1', session.id, logged);
  await finishLocalSession('u1', session.id);

  const row = await db.getFirstAsync<{ dirty: number; name_dirty: number }>(
    'SELECT dirty, name_dirty FROM workout_cache WHERE id = ?',
    template.id,
  );
  // Both flags: `dirty` is owed to PUT /items and `name_dirty` to PATCH
  // /workouts/{id}, and they are cleared by different requests — so checking
  // only one leaves half the push path unguarded.
  expect(row?.dirty).toBe(0);
  expect(row?.name_dirty).toBe(0);
});
