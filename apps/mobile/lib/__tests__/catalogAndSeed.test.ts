import { cacheExercises, cachedExercises } from '../sessionStore';
import {
  PREF_PINNED_RECORDS,
  PREF_SEEDED_AT,
  PREF_TRACK_EFFORT,
  PREF_UNIT_SYSTEM,
  PREF_UNIT_SYSTEM_OWED,
  adoptLegacyOwedFlags,
  clearPrefOwed,
  countOwedPrefs,
  owedPrefs,
  readPref,
  writePref,
} from '../prefs';
import { hasSeeded, runSeed, seedSteps, type SeedStep } from '../seed';

import type { Exercise } from '../exercises';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * PR5: the catalog stops being lossy, prefs get an outbox, and a fresh
 * install fills itself.
 *
 * Driven against the real SQLite fixture wherever schema is involved — the
 * lossless blob and the pref outbox are both claims about what SQL actually
 * stores, and a mocked db would let either pass while storing nothing.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const exercise = (over: Partial<Exercise> = {}): Exercise => ({
  id: 'e1',
  name: 'Back Squat',
  sport: 'strength',
  movement_pattern: 'squat',
  primary_muscles: ['quads', 'glutes'],
  secondary_muscles: ['hamstrings'],
  equipment: ['barbell', 'rack'],
  load_type: 'weight_reps',
  is_unilateral: false,
  instructions: 'Brace, sit down between your hips, drive up.',
  media: [
    {
      kind: 'thumbnail',
      storage_key: 'k',
      url: 'https://example.test/squat.jpg',
      content_type: 'image/jpeg',
      width: 200,
      height: 200,
      position: 0,
    },
  ],
  ...over,
});

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

describe('the catalog cache is lossless', () => {
  it('gives back the SAME exercise that went in', async () => {
    // The old cache stored seven typed columns and reconstructed the rest as
    // empty, so offline an exercise had no muscles, no equipment and no
    // instructions — the Library looked gutted rather than cached, with
    // nothing on screen explaining why.
    const e = exercise();
    await cacheExercises([e]);
    expect((await cachedExercises())[0]).toEqual(e);
  });

  it('keeps the fields the typed columns never had', async () => {
    await cacheExercises([exercise()]);
    const got = (await cachedExercises())[0];
    expect(got.primary_muscles).toEqual(['quads', 'glutes']);
    expect(got.equipment).toEqual(['barbell', 'rack']);
    expect(got.instructions).toMatch(/Brace/);
  });

  it('still filters by sport, which is why the typed columns stay', async () => {
    // The blob is for fidelity; the columns are what SQL can query. Storing
    // only the blob would mean filtering the whole catalog in JS.
    await cacheExercises([exercise(), exercise({ id: 'e2', sport: 'bjj', name: 'Armbar' })]);
    expect((await cachedExercises('bjj')).map((e) => e.name)).toEqual(['Armbar']);
  });

  it('falls back to the columns for a pre-v10 row rather than dropping it', async () => {
    // Rows written before v10 have no payload and nothing to backfill from.
    // A searchable name with no detail beats an exercise that has vanished.
    await cacheExercises([exercise()]);
    await db.runAsync(`UPDATE exercise_cache SET payload_json = NULL`);
    const got = (await cachedExercises())[0];
    expect(got.name).toBe('Back Squat');
    expect(got.primary_muscles).toEqual([]);
  });

  it('survives a corrupt blob the same way', async () => {
    await cacheExercises([exercise()]);
    await db.runAsync(`UPDATE exercise_cache SET payload_json = 'not json'`);
    expect((await cachedExercises())[0].name).toBe('Back Squat');
  });
});

describe('the preference outbox', () => {
  it('marks a locally-changed preference as owed', async () => {
    await writePref('u1', PREF_UNIT_SYSTEM, 'imperial', { owed: true });
    expect(await owedPrefs('u1')).toEqual([{ key: PREF_UNIT_SYSTEM, value: 'imperial' }]);
  });

  it('does NOT clear the debt on a write that says nothing about it', async () => {
    // The failure this prevents: a profile fetch adopting the server's value
    // and silently discarding a change the athlete made offline seconds ago.
    await writePref('u1', PREF_UNIT_SYSTEM, 'imperial', { owed: true });
    await writePref('u1', PREF_UNIT_SYSTEM, 'imperial');
    expect(await countOwedPrefs('u1')).toBe(1);
  });

  it('does not invent a debt for an ordinary write', async () => {
    await writePref('u1', PREF_UNIT_SYSTEM, 'metric');
    expect(await countOwedPrefs('u1')).toBe(0);
  });

  it('clears the debt only for the value that was actually pushed', async () => {
    await writePref('u1', PREF_UNIT_SYSTEM, 'imperial', { owed: true });
    await clearPrefOwed('u1', PREF_UNIT_SYSTEM, 'imperial');
    expect(await countOwedPrefs('u1')).toBe(0);
  });

  it('leaves a change made DURING the push still owed', async () => {
    // Same compare-and-swap the session and workout outboxes use. Without it
    // the second change is marked as sent and never goes out.
    await writePref('u1', PREF_UNIT_SYSTEM, 'imperial', { owed: true });
    await writePref('u1', PREF_UNIT_SYSTEM, 'metric', { owed: true });
    await clearPrefOwed('u1', PREF_UNIT_SYSTEM, 'imperial');
    expect(await countOwedPrefs('u1')).toBe(1);
  });

  it('keeps debts separate per account on a shared device', async () => {
    await writePref('u1', PREF_UNIT_SYSTEM, 'imperial', { owed: true });
    expect(await countOwedPrefs('u2')).toBe(0);
  });
});

describe('migrating the legacy OWED companion keys', () => {
  it('carries an outstanding debt onto the dirty column', async () => {
    // Dropping it would revert the athlete's offline choice on the next
    // profile fetch — the precise bug the old flag existed to prevent.
    await writePref('u1', PREF_UNIT_SYSTEM, 'imperial');
    await writePref('u1', PREF_UNIT_SYSTEM_OWED, '1');

    await adoptLegacyOwedFlags('u1');

    expect(await countOwedPrefs('u1')).toBe(1);
    expect(await readPref('u1', PREF_UNIT_SYSTEM_OWED)).toBeNull();
  });

  it('does not invent a debt when the legacy flag was cleared', async () => {
    await writePref('u1', PREF_UNIT_SYSTEM, 'imperial');
    await writePref('u1', PREF_UNIT_SYSTEM_OWED, '0');

    await adoptLegacyOwedFlags('u1');

    expect(await countOwedPrefs('u1')).toBe(0);
  });

  it('is idempotent', async () => {
    await writePref('u1', PREF_TRACK_EFFORT, '1');
    await writePref('u1', 'track_effort_owed', '1');
    await adoptLegacyOwedFlags('u1');
    await adoptLegacyOwedFlags('u1');
    expect(await countOwedPrefs('u1')).toBe(1);
  });
});

describe('the first-run seed', () => {
  const okDeps = () => {
    const order: SeedStep[] = [];
    const step = (name: SeedStep) => async () => void order.push(name);
    return {
      order,
      deps: {
        profile: step('profile'),
        exercises: step('exercises'),
        workouts: step('workouts'),
        sessions: step('sessions'),
        pinned: step('pinned'),
      },
    };
  };

  it('declares the same steps it runs', () => {
    // Guards the two from drifting: `seedSteps` is what the ordering test
    // below asserts against, so if the loop ever stopped using it the
    // ordering test would be checking a list nothing executes.
    expect(seedSteps()).toEqual(['profile', 'exercises', 'workouts', 'sessions', 'pinned']);
  });

  it('runs the steps in dependency order', async () => {
    // Not cosmetic. The profile carries the unit system (a weight in the
    // wrong unit for one frame is the bug that started the units work);
    // exercises precede workouts because a plan's items are exercise ids;
    // workouts precede sessions for the same reason a workout is pushed
    // before a session referencing it.
    const { order, deps } = okDeps();
    await runSeed('u1', deps);
    expect(order).toEqual(['profile', 'exercises', 'workouts', 'sessions', 'pinned']);
  });

  it('records completion so the next launch skips it', async () => {
    const { deps } = okDeps();
    await runSeed('u1', deps, () => '2026-08-01T10:00:00Z');
    expect(await hasSeeded('u1')).toBe(true);
    expect(await readPref('u1', PREF_SEEDED_AT)).toBe('2026-08-01T10:00:00Z');
  });

  it('does NOT record a partial run as done', async () => {
    // Marking a half-finished seed as complete leaves the missing pieces
    // missing until the athlete happens to open the screen that fetches them
    // — exactly the situation the seed exists to prevent.
    const { deps } = okDeps();
    deps.workouts = async () => {
      throw new Error('Network request failed');
    };

    const r = await runSeed('u1', deps);

    expect(r.complete).toBe(false);
    expect(await hasSeeded('u1')).toBe(false);
  });

  it('keeps going after a failed step instead of aborting', async () => {
    // Offline every step fails, so there is nothing to abort early for — and
    // a failed workouts fetch must not also cost the athlete their sessions.
    const { order, deps } = okDeps();
    deps.exercises = async () => {
      throw new Error('nope');
    };

    const r = await runSeed('u1', deps);

    expect(order).toContain('sessions');
    expect(r.failed).toEqual(['exercises']);
    expect(r.done).toEqual(['profile', 'workouts', 'sessions', 'pinned']);
  });

  it('reports nothing seeded when every step fails', async () => {
    const boom = async () => {
      throw new Error('offline');
    };
    const failing = {
      profile: boom, exercises: boom, workouts: boom, sessions: boom, pinned: boom,
    };

    const r = await runSeed('u1', failing);

    expect(r.done).toEqual([]);
    expect(r.complete).toBe(false);
    expect(await hasSeeded('u1')).toBe(false);
  });

  it('treats a never-seeded account as unseeded', async () => {
    expect(await hasSeeded('u1')).toBe(false);
  });

  it('seeds per account, not per device', async () => {
    // A shared device: one athlete's completed seed must not convince the
    // next one's install that their caches are already full.
    const { deps } = okDeps();
    await runSeed('u1', deps);
    expect(await hasSeeded('u2')).toBe(false);
  });

  it('stores the pinned shortlist where the Records screen can read it', async () => {
    await writePref('u1', PREF_PINNED_RECORDS, JSON.stringify(['e1', 'e2']));
    expect(JSON.parse((await readPref('u1', PREF_PINNED_RECORDS)) ?? '[]')).toEqual(['e1', 'e2']);
  });
});
