import {
  adjusted,
  completionSoundFor,
  elapsedOf,
  formatCountdown,
  rearmsCompletionOnAdjust,
  remainingAt,
  TICK_FROM_SECONDS,
  toggledPause,
  type Countdown,
} from '../countdown';
import { DEFAULT_WORK_SECONDS, timedSetStillAt, workSecondsFor } from '../sessions';

/**
 * The countdown arithmetic, which had no coverage at all until the rest timer
 * grew a second use.
 *
 * `now` is a parameter of every function here rather than a `Date.now()` call
 * inside them, and that is what makes the load-bearing property testable at
 * all: the timer must be correct after the phone has been in a pocket, which
 * is a statement about a clock that jumped, and a function that reads the
 * clock itself cannot be asked about it.
 */

const T0 = 1_700_000_000_000;

const rest = (over: Partial<Countdown> = {}): Countdown => ({
  kind: 'rest',
  endsAt: T0 + 90_000,
  pausedWith: null,
  total: 90,
  label: 'Back Squat',
  ...over,
});

describe('reading a countdown off the clock', () => {
  it('is right after the JS thread was frozen for two minutes', () => {
    // THE property. A decrementing counter stops when iOS throttles the
    // thread, so it would read ~90 here having ticked nothing — a rest timer
    // that says a minute and a half is left when the rest is long over. The
    // deadline model just subtracts.
    expect(remainingAt(rest(), T0 + 120_000)).toBe(0);
  });

  it('counts down as the clock advances, without being told', () => {
    expect(remainingAt(rest(), T0)).toBe(90);
    expect(remainingAt(rest(), T0 + 30_000)).toBe(60);
  });

  it('never goes negative', () => {
    // The bar divides by `total` for its fill width; a negative remainder
    // would render a fill running the wrong way out of its track.
    expect(remainingAt(rest(), T0 + 999_000)).toBe(0);
  });

  it('ignores the clock entirely while paused', () => {
    // A paused countdown holds seconds, not a deadline — so time passing must
    // not consume it. Reading `endsAt` here would drain a timer somebody
    // deliberately stopped.
    const paused = rest({ pausedWith: 42 });
    expect(remainingAt(paused, T0 + 600_000)).toBe(42);
  });

  it('reads a missing countdown as zero rather than throwing', () => {
    expect(remainingAt(null, T0)).toBe(0);
  });
});

describe('what an interrupted timed set logs', () => {
  const work = rest({ kind: 'work', total: 60 });

  it('logs what was actually held, not what was asked for', () => {
    // The case that matters: a 60s plank let go at 40. Logging 60 because the
    // template said 60 would put a number in the history that never happened.
    expect(elapsedOf(work, 20)).toBe(40);
  });

  it('logs the full duration when it ran out', () => {
    expect(elapsedOf(work, 0)).toBe(60);
  });

  it('never reports more than the countdown ever counted', () => {
    // A bar left sitting at zero keeps ticking `remaining` at 0; without the
    // clamp a negative remainder would inflate the logged seconds past total.
    expect(elapsedOf(work, -30)).toBe(60);
  });

  it('reports nothing for a countdown stopped the instant it started', () => {
    expect(elapsedOf(work, 60)).toBe(0);
  });
});

describe('moving the finish line', () => {
  it('pushes the deadline out by the delta', () => {
    const next = adjusted(rest(), 15, T0);
    expect(remainingAt(next, T0)).toBe(105);
  });

  it('grows total with it, so the progress bar cannot overflow', () => {
    // The bar renders `remaining / total`. Adding 15s to the deadline without
    // adding it here gives a fill wider than its track.
    expect(adjusted(rest(), 15, T0).total).toBe(105);
  });

  it('adjusts the frozen seconds while paused, not the deadline', () => {
    const next = adjusted(rest({ pausedWith: 30 }), -15, T0);
    expect(next.pausedWith).toBe(15);
    expect(remainingAt(next, T0 + 600_000)).toBe(15);
  });

  it('cannot be driven below a total of 1', () => {
    // Total is a divisor. Zero or negative makes the fill NaN or inverted.
    expect(adjusted(rest({ total: 10 }), -60, T0).total).toBe(1);
  });

  it('cannot leave a negative remainder when paused', () => {
    expect(adjusted(rest({ pausedWith: 5 }), -60, T0).pausedWith).toBe(0);
  });

  it('gives a genuine 15 seconds when the countdown has already expired', () => {
    // Review found this: adding to a deadline already in the past just makes
    // it less stale, so the countdown stays at 0:00 and +15 visibly does
    // nothing. Worse, on a WORK countdown it re-armed completion against a
    // grown `total` — one tap rewrote a logged 60-second plank as 75.
    const expired = rest({ endsAt: T0 - 60_000, total: 90 });
    expect(remainingAt(adjusted(expired, 15, T0), T0)).toBe(15);
  });

  it('shortening past the end stops at now rather than going backwards', () => {
    const nearlyDone = rest({ endsAt: T0 + 5_000 });
    expect(remainingAt(adjusted(nearlyDone, -15, T0), T0)).toBe(0);
  });
});

describe('pausing and resuming', () => {
  it('freezes the seconds that were left', () => {
    const paused = toggledPause(rest(), T0 + 30_000);
    expect(paused.pausedWith).toBe(60);
    expect(paused.endsAt).not.toBeNull();
  });

  it('round-trips: what was left before is what is left after', () => {
    // Resuming rebuilds a deadline from the frozen remainder. Getting this
    // wrong loses or gains time on every pause, silently.
    const paused = toggledPause(rest(), T0 + 30_000);
    const resumed = toggledPause(paused, T0 + 500_000);
    expect(remainingAt(resumed, T0 + 500_000)).toBe(60);
  });

  it('clears pausedWith on resume, so the clock is read again', () => {
    const resumed = toggledPause(rest({ pausedWith: 20 }), T0);
    expect(resumed.pausedWith).toBeNull();
    expect(remainingAt(resumed, T0 + 5_000)).toBe(15);
  });
});

describe('who is allowed to complete twice', () => {
  it('lets a rest chime again after it is extended', () => {
    // Nothing was recorded, so a second fire costs a haptic.
    expect(rearmsCompletionOnAdjust('rest')).toBe(true);
  });

  it('REFUSES to let a work countdown complete twice', () => {
    // Found in review. A work completion writes: it sets `seconds` and ticks
    // the row. Re-arming it let a finished countdown — still sitting at "Set
    // done" with live ±15 buttons — fire again against a grown `total`, so one
    // tap rewrote a logged 60-second plank as 75, with no countdown visibly
    // running and nothing on screen to suggest the number had changed.
    expect(rearmsCompletionOnAdjust('work')).toBe(false);
  });
});

describe('the row a countdown is writing to', () => {
  const sets = [
    { exercise_id: 'plank' },
    { exercise_id: 'back-squat' },
    { exercise_id: 'plank' },
  ];

  it('accepts the row that is still where the timer left it', () => {
    expect(timedSetStillAt(sets, 0, 'plank')).toBe(true);
  });

  it('REFUSES a row that a different exercise has shifted into', () => {
    // The corruption this exists to stop: delete a set above a running
    // countdown and index 0 now names a squat. Completion would write
    // `seconds` onto it and tick it — a logged set that never happened, in a
    // different exercise, silently.
    expect(timedSetStillAt(sets, 1, 'plank')).toBe(false);
  });

  it('REFUSES an index past the end after rows were deleted', () => {
    expect(timedSetStillAt(sets, 7, 'plank')).toBe(false);
    expect(timedSetStillAt([], 0, 'plank')).toBe(false);
  });

  it('is not fooled by the same exercise at a different position', () => {
    // Index 2 is also a plank, but it is not the plank being timed. The check
    // is per-index by design — reordering is what stops the countdown, and
    // this only has to refuse a row whose exercise no longer matches.
    expect(timedSetStillAt(sets, 2, 'back-squat')).toBe(false);
  });
});

describe('which chime marks the end', () => {
  it('gives a rest its own sound', () => {
    expect(completionSoundFor('rest')).toBe('restComplete');
  });

  it('gives a finished set a DIFFERENT one', () => {
    // The two mean opposite things — one says start moving, the other says
    // stop — and you hear them with the phone on a bench rather than in your
    // hand. Swapped, the app tells you to rest by chiming "set done"; nothing
    // on screen contradicts it because you are not looking at the screen.
    expect(completionSoundFor('work')).toBe('workComplete');
    expect(completionSoundFor('work')).not.toBe(completionSoundFor('rest'));
  });
});

describe('when the ticks start', () => {
  it('counts the last three seconds', () => {
    // Two is not enough to prepare for; five becomes nagging on a 60-second
    // plank you hear it on every set of. Pinned to the number, not to the
    // constant, so changing the value is a decision rather than a diff that
    // agrees with itself.
    expect(TICK_FROM_SECONDS).toBe(3);
  });
});

describe('formatting', () => {
  it('pads the seconds', () => {
    expect(formatCountdown(65)).toBe('1:05');
  });

  it('rounds rather than truncating, so 0:00 means done', () => {
    expect(formatCountdown(0.4)).toBe('0:00');
    expect(formatCountdown(59.6)).toBe('1:00');
  });

  it('never renders a negative clock', () => {
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('which sets can be timed, and for how long', () => {
  it('uses the duration already on the set — the template put it there', () => {
    // `setsFromWorkout` copies target_seconds onto every set it creates, so a
    // "3 × 1 min" plank arrives holding 60 and needs no second source.
    expect(workSecondsFor({ seconds: 60 }, 'time')).toBe(60);
  });

  it('refuses a set that is not measured in seconds', () => {
    // A countdown over a set of squats is a stopwatch pointed at nothing. The
    // null is what keeps the play button off those rows entirely.
    expect(workSecondsFor({ seconds: null }, 'weight_reps')).toBeNull();
    expect(workSecondsFor({ seconds: 30 }, 'reps')).toBeNull();
    expect(workSecondsFor({ seconds: 30 }, 'distance')).toBeNull();
  });

  it('defaults a plank with nothing prescribed', () => {
    expect(workSecondsFor({ seconds: null }, 'time')).toBe(DEFAULT_WORK_SECONDS);
  });

  it('refuses to invent a duration for distance_time', () => {
    // There the prescription is the DISTANCE — row 500m, run 400m — and the
    // time is the result, not the target. Defaulting it to 60s would invent a
    // goal the athlete never set.
    expect(workSecondsFor({ seconds: null }, 'distance_time')).toBeNull();
  });

  it('still times a distance_time set that DOES carry a duration', () => {
    expect(workSecondsFor({ seconds: 120 }, 'distance_time')).toBe(120);
  });

  it('treats a stored zero as no duration, not a zero-length set', () => {
    // A timer that is over before it starts fires its completion haptic
    // immediately and logs a zero-second set.
    expect(workSecondsFor({ seconds: 0 }, 'time')).toBe(DEFAULT_WORK_SECONDS);
    expect(workSecondsFor({ seconds: 0 }, 'distance_time')).toBeNull();
  });

  it('refuses an exercise the catalog has not loaded yet', () => {
    // The catalog arrives asynchronously; offering a timer against an unknown
    // load type would guess at how the set is measured.
    expect(workSecondsFor({ seconds: 60 }, undefined)).toBeNull();
  });
});
