/**
 * Running a timed exercise — or a whole timed workout — without touching the
 * phone again.
 *
 * A timed circuit is the one case where the app already knows everything that is
 * going to happen: forty seconds of burpees, twenty seconds rest, four times
 * over. Making the athlete press Start eight times for a sequence that was fully
 * determined before the first one is the app asking to be held, mid-burpee, with
 * wet hands.
 *
 * So this builds the whole sequence up front — `ready → work → rest → ready →
 * work → …` — as plain data, and the screen walks it one step at a time. Two
 * entry points, because they answer two different questions:
 *
 *  - {@link buildExerciseRun} — "run all sets" on one exercise. The common case.
 *  - {@link buildSessionRun} — a guided workout, start to finish, hands free.
 *
 * ## Why a plan rather than a state machine
 *
 * A machine that decides the next step when the current one ends has to hold the
 * session's shape, the rest durations and the completed flags at the moment of
 * transition — i.e. inside a timer callback, several minutes after the athlete
 * last looked. Building the list first means the whole sequence is inspectable
 * before it starts (the screen shows "4 sets · 4:00"), testable without a clock,
 * and — the part that matters in a gym — unaffected by a set being ticked or a
 * row being edited while it runs.
 *
 * The cost is that the plan can go stale, and that is handled the same way a
 * single work countdown handles it: `setIndex` is a position, positions move, so
 * the screen cancels the run on any structural change and `timedSetStillAt`
 * backstops the write. See `lib/sessions.ts`.
 *
 * ## What is deliberately NOT here
 *
 * **Untimed sets are never part of a run.** There is no honest way to
 * auto-advance past a set of squats: the app cannot know when you racked the
 * bar, and guessing would either cut the set short or log a rest that never
 * happened. {@link canRun} is the gate, and it is all-or-nothing on purpose —
 * a run that silently skipped the two untimed exercises in the middle would be a
 * "guided workout" that stops guiding halfway through without saying so.
 */

import { READY_SECONDS, type Countdown, type CountdownKind } from './countdown';
import type { LoggedSet } from './sessions';

export type RunStep = {
  kind: CountdownKind;
  seconds: number;
  /** What the timer says you are doing — the exercise name, for every kind. */
  label: string;
  exerciseID: string;
  /** The row a `work` step writes to. Absent on `ready` and `rest`. */
  setIndex?: number;
  /** ± granularity, carried from the exercise's duration unit. */
  step?: number;
  /** Which set of how many, for "Set 2 of 4" — counted over the run, not the group. */
  ordinal: number;
  total: number;
};

/** A run in progress: the plan, and where in it we are. */
export type Run = {
  steps: RunStep[];
  at: number;
  /** Whole session, or one exercise — the two differ only in what they say when done. */
  scope: 'exercise' | 'session';
};

/**
 * What a step needs to know about the exercise it belongs to.
 *
 * Passed in rather than looked up, so this module knows nothing about the
 * catalog, the prefs store or React — the same injection shape `swapSuggestions`
 * uses. It is also what lets a test build a four-set run without a database.
 */
export type RunContext = {
  /** How long this set's work interval is, or null if it cannot be timed. */
  workSeconds: (set: LoggedSet, exerciseID: string) => number | null;
  /** How long to rest after a set of this exercise. */
  restSeconds: (exerciseID: string) => number;
  name: (exerciseID: string) => string;
  /** ± granularity for this exercise, from its duration unit. */
  step: (exerciseID: string) => number;
};

/** Sets still to do — a run never re-runs something already logged. */
export function pendingIndices(sets: LoggedSet[], indices: number[]): number[] {
  return indices.filter((i) => sets[i] && !sets[i].completed);
}

/**
 * Can this list of sets be run hands-free?
 *
 * Every pending set has to be timed, and there has to be at least one. The
 * "every" is the load-bearing half: see the note at the top about why a run that
 * quietly skips the untimed sets is worse than no run at all.
 */
export function canRun(sets: LoggedSet[], indices: number[], ctx: RunContext): boolean {
  const pending = pendingIndices(sets, indices);
  if (pending.length === 0) return false;
  return pending.every((i) => ctx.workSeconds(sets[i], sets[i].exercise_id) != null);
}

/**
 * The steps for one exercise's remaining sets.
 *
 * `lead` is the count-in — three seconds before every work interval, not just
 * the first. It is the last thing you hear before you have to move, and the
 * second set of burpees needs it exactly as much as the first: rest ends, you
 * get three counted seconds, you go.
 *
 * **No rest after the final set**, because the run is over and a trailing rest
 * countdown is the app holding the screen hostage after the work is done. The
 * athlete rests as long as they like; the app stops talking.
 */
export function buildExerciseRun(
  sets: LoggedSet[],
  indices: number[],
  ctx: RunContext,
  opts: { lead?: boolean } = {},
): RunStep[] {
  const lead = opts.lead ?? true;
  const pending = pendingIndices(sets, indices);
  const total = pending.length;
  const steps: RunStep[] = [];

  pending.forEach((i, n) => {
    const set = sets[i];
    const exerciseID = set.exercise_id;
    const seconds = ctx.workSeconds(set, exerciseID);
    if (seconds == null) return;
    const common = {
      label: ctx.name(exerciseID),
      exerciseID,
      step: ctx.step(exerciseID),
      ordinal: n + 1,
      total,
    };
    if (lead) steps.push({ ...common, kind: 'ready', seconds: READY_SECONDS });
    steps.push({ ...common, kind: 'work', seconds, setIndex: i });
    if (n < total - 1) {
      steps.push({ ...common, kind: 'rest', seconds: ctx.restSeconds(exerciseID) });
    }
  });

  return steps;
}

/**
 * The steps for a whole session, exercise by exercise, in the order on screen.
 *
 * `groups` is the adjacency-based grouping the screen already computed, passed
 * in rather than derived, for the reason `reorderGroups` documents: two
 * different answers to "which rows are this exercise" is how a run writes to a
 * row nobody was looking at.
 *
 * The rest between exercises is the rest of the exercise you just finished, not
 * the one you are about to start — you are recovering from what you did.
 */
export function buildSessionRun(
  sets: LoggedSet[],
  groups: { exerciseID: string; indices: number[] }[],
  ctx: RunContext,
): RunStep[] {
  const perGroup = groups.map((g) => buildExerciseRun(sets, g.indices, ctx));
  const live = perGroup.filter((s) => s.length > 0);

  const out: RunStep[] = [];
  live.forEach((steps, gi) => {
    out.push(...steps);
    // Between exercises, a rest — the one `buildExerciseRun` deliberately omits
    // after its own last set, added back here because there IS more to come.
    if (gi < live.length - 1) {
      const last = steps[steps.length - 1];
      out.push({
        kind: 'rest',
        seconds: ctx.restSeconds(last.exerciseID),
        label: ctx.name(last.exerciseID),
        exerciseID: last.exerciseID,
        step: ctx.step(last.exerciseID),
        ordinal: last.ordinal,
        total: last.total,
      });
    }
  });

  // Renumbered across the whole run: "set 2 of 4" is per exercise and right,
  // but the countdown surface also shows how far through the SESSION you are,
  // and per-group ordinals restarting at 1 four times would make that unreadable.
  const works = out.filter((s) => s.kind === 'work').length;
  let n = 0;
  return out.map((s) => {
    if (s.kind === 'work') n++;
    return { ...s, ordinal: Math.max(1, n), total: works };
  });
}

/** How long the whole run takes, for the label on the button that starts it. */
export function runSeconds(steps: RunStep[]): number {
  return steps.reduce((sum, s) => sum + s.seconds, 0);
}

/**
 * The countdown to hand the timer for a step.
 *
 * A `Countdown` and a `RunStep` are deliberately different types: a step is a
 * plan, immutable and known in advance, while a countdown is a live deadline
 * that gets paused and adjusted. Converting at the boundary keeps an adjusted
 * countdown from writing back into the plan and silently changing a later set's
 * prescription.
 */
export function countdownFor(step: RunStep): Omit<Countdown, 'endsAt' | 'pausedWith'> {
  return {
    kind: step.kind,
    total: step.seconds,
    label: step.label,
    exerciseID: step.exerciseID,
    setIndex: step.setIndex,
    step: step.step,
  };
}

/**
 * The step after this one, or null when the run is over.
 *
 * A function rather than `at + 1` inline because "the run is over" is a
 * decision with consequences — the session chimes, the voice says so, the
 * surface closes — and it should be answered in one place that a test can hold
 * still.
 */
export function nextStep(run: Run): RunStep | null {
  return run.steps[run.at + 1] ?? null;
}

export function advanced(run: Run): Run | null {
  return run.at + 1 < run.steps.length ? { ...run, at: run.at + 1 } : null;
}

/**
 * How far through the run, as a fraction — for the progress ring behind the
 * per-interval one.
 *
 * Measured in TIME rather than in steps, because the steps are wildly unequal:
 * a three-second count-in and a five-minute round are one step each, and a
 * step-counted bar would jump a third of the way along for three seconds of
 * standing still.
 */
export function runProgress(run: Run, remaining: number): number {
  const total = runSeconds(run.steps);
  if (total <= 0) return 0;
  const before = runSeconds(run.steps.slice(0, run.at));
  const inStep = Math.max(0, run.steps[run.at].seconds - remaining);
  return Math.max(0, Math.min(1, (before + inStep) / total));
}
