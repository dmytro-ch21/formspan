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
 * ## Rest, work and get-ready are ONE countdown, not three
 *
 * `kind` discriminates them. That is deliberate and load-bearing: you cannot
 * be resting and holding a plank at the same time, there is one timer surface
 * on the session screen to show a countdown in, and independent timers would
 * all be entitled to it. One state means starting any of them ends the others,
 * which is what actually happens in a gym.
 */

export type CountdownKind = 'rest' | 'work' | 'ready';

export type Countdown = {
  /** Resting between sets, performing a timed set, or about to start one. */
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
  /**
   * The unit this countdown's ± buttons work in — see `lib/duration.ts`.
   *
   * On the countdown rather than looked up by the bar, because the bar is handed
   * a `Countdown` and nothing else: a ±15 on a five-minute round is a rounding
   * error, and the button has to say the number it will actually move.
   */
  step?: number;
};

/**
 * The lead-in before a timed set actually starts.
 *
 * Three seconds, and it is not decoration: the countdown a phone starts is
 * useless if the athlete is still putting the phone down when it begins. Every
 * gym clock, every interval app and every referee counts you in, and without it
 * the first seconds of every timed set are spent getting into position — which
 * then get logged as work that happened.
 *
 * Same three as {@link TICK_FROM_SECONDS} on purpose: the lead-in is *entirely*
 * ticks, so "3, 2, 1, go" is one continuous sound rather than a silent pause
 * followed by a chime.
 */
export const READY_SECONDS = 3;

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

/**
 * Is this countdown one the athlete may lengthen, shorten or pause?
 *
 * `ready` is not. It is a three-second count-in whose entire job is to be over —
 * a pause button on it would be a control that exists for less time than it
 * takes to find, and ±15 seconds on a 3-second lead-in is nonsense. Rendering
 * the buttons and having them do nothing would be worse than not rendering
 * them, so the timer surface asks this rather than each control guessing.
 */
export function isAdjustable(kind: CountdownKind): boolean {
  return kind !== 'ready';
}

/** How much ± moves this countdown; 15s unless it was started in minutes. */
export function stepOf(c: Pick<Countdown, 'step'>): number {
  return c.step && c.step > 0 ? c.step : 15;
}

/**
 * How many seconds before the end the per-second ticks start.
 *
 * Three, because it is the length of a countdown people already have in their
 * heads. Two is not enough to prepare for; five is long enough to become
 * nagging on a 60-second plank you hear it on every set of.
 */
export const TICK_FROM_SECONDS = 3;

/**
 * Which chime marks the end of this countdown.
 *
 * The two must be audibly different, and that is the reason this exists rather
 * than one "done" sound. Rest ending and a set ending mean opposite things —
 * one says start moving, the other says stop — and you hear them with the
 * phone on a bench, not in your hand. Getting them the same way round as the
 * screen is not optional, so it is a named function with a test rather than a
 * ternary somewhere in an interval callback.
 */
export function completionSoundFor(kind: CountdownKind): 'restComplete' | 'workComplete' | 'go' {
  if (kind === 'work') return 'workComplete';
  // The count-in ends by handing over to the work interval, so it gets the
  // rising "start" note rather than either of the two chimes that mean an
  // interval ENDED. Sharing `restComplete` would have been free and wrong: rest
  // ending and a count-in ending are both "go", but one of them is followed by
  // silence and the other by a set you are already three seconds into.
  if (kind === 'ready') return 'go';
  return 'restComplete';
}

/**
 * When each of the last seconds should be announced, as absolute epoch ms.
 *
 * **This exists because the ticks used to be polled, and polling is what made
 * them late.** The countdown reads its remaining time on a 250ms interval, and
 * the tick fired on whichever pass first saw a new whole second — so a beep
 * landed anywhere from 0 to 250ms after the second actually turned over, which
 * is exactly the "three seconds pass and *then* it beeps" the athlete hears.
 * Averaged 125ms late, and a late beep on a count-in is worse than no beep,
 * because you start moving on it.
 *
 * The deadline model already knows the answer exactly: the moment three seconds
 * remain is `endsAt - 3000`, and it has been known since the countdown started.
 * So the caller schedules one timer per tick against these times instead of
 * asking every 250ms whether it is time yet. The interval stays, for the digits
 * on screen, where being a quarter of a second stale is invisible.
 *
 * Returned in fire order and filtered to what is still ahead of `now`, so a
 * countdown adjusted at "2" re-derives its remaining ticks and never replays one
 * that has already sounded. A paused countdown has no schedule at all: there is
 * no deadline to hang the times off, which is the same reason `remainingAt`
 * short-circuits on `pausedWith`.
 */
export type ScheduledTick = { at: number; second: number };

export function tickSchedule(c: Countdown, now: number): ScheduledTick[] {
  if (c.pausedWith != null || c.endsAt == null) return [];
  const out: ScheduledTick[] = [];
  for (let second = Math.min(TICK_FROM_SECONDS, Math.ceil(c.total)); second >= 1; second--) {
    const at = c.endsAt - second * 1000;
    // `>= now` and not `> now`: a three-second count-in's first tick is due the
    // instant it starts, and dropping it would count the athlete in "2, 1, go".
    if (at >= now) out.push({ at, second });
  }
  return out;
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
