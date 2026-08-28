/**
 * Walking a class plan on the mat, without touching the phone between blocks.
 *
 * **Structurally this mirrors `intervalRun.ts`**: the whole run is already
 * known the moment a plan is fetched — warmup, then technique drilling, then
 * live rounds, then notes — so it is built once as a plain array and walked
 * one block at a time by index, rather than decided block-by-block inside a
 * timer callback several minutes after the coach last looked at the screen.
 * That is what makes "4 blocks · 45 min" renderable before the run starts,
 * and what keeps a background/foreground cycle from losing the athlete's
 * place: `at` is a position, not something that was counting.
 *
 * **Deliberately NOT `intervalRun.ts`'s types.** `RunStep`/`Run`/
 * `CountdownKind` carry a gym's own meaning — `exerciseID` is mandatory,
 * `setIndex` writes to a logged set row, and the three kinds ('rest'/'work'/
 * 'ready') exist because "you cannot be resting and holding a plank at the
 * same time" is true of a workout and not of a class plan. A class-plan
 * block has four kinds with nothing in common with those three
 * (`classplan.go`'s own package doc makes exactly this point about why the
 * domain shares no code with `sequence` or `curriculum`), and there is no
 * set to write back to, ever — reaching for `RunStep` here would be the
 * anti-pattern that doc warns against, with a fifth `exerciseID: string`
 * nobody has a value for.
 *
 * **No pause, no adjust, no skip-with-write-back.** A class-plan block times
 * out and the run advances; there is nothing to log, so there is nothing
 * `intervalRun.ts`'s adjust/skip machinery exists to protect. What survives
 * the trip from that module is only the shape: a plan, walked by index, with
 * a deadline (not a decrementing counter) per step. See `lib/countdown.ts`'s
 * header for the fuller argument on why a countdown must be deadline-driven
 * — iOS throttles JS the moment the app is backgrounded, so a counter that
 * decrements every second simply stops, while a stored end-time is still
 * correct whenever the screen is looked at again.
 */

import type { ClassPlanBlock } from './classplans';

/** A run in progress: the ordered blocks, and where in them we are. */
export type RunState = {
  blocks: ClassPlanBlock[];
  at: number;
};

/** How this run starts — position zero, whatever that block is (or none, for
 *  an empty plan; every other function here already handles that safely). */
export function startRun(blocks: ClassPlanBlock[]): RunState {
  return { blocks, at: 0 };
}

/** One block's duration in seconds. Never negative, even against a
 *  malformed `duration_minutes` — a timer counting backwards is worse than
 *  one stuck at zero. */
export function blockSeconds(block: Pick<ClassPlanBlock, 'duration_minutes'>): number {
  return Math.max(0, block.duration_minutes) * 60;
}

/**
 * The deadline for timing one block, computed from `now` rather than stored
 * anywhere — the same reason `lib/countdown.ts` takes `now` as a parameter
 * on every pure function instead of calling `Date.now()` itself. It is what
 * lets a test pin the drift-free property, and it is what the React layer
 * (`ClassPlanTimer`) calls once, on mount and on every manual advance/back,
 * to arm a fresh deadline for whichever block is now current.
 */
export type BlockDeadline = {
  /** Epoch ms this block's timer ends at. */
  endsAt: number;
  /** What it started at, in seconds — for a progress readout. */
  total: number;
};

export function deadlineFor(
  block: Pick<ClassPlanBlock, 'duration_minutes'>,
  now: number,
): BlockDeadline {
  const total = blockSeconds(block);
  return { endsAt: now + total * 1000, total };
}

/** Seconds left on a deadline. Zero once it has run out, never negative —
 *  same clamp as `lib/countdown.ts`'s `remainingAt`, for the same reason: a
 *  countdown showing a negative number is a bug the athlete would notice
 *  before anyone else did. */
export function remainingAt(deadline: BlockDeadline | null, now: number): number {
  if (!deadline) return 0;
  return Math.max(0, (deadline.endsAt - now) / 1000);
}

/** The block currently being run, or null for an empty plan. */
export function currentBlock(state: RunState): ClassPlanBlock | null {
  return state.blocks[state.at] ?? null;
}

/** The block after this one, or null when this is the last — what "Next up"
 *  renders. Deliberately does not say what happens when it is null; the
 *  screen decides that (usually "Last block"). */
export function upcomingBlock(state: RunState): ClassPlanBlock | null {
  return state.blocks[state.at + 1] ?? null;
}

/** Is there a block after this one to advance into? */
export function canAdvance(state: RunState): boolean {
  return state.at < state.blocks.length - 1;
}

/** Is there a block before this one to go back to? */
export function canGoBack(state: RunState): boolean {
  return state.at > 0;
}

/**
 * Moves to the next block, or signals the run is complete.
 *
 * `null` means "advancing past the last block" — the same reading
 * `intervalRun.ts`'s `advanced` gives a finished run, and for the same
 * reason: "the run is over" is a decision with a consequence (the screen
 * shows a clear end state rather than a crash or a blank one), and it should
 * be answered in one place a test can hold still rather than as an `at + 1`
 * inline in the timer's completion handler.
 */
export function advanced(state: RunState): RunState | null {
  return state.at + 1 < state.blocks.length ? { ...state, at: state.at + 1 } : null;
}

/**
 * Moves back one block. A NO-OP at the first block, never a crash and never
 * a negative index — the ticket calls this out explicitly ("going back from
 * the first block should be a no-op not a crash"), and returning the same
 * state unchanged is what lets the screen wire the back button to this
 * unconditionally rather than gating every tap on `canGoBack` first.
 */
export function wentBack(state: RunState): RunState {
  return state.at > 0 ? { ...state, at: state.at - 1 } : state;
}
