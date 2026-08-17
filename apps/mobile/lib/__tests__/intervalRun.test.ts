import { READY_SECONDS } from '../countdown';
import {
  advanced,
  buildExerciseRun,
  buildSessionRun,
  canRun,
  countdownFor,
  nextStep,
  pendingIndices,
  runProgress,
  runSeconds,
  type Run,
  type RunContext,
} from '../intervalRun';
import type { Exercise } from '../exercises';
import { workSecondsFor, type LoggedSet } from '../sessions';

const set = (exercise: string, over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: exercise,
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

/** Everything injected, so a four-set circuit needs no catalog and no database. */
const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  workSeconds: (s) => (s.seconds != null && s.seconds > 0 ? s.seconds : null),
  restSeconds: () => 20,
  name: (id) => id,
  step: () => 15,
  ...over,
});

const kinds = (steps: { kind: string }[]) => steps.map((s) => s.kind);

describe('what can be run', () => {
  it('needs every pending set to be timed', () => {
    const timed = [set('burpee', { seconds: 40 }), set('burpee', { seconds: 40 })];
    expect(canRun(timed, [0, 1], ctx())).toBe(true);

    // One untimed set anywhere kills it. All-or-nothing on purpose: a run that
    // quietly skipped the untimed sets would stop guiding halfway through
    // without saying so.
    const mixed = [set('burpee', { seconds: 40 }), set('squat', { reps: 5 })];
    expect(canRun(mixed, [0, 1], ctx())).toBe(false);
  });

  it('lets a weighted set join a circuit once it carries a duration — N4', () => {
    // The claim in TASKS.md was "circuits fall out of it", and this is the
    // only place that can prove it, because `canRun` consults nothing but
    // `workSeconds`. So this test wires the REAL `workSecondsFor` in rather
    // than the stub above — with the stub it would pass identically before
    // and after N4 and prove nothing about the app.
    const loadTypes: Record<string, Exercise['load_type']> = {
      squat: 'weight_reps',
      burpee: 'reps',
    };
    const real = ctx({
      workSeconds: (s) => workSecondsFor(s, loadTypes[s.exercise_id]),
    });

    // Before N4 this was false: a weight×reps set was refused a timer whatever
    // duration it carried, so one squat in a circuit disqualified the whole
    // run.
    const circuit = [set('burpee', { seconds: 40 }), set('squat', { reps: 15, seconds: 40 })];
    expect(canRun(circuit, [0, 1], real)).toBe(true);

    // And the half that must NOT change: a squat with no duration is still
    // untimed, so the all-or-nothing gate still refuses the run. If this ever
    // goes true, `workSecondsFor` has started inventing durations.
    const untimed = [set('burpee', { seconds: 40 }), set('squat', { reps: 15 })];
    expect(canRun(untimed, [0, 1], real)).toBe(false);
  });

  it('ignores sets that are already done', () => {
    const sets = [set('squat', { reps: 5, completed: true }), set('burpee', { seconds: 40 })];
    expect(canRun(sets, [0, 1], ctx())).toBe(true);
  });

  it('refuses a group with nothing left to do', () => {
    // Otherwise "Run all" appears on a finished exercise and starts a run with
    // no steps in it.
    const done = [set('burpee', { seconds: 40, completed: true })];
    expect(canRun(done, [0], ctx())).toBe(false);
    expect(canRun([], [], ctx())).toBe(false);
  });

  it('counts only what is pending', () => {
    const sets = [set('a', { completed: true }), set('a'), set('a')];
    expect(pendingIndices(sets, [0, 1, 2])).toEqual([1, 2]);
  });
});

describe('one exercise, back to back', () => {
  const three = [
    set('burpee', { seconds: 40 }),
    set('burpee', { seconds: 40 }),
    set('burpee', { seconds: 40 }),
  ];

  it('counts you in before every set, not just the first', () => {
    // Rest ends, you get three counted seconds, you go. The second set needs it
    // exactly as much as the first.
    expect(kinds(buildExerciseRun(three, [0, 1, 2], ctx()))).toEqual([
      'ready', 'work', 'rest',
      'ready', 'work', 'rest',
      'ready', 'work',
    ]);
  });

  it('never trails a rest after the last set', () => {
    // The run is over; a trailing countdown is the app holding the screen
    // hostage after the work is done.
    const steps = buildExerciseRun(three, [0, 1, 2], ctx());
    expect(steps[steps.length - 1].kind).toBe('work');
  });

  it('skips the sets already logged', () => {
    const partly = [
      set('burpee', { seconds: 40, completed: true }),
      set('burpee', { seconds: 40 }),
    ];
    const steps = buildExerciseRun(partly, [0, 1], ctx());
    expect(kinds(steps)).toEqual(['ready', 'work']);
    expect(steps[1].setIndex).toBe(1);
  });

  it('carries the row index, not the position in the run', () => {
    // A work step WRITES to a set. Pointing it at the wrong row is the silent
    // corruption `timedSetStillAt` exists to backstop.
    const partly = [set('a', { completed: true }), set('b', { seconds: 30 })];
    expect(buildExerciseRun(partly, [0, 1], ctx())[1].setIndex).toBe(1);
  });

  it('numbers the sets for the copy on the timer', () => {
    const steps = buildExerciseRun(three, [0, 1, 2], ctx());
    const works = steps.filter((s) => s.kind === 'work');
    expect(works.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(works.every((s) => s.total === 3)).toBe(true);
  });

  it('can be built without the count-in', () => {
    expect(kinds(buildExerciseRun(three, [0], ctx(), { lead: false }))).toEqual(['work']);
  });

  it('drops a set it cannot time rather than inventing a duration', () => {
    // Reachable only if the plan is built without `canRun` gating it; the step
    // list is what actually runs, so it must never contain a guess.
    const mixed = [set('burpee', { seconds: 40 }), set('squat', { reps: 5 })];
    expect(kinds(buildExerciseRun(mixed, [0, 1], ctx()))).toEqual(['ready', 'work', 'rest']);
  });
});

describe('a whole session', () => {
  const sets = [
    set('burpee', { seconds: 40 }),
    set('burpee', { seconds: 40 }),
    set('climber', { seconds: 30 }),
  ];
  const groups = [
    { exerciseID: 'burpee', indices: [0, 1] },
    { exerciseID: 'climber', indices: [2] },
  ];

  it('rests between exercises as well as between sets', () => {
    expect(kinds(buildSessionRun(sets, groups, ctx()))).toEqual([
      'ready', 'work', 'rest',
      'ready', 'work',
      'rest',
      'ready', 'work',
    ]);
  });

  it('rests on the exercise just finished, not the one coming up', () => {
    // You are recovering from what you did.
    const steps = buildSessionRun(sets, groups, ctx({ restSeconds: (id) => (id === 'burpee' ? 60 : 10) }));
    const between = steps[5];
    expect(between.kind).toBe('rest');
    expect(between.seconds).toBe(60);
  });

  it('renumbers the sets across the whole run', () => {
    // Per-group ordinals restarting at 1 for every exercise would make "set 1
    // of 2" appear twice in one workout.
    const works = buildSessionRun(sets, groups, ctx()).filter((s) => s.kind === 'work');
    expect(works.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(works.every((s) => s.total === 3)).toBe(true);
  });

  it('adds no trailing rest at the very end', () => {
    const steps = buildSessionRun(sets, groups, ctx());
    expect(steps[steps.length - 1].kind).toBe('work');
  });

  it('does not leave a rest hanging after a group with nothing to run', () => {
    // A group whose sets are all done contributes no steps; treating it as a
    // group anyway would put a rest between two exercises with nothing in
    // between them.
    const withDone = [...sets, set('plank', { seconds: 60, completed: true })];
    const steps = buildSessionRun(withDone, [...groups, { exerciseID: 'plank', indices: [3] }], ctx());
    expect(steps[steps.length - 1].kind).toBe('work');
    expect(steps.filter((s) => s.kind === 'rest')).toHaveLength(2);
  });
});

describe('how long it takes', () => {
  it('adds up every step, count-ins included', () => {
    const two = [set('burpee', { seconds: 40 }), set('burpee', { seconds: 40 })];
    const steps = buildExerciseRun(two, [0, 1], ctx());
    // ready + 40 + 20 rest + ready + 40
    expect(runSeconds(steps)).toBe(READY_SECONDS * 2 + 40 + 20 + 40);
  });

  it('is zero for an empty plan', () => {
    expect(runSeconds([])).toBe(0);
  });
});

describe('walking the plan', () => {
  const steps = buildExerciseRun(
    [set('burpee', { seconds: 40 }), set('burpee', { seconds: 40 })],
    [0, 1],
    ctx(),
  );
  const run: Run = { steps, at: 0, scope: 'exercise' };

  it('advances one step at a time and stops at the end', () => {
    let cursor: Run | null = run;
    const seen: string[] = [];
    while (cursor) {
      seen.push(cursor.steps[cursor.at].kind);
      cursor = advanced(cursor);
    }
    expect(seen).toEqual(kinds(steps));
  });

  it('knows when there is nothing next', () => {
    expect(nextStep({ ...run, at: steps.length - 1 })).toBeNull();
    expect(advanced({ ...run, at: steps.length - 1 })).toBeNull();
  });

  it('hands the timer a countdown, not a step', () => {
    // Two different types on purpose: a step is a plan and a countdown is a
    // live deadline that gets paused and adjusted. Converting at the boundary
    // keeps an adjusted countdown from writing back into the plan and silently
    // changing a later set's prescription.
    const c = countdownFor(steps[1]);
    expect(c).toMatchObject({ kind: 'work', total: 40, setIndex: 0, step: 15 });
    expect(c).not.toHaveProperty('ordinal');
  });
});

describe('progress through a run', () => {
  const steps = buildExerciseRun(
    [set('burpee', { seconds: 40 }), set('burpee', { seconds: 40 })],
    [0, 1],
    ctx(),
  );
  const total = runSeconds(steps);

  it('measures TIME, not steps', () => {
    // A three-second count-in and a forty-second work interval are one step
    // each; a step-counted bar would jump a fifth of the way along for three
    // seconds of standing still.
    const atStartOfWork: Run = { steps, at: 1, scope: 'exercise' };
    expect(runProgress(atStartOfWork, 40)).toBeCloseTo(READY_SECONDS / total, 5);
  });

  it('reaches one when the last step runs out', () => {
    const last: Run = { steps, at: steps.length - 1, scope: 'exercise' };
    expect(runProgress(last, 0)).toBeCloseTo(1, 5);
  });

  it('starts at zero', () => {
    expect(runProgress({ steps, at: 0, scope: 'exercise' }, READY_SECONDS)).toBe(0);
  });

  it('never leaves the 0–1 range, whatever the clock says', () => {
    // The bar reads this as a width; over 100% overflows its track, and a
    // negative one is a React Native warning per frame.
    const last: Run = { steps, at: steps.length - 1, scope: 'exercise' };
    expect(runProgress(last, -30)).toBe(1);
    expect(runProgress({ steps, at: 0, scope: 'exercise' }, 999)).toBe(0);
  });
});
