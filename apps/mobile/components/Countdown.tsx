import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  READY_SECONDS,
  completionSoundFor,
  elapsedOf,
  remainingAt,
  rearmsCompletionOnAdjust,
  tickSchedule,
  toggledPause,
  adjusted,
  type Countdown,
} from '@/lib/countdown';
import {
  advanced,
  countdownFor,
  type Run,
  type RunStep,
} from '@/lib/intervalRun';
import { playSound } from '@/lib/sounds';
import { announce, cuesForTransition, speak, stopSpeaking, voiceEnabled } from '@/lib/voice';

/**
 * The session screen's one countdown — resting, getting ready, or performing a
 * timed set — plus the machinery for walking a whole run of them.
 *
 * The arithmetic lives in `lib/countdown.ts` and the sequencing in
 * `lib/intervalRun.ts`; both are pure and tested there. This is the React around
 * them: state, timers, sound and haptics.
 *
 * ## The ticks are SCHEDULED, not polled — and that is a bug fix
 *
 * The last-three-seconds ticks used to fire from the 250ms display interval, on
 * whichever pass first noticed a new whole second. That put every beep between 0
 * and 250ms *after* the second turned over — averaging 125ms late, which is
 * precisely audible and reads as the timer lagging rather than the sound. On a
 * count-in it is worse than cosmetic: you move on the beep.
 *
 * The deadline model already knows exactly when each tick is due, and has since
 * the countdown started. So each one now gets its own `setTimeout` aimed at
 * `endsAt - n × 1000`, and the interval is left doing the only job it is
 * actually good at: repainting digits, where a quarter second of staleness is
 * invisible.
 *
 * The interval keeps ONE piece of logic — completing an overdue countdown — as a
 * backstop. iOS suspends JS when the app leaves the screen, so a timeout that
 * came due in the background fires late or not at all; the interval catches that
 * on the next foreground pass. `firedRef` makes the two paths idempotent.
 *
 * `onComplete` fires once when a countdown reaches zero, and is how a timed set
 * gets written back: a work countdown that finishes has produced a number the
 * session needs to log, which is the one thing rest never does.
 */
export function useCountdown(
  /**
   * `elapsed` is what the clock actually counted, never what it was asked for.
   *
   * The two differ whenever a countdown is ended deliberately early — Skip on a
   * work step, mid-plank — and the honest number is the one that belongs in the
   * log. Passing it here rather than making the screen re-derive it is what
   * keeps the natural finish and the early finish on one path: a countdown that
   * ran out reports `total`, because that is what it counted.
   */
  onComplete?: (c: Countdown, elapsed: number) => void,
  /** Called when a run finishes on its own, rather than being stopped. */
  onRunEnd?: (run: Run) => void,
) {
  const [timer, setTimer] = useState<Countdown | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  /**
   * Whether the timer is showing as a top bar rather than the full surface.
   *
   * Held here rather than in the screen because starting a countdown is what
   * decides it — see {@link startRest}. Rest opens minimised and work does not,
   * because resting is time you spend looking at the room and a timed set is
   * time you spend looking at the clock.
   */
  const [minimized, setMinimized] = useState(false);
  const firedRef = useRef(false);

  /**
   * The callback, held in a ref and refreshed after every render.
   *
   * The ref is the point: the session screen passes an inline arrow, so a new
   * identity every render, and putting it in the timer effect's deps would tear
   * down and re-subscribe the countdown on every keystroke — restarting the tick
   * schedule continuously while somebody types a weight.
   *
   * Written in an effect rather than during render, which is not a style
   * preference: assigning `.current` in the render body is what
   * `react-hooks/refs` flags, and it is flagged because render can run without
   * committing. The timers that read this are themselves started by an effect,
   * so they cannot observe the ref before this has run.
   */
  const completeRef = useRef(onComplete);
  const runEndRef = useRef(onRunEnd);
  useEffect(() => {
    completeRef.current = onComplete;
    runEndRef.current = onRunEnd;
  });

  /**
   * The live run, for the completion handler to read.
   *
   * A ref beside the state because the handler runs inside a timer callback that
   * closed over the render which scheduled it: reading `run` there would see
   * whatever it was when the *current step* started, which for a five-minute
   * round is several steps stale. The state drives rendering; this drives the
   * transition.
   */
  const runRef = useRef<Run | null>(null);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  /**
   * The live countdown, updated SYNCHRONOUSLY, purely so a stale timer callback
   * can recognise itself as stale.
   *
   * **This closes a real double-fire window, found in review.** Advancing a run
   * calls `start()`, which resets `firedRef` to false — while the *previous*
   * step's 250ms interval, AppState listener and late completion timeout are all
   * still armed, because the `[timer]` effect's cleanup does not run until React
   * commits. Every one of those closures holds the old, expired countdown, so
   * their `left <= 0 && !firedRef.current` guard passes a second time and
   * `finishRef.current` — not yet reassigned either — re-fires the same step:
   * a second `recordTimedSet` on a work row, and a second `advanced()` that skips
   * the step after it.
   *
   * The realistic trigger is not exotic. It is the app being backgrounded during
   * a run and the suspended timeout and the AppState `'active'` handler arriving
   * in the same wake-up batch, ahead of React's deferred commit.
   *
   * `firedRef` alone cannot express this, because a run legitimately re-arms it
   * on every step. Identity can: a callback scheduled for a countdown that is no
   * longer the live one has nothing to say.
   */
  const timerRef = useRef<Countdown | null>(null);

  const start = useCallback((next: Omit<Countdown, 'endsAt' | 'pausedWith'>) => {
    const started: Countdown = {
      ...next,
      endsAt: Date.now() + next.total * 1000,
      pausedWith: null,
    };
    firedRef.current = false;
    // Before the setState, not after: the whole point is that this is true the
    // instant `start` returns, while a queued callback from the previous step
    // may still run before React commits.
    timerRef.current = started;
    setTimer(started);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  /**
   * Everything that happens when a countdown reaches zero.
   *
   * Ref-held rather than a `useCallback` because it is called from timers
   * scheduled in an effect that must NOT re-run when it changes — a new identity
   * per render would restart the schedule on every keystroke, which is the exact
   * problem `completeRef` exists to solve one level up. Written from an effect
   * rather than during render for the reason spelled out there: assigning
   * `.current` in a render body is what `react-hooks/refs` flags, because render
   * can run without committing.
   */
  const finishRef = useRef<() => void>(() => {});

  function finish() {
    const t = timer;
    if (!t || firedRef.current) return;
    // A callback left over from a step that has already handed over — see
    // `timerRef`. Not the same check as `firedRef`: that one asks "has THIS
    // countdown finished", and a run resets it on every step.
    if (timerRef.current !== t) return;
    firedRef.current = true;

    // You should not have to be looking at the phone to know a rest is over or a
    // plank is done — that is the entire point in a gym. The haptic covers the
    // phone being in a pocket; the sound covers it being on a bench across
    // the rack.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

    const current = runRef.current;
    const next = current ? advanced(current) : null;
    const upcoming = next?.steps[next.at];
    /*
      In a guided run the VOICE replaces the completion chime rather than joining
      it. Both at once is two things speaking over each other in a room that is
      already loud, and the voice is the one carrying information the chime
      cannot — which of the two intervals just ended, and what the next one is.

      `voiceEnabled()` is checked here rather than left to `speak` to no-op,
      because the fallback matters: an athlete with the voice off and sounds on
      must still get a chime. Without this the two preferences interact to
      produce silence, which reads as the timer having stopped.
    */
    const spoken = current?.scope === 'session' && voiceEnabled();
    if (spoken) {
      for (const cue of cuesForTransition(t.kind, upcoming?.kind ?? null)) speak(cue);
      // The next exercise is named only when it actually changes, and only into
      // a rest, where there are thirty seconds of nothing to talk over.
      // Announcing it every set would make the app a metronome with a vocabulary.
      if (upcoming?.kind === 'rest' && upcoming.exerciseID !== t.exerciseID) {
        announce(`Next, ${upcoming.label}`);
      }
    } else {
      playSound(completionSoundFor(t.kind));
    }

    // The screen's own handler — this is what writes a finished timed set.
    // `elapsedOf` against the live clock, so a step ended early by Skip reports
    // the seconds that actually happened rather than the ones that were asked
    // for. A countdown that simply ran out has zero remaining and reports its
    // full total, which is the same number by a different route.
    completeRef.current?.(t, elapsedOf(t, remainingAt(t, Date.now())));

    if (!current) return;
    if (next) {
      setRun(next);
      runRef.current = next;
      const step = next.steps[next.at];
      setMinimized(step.kind === 'rest');
      start(countdownFor(step));
    } else {
      setRun(null);
      runRef.current = null;
      setTimer(null);
      runEndRef.current?.(current);
    }
  }

  /*
    Declared BELOW `finish` rather than beside the ref, and above the timer
    effect rather than below it — both positions are load-bearing.

    Below `finish`, because the React compiler's lint rejects reading a function
    declared later from an effect: hoisting makes it work, but the rule exists
    because the earlier reference would not track a value that changes over time,
    and this one changes every render.

    Above the timer effect, because effects run in declaration order within a
    commit — so by the time the schedule below is built, this ref already holds
    the current render's closure over `timer`.
  */
  useEffect(() => {
    finishRef.current = finish;
  });

  useEffect(() => {
    if (!timer) return;
    setRemaining(remainingAt(timer, Date.now()));
    if (timer.pausedWith != null) return;

    const scheduled: ReturnType<typeof setTimeout>[] = [];
    if (!firedRef.current) {
      /*
        One timer per remaining tick, aimed at the exact instant that second
        turns over. `tickSchedule` filters to what is still ahead, so an
        adjustment at "2" re-derives the ticks it has not played yet and never
        replays one that already sounded.

        It matters most for a WORK countdown and for the count-in: a plank
        ending without warning is a set you hold two seconds too long or drop
        two seconds early, and you are not looking at the phone.
      */
      for (const t of tickSchedule(timer, Date.now())) {
        scheduled.push(setTimeout(() => playSound('tick'), Math.max(0, t.at - Date.now())));
      }
      scheduled.push(
        setTimeout(
          () => finishRef.current(),
          Math.max(0, (timer.endsAt ?? Date.now()) - Date.now()),
        ),
      );
    }

    // 250ms so the seconds repaint promptly rather than up to a second late —
    // the difference between "snappy" and "laggy" at a glance. It also catches a
    // completion whose timeout was suspended while the app was backgrounded.
    const id = setInterval(() => {
      const left = remainingAt(timer, Date.now());
      setRemaining(left);
      if (left <= 0 && !firedRef.current) finishRef.current();
    }, 250);

    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      const left = remainingAt(timer, Date.now());
      setRemaining(left);
      if (left <= 0 && !firedRef.current) finishRef.current();
    });

    return () => {
      clearInterval(id);
      for (const t of scheduled) clearTimeout(t);
      sub.remove();
    };
  }, [timer]);

  const startRest = useCallback(
    (seconds: number, label: string, exerciseID?: string, step?: number) => {
      // Rest opens minimised: it is time spent racking a bar, drinking, and
      // looking at anything except the phone. A full-screen clock for that is
      // the app putting itself in front of the gym.
      setMinimized(true);
      setRun(null);
      runRef.current = null;
      start({ kind: 'rest', total: seconds, label, exerciseID, step });
    },
    [start],
  );

  const startWork = useCallback(
    (seconds: number, label: string, exerciseID: string, setIndex: number, step?: number) => {
      setMinimized(false);
      setRun(null);
      runRef.current = null;
      start({ kind: 'work', total: seconds, label, exerciseID, setIndex, step });
    },
    [start],
  );

  /**
   * A single timed set, counted in first.
   *
   * A one-step run rather than a bare `ready` countdown, so the handover to the
   * work interval goes through exactly the same code path the multi-set run
   * uses. Two ways to get from a count-in to a set is two places for it to
   * break, and only one of them would be covered.
   */
  const startWorkWithLeadIn = useCallback(
    (seconds: number, label: string, exerciseID: string, setIndex: number, step?: number) => {
      const common = { label, exerciseID, step, ordinal: 1, total: 1 };
      const steps: RunStep[] = [
        { ...common, kind: 'ready', seconds: READY_SECONDS },
        { ...common, kind: 'work', seconds, setIndex },
      ];
      setMinimized(false);
      const next: Run = { steps, at: 0, scope: 'exercise' };
      setRun(next);
      runRef.current = next;
      start(countdownFor(steps[0]));
    },
    [start],
  );

  /** Start a built plan — "run all sets", or a whole guided workout. */
  const startRun = useCallback(
    (steps: RunStep[], scope: Run['scope']) => {
      if (steps.length === 0) return;
      const next: Run = { steps, at: 0, scope };
      setRun(next);
      runRef.current = next;
      setMinimized(steps[0].kind === 'rest');
      // There is no transition into step 0, so the arrival cue for it is spoken
      // here — the one place the run's own handler cannot reach. It overlaps the
      // count-in's first tick by design: dropping that tick would count the
      // athlete in "2, 1, go", and a short bell under a spoken cue is what every
      // interval timer sounds like anyway.
      if (scope === 'session') {
        for (const cue of cuesForTransition(null, steps[0].kind)) speak(cue);
      }
      start(countdownFor(steps[0]));
    },
    [start],
  );

  const stop = useCallback(() => {
    // Immediate, not "after the current phrase": stopping a workout and then
    // being told to get ready is the app arguing with a decision already made.
    stopSpeaking();
    timerRef.current = null;
    setTimer(null);
    setRun(null);
    runRef.current = null;
  }, []);

  /**
   * Leaving the screen has to silence the voice as surely as Stop does.
   *
   * The timers are torn down by the `[timer]` effect's own cleanup, but
   * `expo-speech` has a queue that outlives this component: a "Next, mountain
   * climbers" queued a moment before a back-swipe otherwise plays over whatever
   * screen the athlete just navigated to.
   */
  useEffect(() => stopSpeaking, []);

  const adjust = useCallback((delta: number) => {
    setTimer((t) => {
      if (!t) return t;
      /*
        Re-arming completion is for REST only, and the asymmetry is the whole
        point.

        A rest that has run out and gets +15 should chime again when the new
        time is up — nothing has been recorded, so firing twice costs a haptic.
        A work countdown's completion WRITES: it sets `seconds` and ticks the
        set. Re-arming it means a finished countdown, sitting at "Set done"
        with its buttons still live, can fire a second time and rewrite the row
        — and because `adjusted` grows `total`, one +15 tap turns a logged
        60-second plank into 75 without a countdown ever visibly running.

        So once a work countdown has fired, it is spent.
      */
      if (rearmsCompletionOnAdjust(t.kind)) firedRef.current = false;
      return adjusted(t, delta, Date.now());
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const togglePause = useCallback(() => {
    setTimer((t) => (t ? toggledPause(t, Date.now()) : t));
    Haptics.selectionAsync().catch(() => {});
  }, []);

  /**
   * Skip the current step of a run without ending the run.
   *
   * The escape hatch that makes a guided workout tolerable: a rest you do not
   * need, or a count-in you are already through. Deliberately routed through the
   * ordinary completion path so a skipped WORK step still logs what it actually
   * counted — skipping is not the same as pretending the set did not happen.
   */
  const skipStep = useCallback(() => {
    finishRef.current();
  }, []);

  return {
    timer,
    remaining,
    run,
    minimized,
    setMinimized,
    startRest,
    startWork,
    startWorkWithLeadIn,
    startRun,
    stop,
    skipStep,
    adjust,
    togglePause,
  };
}

/**
 * Copy for the timer, by kind.
 *
 * Pulled out because the countdowns say genuinely different things at the same
 * moments — a finished rest means "go", a finished work set means "there is a
 * number to keep", a finished count-in means nothing at all because the set has
 * already started — and a surface that said "Rest done" over a plank would be
 * the sort of wrong that makes an athlete distrust the whole screen.
 */
export function countdownCopy(kind: Countdown['kind']) {
  if (kind === 'work') {
    return {
      title: 'Work',
      done: 'Set done',
      doneCaption: 'Logged',
      stop: 'Stop',
      stopHint: 'Stop and log what you did',
    };
  }
  if (kind === 'ready') {
    return {
      title: 'Get ready',
      done: 'Go',
      doneCaption: 'Starting',
      stop: 'Skip',
      stopHint: 'Skip the count-in',
    };
  }
  return {
    title: 'Rest',
    done: 'Rest done',
    doneCaption: 'Next set',
    stop: 'Skip',
    stopHint: 'Skip the rest',
  };
}
