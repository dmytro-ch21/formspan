/**
 * N495/#865 (phase 3 of #753) — the mobile-side half of the warm-up engine.
 *
 * The RAMP itself (`Suggestion.warmup`, `WarmupStep`, both in
 * `lib/sessions.ts`) is generated server-side, by
 * `backend/internal/modules/session/warmup.go`'s `GenerateWarmupRamp` — this
 * file does not reimplement that arithmetic, for the same reason
 * `ResolveProtocol` (N494/#864) is never reimplemented on a client: the
 * prescription has exactly one source of truth, and mobile just displays it.
 *
 * `detectWarmupFatigue` below IS reimplemented here, deliberately, and it is
 * the one exception to that rule in this ticket. The three triggers must run
 * the INSTANT the athlete ticks a warm-up set done — mid-workout, standing at
 * the rack, one-handed (CLAUDE.md's logging-speed floor) — using a target
 * that is already sitting in this screen's own `suggestions` state from the
 * fetch that ran before the set was ever logged. A round trip to ask the
 * server "was that warm-up too heavy" would cost exactly the latency this
 * codebase's "advice, not content" posture (see `refreshSuggestions`'s own
 * doc comment in `app/session/[id].tsx`) already refuses to make logging
 * wait on. So this mirrors `DetectWarmupFatigue` in Go byte-for-threshold —
 * see that file's own doc comment for the reasoning behind each number —
 * and `lib/__tests__/warmup.test.ts` pins the same scenarios both languages
 * are tested against, including #753's own OHP report.
 *
 * ADVISORY, STRUCTURALLY. `detectWarmupFatigue` returns data, nothing more —
 * no set, no session, no `Volume` is touched here. `reclassifyWarmupAsWork`
 * is a SEPARATE, explicit function a caller invokes only when the athlete
 * taps "Count as work" — never automatically, and never as a side effect of
 * detection running. See `app/session/[id].tsx`'s own wiring for how the
 * two are kept apart: a flag is set from `detectWarmupFatigue`'s result and
 * rendered as a small, dismissible, non-blocking banner; reclassification
 * happens only on an explicit tap.
 */

export type WarmupFatigueReason =
  | 'high_effort'
  | 'near_working_load_high_reps'
  | 'moderate_load_double_reps';

/**
 * The ONE question #753 specifies, verbatim, for every trigger alike — never
 * composed per-reason, so a warm-up set that trips two triggers still asks
 * the athlete exactly one thing. Mirrors `WarmupFatiguePrompt`
 * (`backend/internal/modules/session/warmup.go`) exactly.
 */
export const WARMUP_FATIGUE_PROMPT = 'This warm-up may be training work. Count it as work?';

// Mirrors warmup.go's own thresholds — see that file's doc comments for why
// each number is what it is. Keep the two in sync; `warmup.test.ts` and
// `warmup_test.go` share the same scenario numbers precisely so a drift
// between them shows up as one side's test failing, not as silence.
const HIGH_RPE_THRESHOLD = 7;
const LOW_RIR_THRESHOLD = 2;
const NEAR_WORKING_LOAD_FRACTION = 0.8;
const MODERATE_LOAD_MIN_FRACTION = 0.4;
const MODERATE_LOAD_MAX_FRACTION = 0.8;
const DOUBLE_REPS_FACTOR = 2;

export interface WarmupSetEvidence {
  weightKg: number;
  reps: number;
  rir?: number | null;
  rpe?: number | null;
}

export interface WorkingTarget {
  weightKg: number;
  reps: number;
}

/**
 * Implements #753's three documented advisory triggers for one completed
 * warm-up set, evaluated against the working-set prescription it was
 * ramping toward. Pure: reads its arguments, returns a list, touches
 * nothing else. An empty array is the common case — most warm-ups trip
 * nothing — and should read as "nothing to ask," not as a failure.
 */
export function detectWarmupFatigue(
  warmup: WarmupSetEvidence,
  target: WorkingTarget,
): WarmupFatigueReason[] {
  const reasons: WarmupFatigueReason[] = [];

  const highEffort =
    (warmup.rpe != null && warmup.rpe >= HIGH_RPE_THRESHOLD) ||
    (warmup.rir != null && warmup.rir <= LOW_RIR_THRESHOLD);
  if (highEffort) reasons.push('high_effort');

  if (target.weightKg > 0 && target.reps > 0 && warmup.weightKg > 0) {
    const pct = warmup.weightKg / target.weightKg;
    if (pct >= NEAR_WORKING_LOAD_FRACTION && warmup.reps >= target.reps) {
      reasons.push('near_working_load_high_reps');
    } else if (
      pct >= MODERATE_LOAD_MIN_FRACTION &&
      pct < MODERATE_LOAD_MAX_FRACTION &&
      warmup.reps >= DOUBLE_REPS_FACTOR * target.reps
    ) {
      reasons.push('moderate_load_double_reps');
    }
  }

  return reasons;
}

/**
 * The ONLY way a warm-up set moves into working volume — the athlete
 * explicitly confirming the prompt `detectWarmupFatigue` triggered.
 *
 * This is not a computation the warm-up engine performs on its own; it is
 * the identical correction an athlete makes to any other set's `set_type`
 * (the picker at the bottom of every set row already offers exactly this
 * value), applied programmatically to the one flagged index. There is
 * deliberately no version of this that runs without an explicit call —
 * see this file's own header comment.
 */
export function reclassifyWarmupAsWork<T extends { set_type: string }>(
  sets: readonly T[],
  index: number,
): T[] {
  return sets.map((s, i) => (i === index ? { ...s, set_type: 'working' } : s));
}
