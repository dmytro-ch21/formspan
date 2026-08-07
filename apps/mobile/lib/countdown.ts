/**
 * The arithmetic behind every countdown in the app, with no React in it.
 *
 * **Deadline-driven, never tick-driven**, and that is the whole design rather
 * than a detail. A timer that decrements a counter every second drifts, and it
 * stops entirely when iOS throttles the JS thread — which happens the moment
 * the phone goes in a pocket, i.e. during every real rest period and every
 * plank you are not looking at. So the only stored state is the epoch
 * millisecond the countdown *ends*, and reading it is a subtraction against
 * the current clock. Put the phone away for two minutes and the answer is
 * correct when you look again, because nothing was ever counting.
 *
 * Pure, and `now` is a parameter rather than a `Date.now()` call, because
 * that is the difference between this being covered and being hoped about:
 * the drift-free property is exactly what a test has to pin, and it cannot be
 * pinned by a function that reads the clock itself.
 *
 * ## Rest and work are ONE countdown, not two
 *
 * `kind` discriminates them. That is deliberate and load-bearing: you cannot
 * be resting and holding a plank at the same time, there is one bar at the
 * bottom of the session screen to show a countdown in, and two independent
 * timers would both be entitled to it. One state means starting either one
 * ends the other, which is what actually happens in a gym.
 */

export type CountdownKind = 'rest' | 'work';

export type Countdown = {
  /** Resting between sets, or performing a timed set. */
  kind: CountdownKind;
  /**
   * Epoch ms this ends at.
   *
   * Nullable in the type and never actually null in practice — pausing keeps
   * the stale deadline and lets `pausedWith` shadow it, because rebuilding a
   * deadline on resume is one subtraction and reconciling two clocks is not.
   */
  endsAt: number | null;
  /** Seconds left, frozen, while paused. */
  pausedWith: number | null;
  /** What it started at, for the progress bar and for what a full run logs. */
  total: number;
  /** What the bar says you are resting from, or performing. */
  label: string;
  /** Which exercise this belongs to, so an adjustment can be saved to it. */
  exerciseID?: string;
  /**
   * Which set row a `work` countdown is timing.
   *
   * Only meaningful for `kind: 'work'` — a rest belongs to an exercise, but a
   * timed set belongs to one specific row, and the elapsed seconds have to land
   * on that row and no other.
   */
  setIndex?: number;
};

/**
 * Does adjusting this countdown let it complete a second time?
 *
 * **Rest only, and the asymmetry is load-bearing.** A rest that has run out
 * and gets +15 should chime again when the new time is up: nothing was
 * recorded, so firing twice costs a haptic. A work countdown's completion
 * WRITES — it sets `seconds` on a row and ticks it. Re-arming that means a
 * finished countdown, sitting at "Set done" with its buttons still live, can
 * fire again and rewrite the set; and because `adjusted` grows `total`, a
 * single +15 tap turned a logged 60-second plank into 75 with no countdown
 * ever visibly running.
 *
 * A one-line function rather than a one-line condition because deleting the
 * condition is SILENT — it typechecks, every other test passes, and the only
 * symptom is a number quietly changing in somebody's training history. Same
 * reason `keyboardEventNames` is a function.
 */
export function rearmsCompletionOnAdjust(kind: CountdownKind): boolean {
  return kind === 'rest';
}

/** Seconds left. Zero once it has run out, never negative. */
export function remainingAt(c: Countdown | null, now: number): number {
  if (!c) return 0;
  if (c.pausedWith != null) return c.pausedWith;
  if (c.endsAt == null) return 0;
  return Math.max(0, (c.endsAt - now) / 1000);
}

/**
 * Seconds actually performed — what an interrupted timed set should log.
 *
 * **The honest number, not the prescribed one.** A plank held for 40 of a
 * planned 60 seconds is a 40-second plank, and writing 60 because that is what
 * the template said would put a number in the log that never happened. Clamped
 * to `total` so a countdown left sitting at zero cannot report more than it
 * ever counted.
 */
export function elapsedOf(c: Countdown, remaining: number): number {
  return Math.round(Math.max(0, Math.min(c.total, c.total - remaining)));
}

/**
 * Moves the finish line, running or paused.
 *
 * `total` grows with the adjustment so the progress bar cannot overflow its
 * track — the bar reads `remaining / total`, and adding 15s to a countdown
 * without adding it here gives a fill wider than 100%.
 *
 * **The deadline is taken from `now` once it is in the past**, which is what
 * makes +15 on an expired countdown mean "give me fifteen more seconds"
 * rather than "move a stale deadline fifteen seconds less stale" — the latter
 * leaves it still expired and the adjustment does visibly nothing.
 *
 * Note what shortening means, because it is a choice rather than a
 * measurement: −15 with ten seconds left ends the countdown now, and the set
 * logs the reduced `total`. The athlete held slightly longer than that. The
 * reading taken here is that pressing −15 REDEFINES the set as a shorter one,
 * not that it reports a stopwatch — if you want the stopwatch answer, Stop
 * logs true elapsed time via {@link elapsedOf}.
 */
export function adjusted(c: Countdown, delta: number, now: number): Countdown {
  if (c.pausedWith != null) {
    return {
      ...c,
      pausedWith: Math.max(0, c.pausedWith + delta),
      total: Math.max(1, c.total + delta),
    };
  }
  return {
    ...c,
    endsAt: Math.max(c.endsAt ?? now, now) + delta * 1000,
    total: Math.max(1, c.total + delta),
  };
}

/**
 * Pause freezes the seconds left; resume turns them back into a deadline.
 *
 * Storing the remainder rather than a pause timestamp is what keeps the
 * deadline model intact — there is never a second clock to reconcile.
 */
export function toggledPause(c: Countdown, now: number): Countdown {
  if (c.pausedWith != null) {
    return { ...c, endsAt: now + c.pausedWith * 1000, pausedWith: null };
  }
  return { ...c, pausedWith: Math.max(0, ((c.endsAt ?? now) - now) / 1000) };
}

/** `m:ss`. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
