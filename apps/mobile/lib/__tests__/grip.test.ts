import type { Exercise } from '../exercises';
import {
  describeSet,
  emptyDropSet,
  emptySet,
  gripApplies,
  gripsFor,
  offeredGrips,
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

  it('now asks on hinges, carries and olympic lifts — the whole of N9', () => {
    // This test used to assert the OPPOSITE, and the inversion is the feature.
    // The four-value list could not answer a heavy deadlift, so the picker was
    // withheld rather than collect "regular" for a mixed pull. With `mixed` and
    // `hook` in the vocabulary the question is answerable, so 93 exercises that
    // had no grip control now have one.
    for (const p of ['hinge', 'carry', 'olympic']) {
      expect(gripApplies(p)).toBe(true);
    }
  });

  it('offers mixed on hinges ALONE', () => {
    // You do not mix-grip a snatch, and a mixed farmer's carry is not a thing.
    // Offering it there would be the same false-entry mistake the old design
    // avoided by withholding the picker, just relocated.
    expect(gripsFor('hinge')).toContain('mixed');
    for (const p of ['carry', 'olympic', 'horizontal_push', 'vertical_pull', 'isolation']) {
      expect(gripsFor(p)).not.toContain('mixed');
    }
  });

  it('offers neutral on hinges and olympic lifts, which reads wrong and is not', () => {
    // The catalog decides this, not intuition. `hinge` holds the Hex Bar
    // Deadlift and four kettlebell/dumbbell swings; `olympic` is 22 kettlebell
    // and dumbbell cleans and snatches out of 25. Dropping `neutral` from
    // either — the obvious tidy-up — would take the grip control away from
    // most of the bucket.
    expect(gripsFor('hinge')).toContain('neutral');
    expect(gripsFor('olympic')).toContain('neutral');
  });

  it('never offers a grip the movement cannot use', () => {
    // The four original values stay off carries and olympic lifts where they
    // are meaningless, and hook/mixed stay off presses.
    for (const p of [
      'horizontal_push',
      'horizontal_pull',
      'vertical_push',
      'vertical_pull',
      'isolation',
    ]) {
      expect(gripsFor(p)).toEqual(['regular', 'neutral', 'reverse', 'angled']);
    }
    expect(gripsFor('carry')).not.toContain('angled');
    expect(gripsFor('olympic')).not.toContain('reverse');
  });

  it('shows a grip the set already holds even when the movement would not offer it', () => {
    // The UI end of #256. The server decides how many grips exist, so a set can
    // carry a value this build's subset does not list — a newer server's grip,
    // or one recorded before a subset changed. Rendering only the subset leaves
    // it visible in the summary line but with NO CHIP TO TAP, so the single way
    // back to "unrecorded" disappears and the athlete is stuck with it.
    const shown = offeredGrips('horizontal_push', 'hook' as never);
    expect(shown.map((g) => g.key)).toEqual([
      'regular',
      'neutral',
      'reverse',
      'angled',
      'hook',
    ]);
    // Appended, never substituted: the common answers keep their positions, so
    // muscle memory is not rearranged by an odd value on one set.
    expect(shown[0].key).toBe('regular');
  });

  it('labels a grip it has never heard of rather than rendering an empty chip', () => {
    // A value from a NEWER server, outside all six. Falling back to the raw key
    // is ugly and truthful; an empty chip is untappable and invisible.
    const shown = offeredGrips('hinge', 'mixed_left' as never);
    expect(shown.at(-1)).toEqual({ key: 'mixed_left', label: 'mixed_left' });
  });

  it('does not duplicate the held grip when the movement already offers it', () => {
    expect(offeredGrips('hinge', 'mixed').map((g) => g.key)).toEqual([
      'regular',
      'neutral',
      'mixed',
      'hook',
    ]);
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
    // where the answer actually lives: the push catches the server's
    // `invalid_grip` code, drops the grip and retries. Both places it can be
    // refused — the create and the sets push — settle it, and `gripPush.test.ts`
    // is what holds that, including the case where the retry must NOT happen
    // because the athlete edited the session mid-push.
    // **This line was `'mixed'` until N9, and N9 disarmed it.** Adding `mixed`
    // to the vocabulary turned the one assertion covering "a value a NEWER
    // server added" into a test of a value this build already knows — still
    // green, covering nothing. T4's entry asked the first PR adding a grip to
    // confirm an old build round-trips it rather than trust the entry; this is
    // that confirmation, and it found the guard rotting rather than holding.
    //
    // So the probe must always be a value OUTSIDE the current six. `mixed_left`
    // is the plausible next one (a side on the mixed grip, deliberately not
    // shipped in N9). **Whoever adds it must move this line again.**
    expect(repairSet(set({ grip: 'banana' as LoggedSet['grip'] })).grip).toBe('banana');
    expect(repairSet(set({ grip: 'mixed_left' as LoggedSet['grip'] })).grip).toBe(
      'mixed_left',
    );
    // And the two values N9 DID add must survive as ordinary known grips, which
    // is the other half of the round-trip: a server sending `mixed` to a build
    // that has it must not be treated as exotic either.
    expect(repairSet(set({ grip: 'mixed' })).grip).toBe('mixed');
    expect(repairSet(set({ grip: 'hook' })).grip).toBe('hook');
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
