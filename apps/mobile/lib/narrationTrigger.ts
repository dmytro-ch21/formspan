/**
 * When the day's narration may regenerate (N570, #1131). **Pure: no clock, no
 * storage, no network.** The caller passes the times; this decides.
 *
 * ## The owner's decision, 2026-09-11, in their words
 *
 * > *"when something changes, when a meal was entered fully when a workout has
 * > been done but wait after input at least 10-15 mins and then regenerate i
 * > guess. that will go down to 4-5 gens per day."*
 *
 * Read as three rules, each a named constant below:
 *
 * - **Event-driven.** A regeneration is only ever caused by a
 *   {@link NarrationEvent}. Opening the app is not one.
 * - **Debounced from the LAST input.** A burst of logging (breakfast, then a
 *   correction, then a coffee) waits {@link NARRATION_DEBOUNCE_MS} after the
 *   final entry, so it produces one generation, never three.
 * - **Capped per rolling day.** {@link DAILY_NARRATIONS} in any
 *   {@link NARRATION_WINDOW_MS}, enforced here and again on the server, which
 *   owns the real cap because it owns the spend.
 *
 * ## What counts as an event
 *
 * - `meal-logged`: a successful `logFood` (`lib/foodLog.ts`). The add,
 *   describe and scan screens call it only on save, so a half-typed meal never
 *   reaches the table, and "entered fully" needs no filter of its own.
 * - `meal-changed` / `meal-removed`: `editEntry` / `removeEntry`. The owner
 *   named meals and workouts. An edit or a removal changes the facts narration
 *   rests on, and narration still describing a deleted meal would be a
 *   fabricated fact by the guard's own definition.
 * - `workout-finished`: `finishLocalSession` (`lib/sessionStore.ts`). A
 *   HealthKit import arrives already ended, never passes through it, and does
 *   not trigger on its own. Its facts are picked up by the next event, so a
 *   background sync cannot spend a generation nobody asked for.
 *
 * ## Why a rolling window, not a calendar day
 *
 * For the reason `backend/internal/modules/bjj/reflect_quota.go` gives for its
 * own cap. A calendar day needs a timezone, and it can be gamed at midnight:
 * five generations at 23:59 and five more at 00:01.
 */

export type NarrationEvent = {
  kind: 'meal-logged' | 'meal-changed' | 'meal-removed' | 'workout-finished';
  /** Epoch milliseconds. */
  at: number;
};

/**
 * Twelve minutes. Inside the owner's "at least 10–15 mins", and not at either
 * edge: at 10 a slow second entry (the drink after the plate) still lands after
 * a generation, and at 15 the athlete who logs one meal and looks back waits
 * longest for nothing.
 */
export const NARRATION_DEBOUNCE_MS = 12 * 60 * 1000;

/** The owner's "4-5 gens per day", taken at its top. */
export const DAILY_NARRATIONS = 5;

/** How far back the ceiling counts. Rolling; see the module doc. */
export const NARRATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type NarrationSchedule =
  /** Nothing has happened since the last generation. */
  | { kind: 'idle' }
  /** Input is still settling. `dueAt` moves if another event lands first. */
  | { kind: 'waiting'; dueAt: number }
  /** Quiet for the whole debounce, under the ceiling. Generate now. */
  | { kind: 'due' }
  /**
   * It would be due, but the window already holds the day's ceiling.
   * `resetsAt` is when the oldest generation ages out.
   */
  | { kind: 'capped'; resetsAt: number };

/** Largest value, or -Infinity for none. A loop, not `Math.max(...xs)`, which overflows the stack on a long list. */
function maxOf(values: readonly number[]): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  return max;
}

/** Smallest value, or Infinity for none. See {@link maxOf}. */
function minOf(values: readonly number[]): number {
  let min = Infinity;
  for (const v of values) if (v < min) min = v;
  return min;
}

/**
 * **`events`, `generations` and `now` must all come from ONE clock**, the
 * phone's. This function cannot detect a skew between them: a server-stamped
 * generation time checked against phone-stamped events would move the debounce
 * and the ceiling silently.
 *
 * **A generation covers every event stamped at or before it**, including one in
 * the same millisecond. That holds if the caller stamps a generation after
 * reading the facts it narrated, which makes an event in that millisecond
 * already reflected in them.
 */
export function narrationSchedule(input: {
  events: readonly NarrationEvent[];
  /** When earlier generations happened, epoch ms, in any order. */
  generations: readonly number[];
  now: number;
}): NarrationSchedule {
  const { events, generations, now } = input;
  const lastGeneration = maxOf(generations);
  // An event stamped after `now` is a clock disagreement, not input. Counting
  // it would hold the debounce open until the future.
  const pending = events.filter((e) => e.at > lastGeneration && e.at <= now);
  if (pending.length === 0) return { kind: 'idle' };

  const dueAt = maxOf(pending.map((e) => e.at)) + NARRATION_DEBOUNCE_MS;
  if (now < dueAt) return { kind: 'waiting', dueAt };

  const inWindow = generations.filter((g) => g > now - NARRATION_WINDOW_MS && g <= now);
  if (inWindow.length >= DAILY_NARRATIONS) {
    return { kind: 'capped', resetsAt: minOf(inWindow) + NARRATION_WINDOW_MS };
  }
  return { kind: 'due' };
}
