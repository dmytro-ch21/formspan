/**
 * Reps or time, per set, for the movements that are honestly both.
 *
 * Burpees, mountain climbers, sit-ups, jumping lunges — the catalog marks them
 * `load_type: 'reps'` because that is the commonest way they are written down,
 * but "40 seconds of burpees" is not a different exercise, it is the same
 * exercise counted a different way. Until now the app had an opinion (reps,
 * always) and the athlete had none, which meant a conditioning circuit had to be
 * logged as a number of reps nobody counted.
 *
 * ## The rule, and why it is this one
 *
 * **Anything whose only measure is repetitions can be measured in time
 * instead.** That is `load_type: 'reps'` exactly — 132 of the catalog's 761
 * exercises, all of them bodyweight or implement-carrying work where the load is
 * fixed and the only variable is how much of it you do.
 *
 * The two boundaries are deliberate:
 *
 *  - **`weight_reps` is never dual.** A timed bench press is not a thing, and
 *    offering it would put a toggle on 483 exercises to serve none of them.
 *  - **`time` does not go the other way.** A plank measured in reps is a number
 *    nobody wants in their history. The switch is one-directional by design:
 *    reps → time is a real training choice, time → reps is a data-entry
 *    accident.
 *
 * ## The mode is DERIVED, not stored
 *
 * A set is in time mode when it carries a positive `seconds`, and in reps mode
 * otherwise. There is no new column, no migration and no second source of truth
 * — which matters because `LoggedSet` already round-trips both fields through
 * the API, so a mode flag would be a third thing that could disagree with the
 * two numbers it describes.
 *
 * The invariant that keeps the derivation honest is that a dual-mode set holds
 * one measure or the other, never both: {@link withSetMode} clears the one it is
 * leaving. Everything that writes to these sets — `applySuggestions`,
 * `fillForward`, `emptySet` — has to respect that, and the tests pin it.
 *
 * ## The choice is per EXERCISE, not per set
 *
 * {@link withGroupMode} is the entry point the UI uses, and the chip that calls
 * it sits on the exercise header beside the kg/lb one. Nobody does set 1 of
 * burpees in reps and set 2 in seconds; offering that would be a per-row toggle
 * whose only real use is creating a group whose sets cannot be compared to each
 * other. Deriving the group's mode from its first set then always agrees with
 * what is on screen.
 */

import type { Exercise } from './exercises';
import type { LoggedSet, Measure } from './sessions';

export type SetMode = 'reps' | 'time';

/** How long a rep-counted exercise switched to time starts at. */
export const DEFAULT_MODE_SECONDS = 40;

/**
 * Can this exercise be logged either way?
 *
 * A named function rather than an inline `=== 'reps'` because it is read from
 * four places — the set row's toggle, the measure list, the work-timer lookup
 * and the template editor — and those four disagreeing is precisely the failure
 * where a toggle appears on a row whose timer button never will.
 */
export function isDualMode(loadType: Exercise['load_type'] | undefined): boolean {
  return loadType === 'reps';
}

/**
 * Which way this set is being counted.
 *
 * `time` load types are always time and everything else is always reps; only a
 * dual-mode set actually reads its own numbers to answer. The `> 0` is the same
 * guard `workSecondsFor` uses: a stored 0 is not a duration, and treating it as
 * one would put a row into time mode with nothing to count.
 */
export function setModeOf(
  set: Pick<LoggedSet, 'seconds'>,
  loadType: Exercise['load_type'] | undefined,
): SetMode {
  if (loadType === 'time' || loadType === 'distance_time') return 'time';
  if (!isDualMode(loadType)) return 'reps';
  return set.seconds != null && set.seconds > 0 ? 'time' : 'reps';
}

/**
 * Move a set to the other mode, dropping the measure it is leaving.
 *
 * **Clearing is the point, not a side effect.** A set holding both 12 reps and
 * 40 seconds is a row that two different readers describe two different ways —
 * and one of them is the volume rollup. Leaving the old number behind would also
 * make the mode ambiguous the next time it is derived.
 *
 * Returns the set unchanged when it is already in that mode, so a caller can
 * skip a write, and when the exercise is not dual-mode at all — a toggle that
 * reached a barbell squat is a bug upstream, and silently blanking its reps
 * would be a data-losing one.
 */
export function withSetMode(
  set: LoggedSet,
  loadType: Exercise['load_type'] | undefined,
  mode: SetMode,
  /** What a fresh time-mode set starts at; the previous set's duration, usually. */
  seconds: number = DEFAULT_MODE_SECONDS,
): LoggedSet {
  if (!isDualMode(loadType)) return set;
  if (setModeOf(set, loadType) === mode) return set;
  return mode === 'time'
    ? { ...set, seconds: Math.max(1, Math.round(seconds)), reps: null }
    : { ...set, seconds: null };
}

/**
 * Move every set of one exercise to the other mode.
 *
 * `indices` is the group as the screen already computed it, passed in rather
 * than recomputed here for the same reason `reorderGroups` takes it: two
 * different answers to "which rows are this exercise" is how a mutator writes to
 * a row nobody was looking at.
 *
 * The duration seeded into a group entering time mode is the first duration the
 * group already carries, if any — a template that prescribed `3 × 40s` and was
 * then flipped to reps and back must come back as 40s, not as the generic
 * default. Completed sets are left alone: those are records of something that
 * happened, and rewriting a finished set's measure would erase it.
 *
 * Returns the same array identity when nothing changed, so the caller can skip
 * the write and the save it would trigger.
 */
export function withGroupMode(
  sets: LoggedSet[],
  indices: number[],
  loadType: Exercise['load_type'] | undefined,
  mode: SetMode,
): LoggedSet[] {
  if (!isDualMode(loadType)) return sets;
  const seeded = indices.map((i) => sets[i]?.seconds).find((s) => s != null && s > 0);
  const seconds = seeded ?? DEFAULT_MODE_SECONDS;

  let changed = false;
  const next = sets.map((s, i) => {
    if (!indices.includes(i) || s.completed) return s;
    const moved = withSetMode(s, loadType, mode, seconds);
    if (moved !== s) changed = true;
    return moved;
  });
  return changed ? next : sets;
}

/**
 * Which way a whole exercise is being counted — read off the first row.
 *
 * The first row rather than a vote, because that is the row the athlete flipped
 * and the one the group's chip is rendered from. A mixed group can only exist
 * where a completed set held the old mode, and in that case the pending work is
 * what the label is about.
 */
export function groupModeOf(
  sets: Pick<LoggedSet, 'seconds' | 'completed'>[],
  indices: number[],
  loadType: Exercise['load_type'] | undefined,
): SetMode {
  const pending = indices.find((i) => sets[i] && !sets[i].completed);
  const row = sets[pending ?? indices[0]];
  return row ? setModeOf(row, loadType) : 'reps';
}

/**
 * The measures this particular set records — the mode-aware `measuresFor`.
 *
 * Everything that edits, fills forward or summarises a set has to go through
 * here rather than through `measuresFor(load_type)`, or a dual-mode set in time
 * mode gets a reps field and no duration field: the editor would then be
 * offering the one number the row is not keeping.
 *
 * `measuresFor` is a parameter rather than an import, and that is not style: the
 * two modules would otherwise import each other at runtime, and a cycle through
 * `lib/sessions.ts` — which the session screen, the store and the sync path all
 * pull in — is the sort of thing that resolves to `undefined` at module-eval
 * time on one bundler and not the other. Same shape as `swapSuggestions` taking
 * `sharesMuscleGroup`.
 */
export function measuresForSet(
  set: Pick<LoggedSet, 'seconds'>,
  loadType: Exercise['load_type'] | undefined,
  measuresFor: (lt: Exercise['load_type']) => Measure[],
): Measure[] {
  if (loadType === undefined) return ['reps'];
  if (!isDualMode(loadType)) return measuresFor(loadType);
  return setModeOf(set, loadType) === 'time' ? ['seconds'] : ['reps'];
}
