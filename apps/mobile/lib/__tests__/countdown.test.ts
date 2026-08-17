import {
  adjusted,
  completionSoundFor,
  elapsedOf,
  formatCountdown,
  isAdjustable,
  READY_SECONDS,
  rearmsCompletionOnAdjust,
  remainingAt,
  stepOf,
  TICK_FROM_SECONDS,
  tickSchedule,
  toggledPause,
  type Countdown,
} from '../countdown';
import {
  DEFAULT_WORK_SECONDS,
  offersTimerTarget,
  timedSetStillAt,
  workSecondsFor,
} from '../sessions';

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

  it('never re-arms a count-in, which cannot be adjusted anyway', () => {
    // Belt and braces with `isAdjustable`: the surface hides the buttons, and
    // this makes the model refuse even if a future caller finds another route
    // to `adjust`. A count-in that completed twice would start two work
    // intervals against one row.
    expect(rearmsCompletionOnAdjust('ready')).toBe(false);
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

  it('gives the count-in its own rising note', () => {
    // A count-in ending and a rest ending are both "go", but one is followed by
    // silence and the other by a set you are already three seconds into.
    // Sharing `restComplete` would have been free and wrong.
    expect(completionSoundFor('ready')).toBe('go');
    expect(completionSoundFor('ready')).not.toBe(completionSoundFor('rest'));
    expect(completionSoundFor('ready')).not.toBe(completionSoundFor('work'));
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

/**
 * The fix for the late beeps.
 *
 * The ticks used to fire from the 250ms display interval, on whichever pass
 * first noticed a new whole second — so every one landed between 0 and 250ms
 * AFTER the second turned over. Averaged 125ms late, audibly so, and on a
 * count-in it matters because you move on the beep.
 *
 * These pin the property that replaced it: the times are DERIVED FROM THE
 * DEADLINE and known the moment the countdown starts, so the caller can aim a
 * timer at each one instead of polling for it.
 */
describe('when the last seconds get announced', () => {
  it('puts each tick exactly on the second boundary', () => {
    const c = rest({ endsAt: T0 + 90_000, total: 90 });
    expect(tickSchedule(c, T0)).toEqual([
      { at: T0 + 87_000, second: 3 },
      { at: T0 + 88_000, second: 2 },
      { at: T0 + 89_000, second: 1 },
    ]);
  });

  it('counts a three-second lead-in in from its very first instant', () => {
    // `>= now`, not `>`. Dropping the tick due at t=0 would count the athlete
    // in "2, 1, go" — one short, on the cue they are about to move on.
    const ready = rest({ kind: 'ready', endsAt: T0 + 3_000, total: READY_SECONDS });
    expect(tickSchedule(ready, T0).map((t) => t.second)).toEqual([3, 2, 1]);
    expect(tickSchedule(ready, T0)[0].at).toBe(T0);
  });

  it('never replays a tick that has already sounded', () => {
    // An adjustment mid-countdown rebuilds the schedule; without the filter a
    // +15 at "2" would re-announce 3, 2 and 1 against the OLD deadline.
    const c = rest({ endsAt: T0 + 90_000, total: 90 });
    expect(tickSchedule(c, T0 + 88_500).map((t) => t.second)).toEqual([1]);
    expect(tickSchedule(c, T0 + 90_000)).toEqual([]);
  });

  it('never announces more seconds than the countdown has', () => {
    // A two-second countdown gets two ticks, not three — the third would be
    // due before it started.
    const short = rest({ endsAt: T0 + 2_000, total: 2 });
    expect(tickSchedule(short, T0).map((t) => t.second)).toEqual([2, 1]);
  });

  it('has nothing to schedule while paused', () => {
    // There is no deadline to hang the times off — the same reason
    // `remainingAt` short-circuits on `pausedWith`.
    expect(tickSchedule(rest({ pausedWith: 30 }), T0)).toEqual([]);
    expect(tickSchedule(rest({ endsAt: null }), T0)).toEqual([]);
  });

  it('announces exactly the last TICK_FROM_SECONDS seconds', () => {
    // Derived rather than hard-coded, so changing the constant moves the test
    // with it instead of failing it.
    expect(tickSchedule(rest(), T0)).toHaveLength(TICK_FROM_SECONDS);
  });
});

describe('what the timer lets you touch', () => {
  it('refuses to pause or stretch a count-in', () => {
    // A three-second lead-in exists to be over. ±15 on it is nonsense, and a
    // pause button is a control that exists for less time than it takes to
    // find. Rendering them and having them do nothing would be worse.
    expect(isAdjustable('ready')).toBe(false);
    expect(isAdjustable('rest')).toBe(true);
    expect(isAdjustable('work')).toBe(true);
  });

  it('moves by fifteen seconds unless the exercise thinks in minutes', () => {
    expect(stepOf({ step: undefined })).toBe(15);
    expect(stepOf({ step: 30 })).toBe(30);
    // A zero or negative step would make ± a no-op button.
    expect(stepOf({ step: 0 })).toBe(15);
    expect(stepOf({ step: -30 })).toBe(15);
  });
});

describe('which sets can be timed, and for how long', () => {
  it('uses the duration already on the set — the template put it there', () => {
    // `setsFromWorkout` copies target_seconds onto every set it creates, so a
    // "3 × 1 min" plank arrives holding 60 and needs no second source.
    expect(workSecondsFor({ seconds: 60 }, 'time')).toBe(60);
  });

  it('refuses to INVENT a duration for a set that is not measured in seconds', () => {
    // Still null, and for the reason that survived N4: nothing has said how
    // long. The old rule refused the exercise; this one refuses the guess.
    expect(workSecondsFor({ seconds: null }, 'weight_reps')).toBeNull();
    expect(workSecondsFor({ seconds: null }, 'distance')).toBeNull();
    // `distance_time` is the sharp case — it MEASURES seconds, so the old
    // load-type gate let it through, and the null here comes from the default
    // instead: rowing 500m has a distance prescription and no time one, and a
    // default would turn a measurement into a target.
    expect(workSecondsFor({ seconds: null }, 'distance_time')).toBeNull();
  });

  it('times any set the athlete gave a duration, whatever the exercise measures', () => {
    // N4. Forty seconds of squats is a real prescription and the thing a
    // circuit is made of, so an explicit duration outranks the load type.
    // Before this, both of these were null and the play button never appeared.
    expect(workSecondsFor({ seconds: 40 }, 'weight_reps')).toBe(40);
    expect(workSecondsFor({ seconds: 30 }, 'distance')).toBe(30);
    // The zero/negative guard still applies to them — an explicit duration has
    // to be a duration, or it falls through to the same "invent nothing" path.
    expect(workSecondsFor({ seconds: 0 }, 'weight_reps')).toBeNull();
    expect(workSecondsFor({ seconds: -30 }, 'weight_reps')).toBeNull();
  });

  it('times a dual-mode exercise only while it is in time mode', () => {
    // Burpees are `reps` in the catalog and can be counted either way — see
    // lib/setMode.ts. The duration IS the mode, so these two answers have to
    // track each other: reps mode carries no seconds and gets no timer, time
    // mode carries one and does.
    expect(workSecondsFor({ seconds: null }, 'reps')).toBeNull();
    expect(workSecondsFor({ seconds: 40 }, 'reps')).toBe(40);
    // And a stored zero is still not a duration.
    expect(workSecondsFor({ seconds: 0 }, 'reps')).toBeNull();
  });

  it('offers the timer field only where it cannot do damage', () => {
    // Where the whole point of N4 is: a squat can be given a duration.
    expect(offersTimerTarget('weight_reps')).toBe(true);
    expect(offersTimerTarget('distance')).toBe(true);

    // Already measures seconds — the measure field IS the control.
    expect(offersTimerTarget('time')).toBe(false);
    expect(offersTimerTarget('distance_time')).toBe(false);

    // DUAL-MODE, and this is the one review caught. `measuresForSet` returns
    // ['reps'] for a burpee set logged in reps, so a gate on the measures
    // alone offered the field there — and writing a duration onto it flips
    // the row to time mode via `setModeOf`, stranding the rep count in a row
    // that the volume rollup and the screen then describe differently.
    expect(offersTimerTarget('reps')).toBe(false);

    expect(offersTimerTarget(undefined)).toBe(false);
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
