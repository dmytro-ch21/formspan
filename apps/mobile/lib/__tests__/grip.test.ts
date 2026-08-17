import type { Exercise } from '../exercises';
import {
  describeSet,
  emptyDropSet,
  emptySet,
  gripApplies,
  repairSet,
  swapExercise,
  type LoggedSet,
} from '../sessions';
import { withSetMode } from '../setMode';

/**
 * Grip is a property of the SET, and this file is mostly about the consequences
 * of that — what a new set inherits, what a swap must throw away, and what a
 * stale cached value must not be allowed to do.
 *
 * The pass-through half is T3's warning: the server replaces a session's sets
 * wholesale, so anything that builds a set field by field silently drops the
 * column and the next save wipes it.
 */

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'dumbbell-bench-press',
  position: 1,
  set_type: 'working',
  reps: 10,
  weight_kg: 30,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: true,
  grip: 'neutral',
  ...over,
});

describe('which movements ask about grip', () => {
  it('asks on presses, pulls and isolation work', () => {
    for (const p of [
      'horizontal_push',
      'horizontal_pull',
      'vertical_push',
      'vertical_pull',
      'isolation',
    ]) {
      expect(gripApplies(p)).toBe(true);
    }
  });

  it('does not ask where the answer is meaningless', () => {
    // A squat has no grip worth recording, and asking on every set of every
    // movement is how an optional field becomes noise nobody reads.
    for (const p of ['squat', 'lunge', 'jump', 'locomotion', 'mobility', 'core']) {
      expect(gripApplies(p)).toBe(false);
    }
  });

  it('does not ask on hinges, where the real answer is one this list lacks', () => {
    // The deliberate omission. A heavy deadlift is held mixed or hook, neither
    // of which is a variation of the four — so offering the picker here would
    // collect "regular" for a mixed pull. A false entry is worse than a missing
    // one, because nothing downstream can tell it from a real answer.
    for (const p of ['hinge', 'carry', 'olympic']) {
      expect(gripApplies(p)).toBe(false);
    }
  });

  it('does not ask when the exercise has not loaded yet', () => {
    // The catalog is fetched separately and can be absent offline; a picker
    // that appears on nothing is better than one that appears on everything.
    expect(gripApplies(undefined)).toBe(false);
  });
});

describe('what a new set inherits', () => {
  it('carries the previous set’s grip forward', () => {
    // You do not change grip between sets of one exercise unless you mean to,
    // so carrying it records what happened instead of asking four times.
    expect(emptySet('dumbbell-bench-press', 2, set()).grip).toBe('neutral');
  });

  it('carries nothing forward from an unrecorded set', () => {
    // The important direction. Inheriting a default would turn one unrecorded
    // set into a whole session of sets claiming `regular`.
    expect(emptySet('dumbbell-bench-press', 2, set({ grip: undefined })).grip).toBeUndefined();
  });

  it('starts unrecorded when there is no previous set', () => {
    expect(emptySet('dumbbell-bench-press', 1).grip).toBeUndefined();
  });

  it('carries onto a drop, which is the same bar and the same hands', () => {
    // A drop is the same approach at a lighter weight — the grip does not
    // change when you strip the plates.
    expect(emptyDropSet(set(), 2).grip).toBe('neutral');
  });
});

describe('what a swap must throw away', () => {
  const legPress = { id: 'leg-press', load_type: 'weight_reps' } as Exercise;

  it('clears the grip when the exercise changes', () => {
    // Grip describes the movement that was just replaced. Worse, the picker is
    // gated on movement pattern — so a grip left on a leg press is still sent
    // on every write and has no control anywhere that could clear it.
    const [swapped] = swapExercise([set()], 'dumbbell-bench-press', legPress, 'weight_reps');
    expect(swapped.grip).toBeNull();
  });

  it('clears it even when the shape matches and the numbers survive', () => {
    // A same-shape swap deliberately keeps reps and weight, which is what makes
    // a stale grip reachable at all — so this pins both halves together.
    const [swapped] = swapExercise([set()], 'dumbbell-bench-press', legPress, 'weight_reps');
    expect(swapped.reps).toBe(10);
    expect(swapped.grip).toBeNull();
  });
});

describe('what a mode change must NOT throw away', () => {
  it('keeps the grip when an exercise switches to time', () => {
    // Deliberately unlike `assisted_reps`, which goes with the reps because it
    // counts them. A dead hang has no reps and still very much has a grip, so
    // clearing here would delete a true fact to satisfy a false symmetry.
    // `reps` is the dual-mode load type — an assisted pull-up is the flagship
    // case, and it is exactly the movement whose grip matters most.
    const timed = withSetMode(set({ exercise_id: 'pull-up' }), 'reps', 'time');
    expect(timed.reps).toBeNull();
    expect(timed.grip).toBe('neutral');
  });
});

describe('a grip the server would refuse', () => {
  it('is KEPT locally, because only the server owns the vocabulary (T4)', () => {
    // This assertion used to be the opposite, and the reversal is the fix.
    //
    // `repairSet` runs on every read and knows four grips; the server decides
    // how many exist. Nulling anything outside the local list is right for
    // garbage and WRONG for a value a newer server legitimately added — an
    // older phone reads a valid `mixed`, nulls it, and the wholesale PUT writes
    // that null back over data the athlete recorded, silently and with no error
    // anywhere. The picker can only ever write a value from GRIPS, so an
    // unrecognised grip arrived FROM the server, which means the server takes
    // it.
    //
    // The protection this used to give has not been dropped, it has moved to
    // where the answer actually lives: the push now catches the server's
    // `invalid_grip` code, drops the grip and retries, so a genuinely illegal
    // value still cannot strand the session. See `pushRow` in sessionStore.
    expect(repairSet(set({ grip: 'banana' as LoggedSet['grip'] })).grip).toBe('banana');
    expect(repairSet(set({ grip: 'mixed' as LoggedSet['grip'] })).grip).toBe('mixed');
  });

  it('still drops something that could not be a grip at all', () => {
    // Shape is decidable locally; vocabulary is not. An empty string is not a
    // value on any server, and the API rejects it explicitly rather than
    // reading it as "clear it".
    expect(repairSet(set({ grip: '' as LoggedSet['grip'] })).grip).toBeNull();
  });

  it('leaves a legal grip alone', () => {
    // Or the guard above would be indistinguishable from "always clear it".
    expect(repairSet(set()).grip).toBe('neutral');
  });

  it('does not invent the key on a set that never had one', () => {
    // `repairSet` runs on every read, including rows cached by a build that
    // predates the column. Adding `grip: null` to those would be a write of a
    // fact nobody stated — and it would mark the row dirty for no reason.
    const never = set();
    delete never.grip; // NOT `grip: undefined` — that still creates the key.
    expect('grip' in repairSet(never)).toBe(false);
  });
});

describe('showing it back', () => {
  it('names the grip on the row', () => {
    expect(describeSet(set())).toBe('10 × 30kg · Neutral');
  });

  it('says nothing when it was never recorded', () => {
    // The whole discipline in one assertion: silence stays silence. Rendering
    // "Regular" here would be the app answering a question nobody asked.
    expect(describeSet(set({ grip: undefined }))).toBe('10 × 30kg');
  });
});
