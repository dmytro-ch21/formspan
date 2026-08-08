import { measuresFor, type LoggedSet } from '../sessions';
import { withTarget } from '../workouts';
import {
  DEFAULT_MODE_SECONDS,
  groupModeOf,
  isDualMode,
  measuresForSet,
  setModeOf,
  withGroupMode,
  withSetMode,
} from '../setMode';

/**
 * Reps or time, per exercise.
 *
 * The invariant every test here defends: **a dual-mode set holds one measure or
 * the other, never both.** The mode is derived from `seconds`, so a row carrying
 * 12 reps AND 40 seconds is a row that two readers describe two different ways —
 * and one of them is the volume rollup.
 */

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'burpee',
  position: 0,
  set_type: 'working',
  reps: null,
  weight_kg: null,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: false,
  ...over,
});

describe('which exercises are dual-mode', () => {
  it('is exactly the ones whose only measure is repetitions', () => {
    expect(isDualMode('reps')).toBe(true);
    // A timed bench press is not a thing, and offering the toggle on 483
    // catalog entries would serve none of them.
    expect(isDualMode('weight_reps')).toBe(false);
    // One-directional by design: a plank logged in reps is a number nobody
    // wants in their history.
    expect(isDualMode('time')).toBe(false);
    expect(isDualMode('distance')).toBe(false);
    expect(isDualMode('distance_time')).toBe(false);
    expect(isDualMode(undefined)).toBe(false);
  });
});

describe('reading the mode off a set', () => {
  it('reads a positive duration as time mode', () => {
    expect(setModeOf(set({ seconds: 40 }), 'reps')).toBe('time');
  });

  it('reads no duration as reps mode', () => {
    expect(setModeOf(set({ reps: 15 }), 'reps')).toBe('reps');
  });

  it('treats a stored zero as no duration', () => {
    // Same guard `workSecondsFor` uses. A row in "time mode" with nothing to
    // count would render a duration field holding 0 and a timer that fires
    // immediately.
    expect(setModeOf(set({ seconds: 0 }), 'reps')).toBe('reps');
    expect(setModeOf(set({ seconds: -5 }), 'reps')).toBe('reps');
  });

  it('never asks a non-dual exercise, whatever it carries', () => {
    expect(setModeOf(set({ seconds: 60 }), 'time')).toBe('time');
    expect(setModeOf(set({ seconds: 60 }), 'weight_reps')).toBe('reps');
    expect(setModeOf(set({ seconds: null }), 'distance_time')).toBe('time');
  });
});

describe('switching one set', () => {
  it('clears the measure it is leaving', () => {
    const timed = withSetMode(set({ reps: 15 }), 'reps', 'time');
    expect(timed.reps).toBeNull();
    expect(timed.seconds).toBe(DEFAULT_MODE_SECONDS);

    const counted = withSetMode(timed, 'reps', 'reps');
    expect(counted.seconds).toBeNull();
  });

  it('is a no-op when it is already in that mode', () => {
    // Same identity, so the caller can skip the write and the save it triggers.
    const s = set({ seconds: 40 });
    expect(withSetMode(s, 'reps', 'time')).toBe(s);
  });

  it('refuses to touch an exercise that is not dual-mode', () => {
    // A toggle that reached a barbell squat is a bug upstream; blanking its
    // reps would make it a data-losing one.
    const squat = set({ exercise_id: 'squat', reps: 5, weight_kg: 100 });
    expect(withSetMode(squat, 'weight_reps', 'time')).toBe(squat);
    expect(withSetMode(squat, 'weight_reps', 'time').reps).toBe(5);
  });

  it('takes the duration it is given rather than the default', () => {
    expect(withSetMode(set({ reps: 15 }), 'reps', 'time', 90).seconds).toBe(90);
  });
});

describe('switching a whole exercise', () => {
  const group = [set({ reps: 15 }), set({ reps: 15 }), set({ reps: 15 })];

  it('moves every pending set', () => {
    const out = withGroupMode(group, [0, 1, 2], 'reps', 'time');
    expect(out.map((s) => s.seconds)).toEqual([
      DEFAULT_MODE_SECONDS,
      DEFAULT_MODE_SECONDS,
      DEFAULT_MODE_SECONDS,
    ]);
    expect(out.every((s) => s.reps === null)).toBe(true);
  });

  it('leaves completed sets exactly as they were', () => {
    // A completed set is a record of something that happened. Rewriting its
    // measure would erase it.
    const mixed = [set({ reps: 15, completed: true }), set({ reps: 15 })];
    const out = withGroupMode(mixed, [0, 1], 'reps', 'time');
    expect(out[0].reps).toBe(15);
    expect(out[0].seconds).toBeNull();
    expect(out[1].reps).toBeNull();
  });

  it('re-seeds from a duration the group already carried', () => {
    // A template that prescribed 3 × 40s, flipped to reps and back, must come
    // back as 40s rather than as the generic default.
    const prescribed = [set({ seconds: 40 }), set({ seconds: 40 })];
    const toReps = withGroupMode(prescribed, [0, 1], 'reps', 'reps');
    expect(toReps.every((s) => s.seconds === null)).toBe(true);
    // Nothing left to re-seed from, so this one falls to the default — which is
    // exactly why the seeding is read BEFORE the clear in a single call.
    const backAgain = withGroupMode(
      [set({ seconds: 40, completed: true }), set({ reps: null })],
      [0, 1],
      'reps',
      'time',
    );
    expect(backAgain[1].seconds).toBe(40);
  });

  it('touches nothing outside the group', () => {
    const sets = [set({ exercise_id: 'squat', reps: 5 }), set({ reps: 15 })];
    const out = withGroupMode(sets, [1], 'reps', 'time');
    expect(out[0].reps).toBe(5);
    expect(out[1].seconds).toBe(DEFAULT_MODE_SECONDS);
  });

  it('returns the same array when nothing changed', () => {
    expect(withGroupMode(group, [0, 1, 2], 'reps', 'reps')).toBe(group);
    expect(withGroupMode(group, [0, 1, 2], 'weight_reps', 'time')).toBe(group);
  });
});

describe('the mode a group renders as', () => {
  it('reads the first PENDING row, not the first row', () => {
    // A group can only be mixed where a completed set held the old mode, and in
    // that case the pending work is what the chip is about.
    const mixed = [set({ reps: 15, completed: true }), set({ seconds: 40 })];
    expect(groupModeOf(mixed, [0, 1], 'reps')).toBe('time');
  });

  it('falls back to the first row when everything is done', () => {
    const done = [set({ seconds: 40, completed: true })];
    expect(groupModeOf(done, [0], 'reps')).toBe('time');
  });

  it('answers reps for an empty group rather than throwing', () => {
    expect(groupModeOf([], [], 'reps')).toBe('reps');
  });
});

describe('which fields a row edits', () => {
  it('offers a duration and no reps in time mode', () => {
    expect(measuresForSet(set({ seconds: 40 }), 'reps', measuresFor)).toEqual(['seconds']);
  });

  it('offers reps and no duration in reps mode', () => {
    expect(measuresForSet(set(), 'reps', measuresFor)).toEqual(['reps']);
  });

  it('defers entirely to the load type for anything not dual-mode', () => {
    expect(measuresForSet(set(), 'weight_reps', measuresFor)).toEqual(['reps', 'weight']);
    expect(measuresForSet(set(), 'distance_time', measuresFor)).toEqual(['distance', 'seconds']);
  });

  it('falls back to reps while the catalog is still loading', () => {
    expect(measuresForSet(set(), undefined, measuresFor)).toEqual(['reps']);
  });
});

describe('a template target, kept to one measure', () => {
  const item = {
    exercise_id: 'burpee',
    position: 0,
    target_sets: 3,
    target_reps: null as number | null,
    target_weight_kg: null as number | null,
    target_seconds: null as number | null,
    target_distance_m: null as number | null,
    notes: '',
  };

  it('clears the counterpart on a dual-mode exercise', () => {
    // A template holding "3 × 15 AND 40s" hands that ambiguity to every session
    // started from it, where the duration wins and the rep target sits in the
    // data meaning nothing.
    const timed = withTarget({ ...item, target_reps: 15 }, 'seconds', 40, 'reps');
    expect(timed.target_seconds).toBe(40);
    expect(timed.target_reps).toBeNull();

    const counted = withTarget(timed, 'reps', 15, 'reps');
    expect(counted.target_reps).toBe(15);
    expect(counted.target_seconds).toBeNull();
  });

  it('leaves the counterpart alone when the field is being cleared', () => {
    // Emptying the seconds box must not also wipe reps — that is a two-field
    // delete from one backspace.
    const both = { ...item, target_reps: 15, target_seconds: 40 };
    expect(withTarget(both, 'seconds', null, 'reps').target_reps).toBe(15);
  });

  it('never clears anything on an exercise that is not dual-mode', () => {
    // `distance_time` legitimately carries both: there the pair is a distance
    // and how long it took, not two ways of counting one thing.
    const run = { ...item, exercise_id: 'row', target_distance_m: 500 };
    expect(withTarget(run, 'seconds', 120, 'distance_time')).toMatchObject({
      target_distance_m: 500,
      target_seconds: 120,
    });
    // And a weighted lift keeps its reps when a weight is typed.
    const squat = { ...item, target_reps: 5 };
    expect(withTarget(squat, 'weight', 100, 'weight_reps').target_reps).toBe(5);
  });

  it('writes the field it was asked to write, for every target', () => {
    // The map lived in the workout screen as a local copy until this function
    // took it over; a missing entry here is a field that silently never saves.
    expect(withTarget(item, 'sets', 4, 'weight_reps').target_sets).toBe(4);
    expect(withTarget(item, 'reps', 8, 'weight_reps').target_reps).toBe(8);
    expect(withTarget(item, 'weight', 60, 'weight_reps').target_weight_kg).toBe(60);
    expect(withTarget(item, 'seconds', 45, 'time').target_seconds).toBe(45);
    expect(withTarget(item, 'distance', 400, 'distance').target_distance_m).toBe(400);
  });
});
