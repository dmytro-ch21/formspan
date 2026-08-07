import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  adjusted,
  formatCountdown,
  rearmsCompletionOnAdjust,
  remainingAt,
  toggledPause,
  type Countdown,
} from '@/lib/countdown';

/**
 * The session screen's one countdown — resting, or performing a timed set.
 *
 * The arithmetic lives in `lib/countdown.ts` and is tested there; this is the
 * React around it. See that file for why the model is a deadline rather than a
 * tick, and why rest and work deliberately share one state.
 *
 * `onComplete` fires once when a countdown reaches zero, and is how a timed set
 * gets written back: a work countdown that finishes has produced a number the
 * session needs to log, which is the one thing rest never does.
 */
export function useCountdown(onComplete?: (c: Countdown) => void) {
  const [timer, setTimer] = useState<Countdown | null>(null);
  const [remaining, setRemaining] = useState(0);
  const firedRef = useRef(false);

  /**
   * The callback, held in a ref and refreshed after every render.
   *
   * The ref is the point: the session screen passes an inline arrow, so a new
   * identity every render, and putting it in the interval effect's deps would
   * tear down and re-subscribe the countdown on every keystroke — restarting
   * the 250ms tick continuously while somebody types a weight.
   *
   * Written in an effect rather than during render, which is not a style
   * preference: assigning `.current` in the render body is what
   * `react-hooks/refs` flags, and it is flagged because render can run without
   * committing. The interval that reads this is itself started by an effect,
   * so it cannot observe the ref before this has run.
   */
  const completeRef = useRef(onComplete);
  useEffect(() => {
    completeRef.current = onComplete;
  });

  useEffect(() => {
    if (!timer) return;
    setRemaining(remainingAt(timer, Date.now()));
    if (timer.pausedWith != null) return;

    // 250ms so the seconds tick over promptly rather than up to a second
    // late — the difference between "snappy" and "laggy" at a glance.
    const id = setInterval(() => {
      const left = remainingAt(timer, Date.now());
      setRemaining(left);
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true;
        // You should not have to be looking at the phone to know a rest is
        // over or a plank is done — that is the entire point in a gym.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        completeRef.current?.(timer);
      }
    }, 250);

    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setRemaining(remainingAt(timer, Date.now()));
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [timer]);

  const start = useCallback((next: Omit<Countdown, 'endsAt' | 'pausedWith'>) => {
    firedRef.current = false;
    setTimer({ ...next, endsAt: Date.now() + next.total * 1000, pausedWith: null });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const startRest = useCallback(
    (seconds: number, label: string, exerciseID?: string) =>
      start({ kind: 'rest', total: seconds, label, exerciseID }),
    [start],
  );

  const startWork = useCallback(
    (seconds: number, label: string, exerciseID: string, setIndex: number) =>
      start({ kind: 'work', total: seconds, label, exerciseID, setIndex }),
    [start],
  );

  const stop = useCallback(() => setTimer(null), []);

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

  return { timer, remaining, startRest, startWork, stop, adjust, togglePause };
}

/**
 * Copy for the bar, by kind.
 *
 * Pulled out because the two countdowns say genuinely different things at the
 * same moments — a finished rest means "go", a finished work set means "there
 * is a number to keep" — and a bar that said "Rest done" over a plank would be
 * the sort of wrong that makes an athlete distrust the whole screen.
 */
export function countdownCopy(kind: Countdown['kind']) {
  return kind === 'work'
    ? { done: 'Set done', doneCaption: 'Logged', stop: 'Stop', stopHint: 'Stop and log what you did' }
    : { done: 'Rest done', doneCaption: 'Next set', stop: 'Skip', stopHint: 'Skip the rest' };
}

export function CountdownBar({
  timer,
  remaining,
  onAdjust,
  onTogglePause,
  onStop,
}: {
  timer: Countdown;
  remaining: number;
  onAdjust: (delta: number) => void;
  onTogglePause: () => void;
  onStop: () => void;
}) {
  const accent = useAccent();
  const done = remaining <= 0;
  const paused = timer.pausedWith != null;
  const progress = Math.max(0, Math.min(1, remaining / timer.total));
  const copy = countdownCopy(timer.kind);

  return (
    <View style={[styles.bar, done && styles.barDone]} testID="countdown-timer">
      {/* Drains left to right. Readable from across a gym without reading
          the number at all. */}
      <RNView style={styles.track}>
        <RNView
          style={[
            styles.fill,
            { width: `${progress * 100}%`, backgroundColor: accent.accent },
            done && styles.fillDone,
          ]}
        />
      </RNView>

      <View style={styles.row}>
        <Pressable
          onPress={() => onAdjust(-15)}
          style={styles.adjust}
          accessibilityRole="button"
          accessibilityLabel="Take 15 seconds off"
          testID="countdown-minus"
        >
          <Text style={styles.adjustText}>−15</Text>
        </Pressable>

        <Pressable
          onPress={onTogglePause}
          style={styles.centre}
          accessibilityRole="button"
          accessibilityLabel={
            done
              ? copy.done
              : paused
                ? `Paused with ${formatCountdown(remaining)} left. Resume.`
                : `${formatCountdown(remaining)} left. Pause.`
          }
          testID="countdown-toggle"
        >
          <Text style={[styles.clock, done && styles.clockDone]} testID="countdown-remaining">
            {done ? copy.done : formatCountdown(remaining)}
          </Text>
          <Text style={styles.caption} numberOfLines={1}>
            {paused ? 'Paused' : done ? copy.doneCaption : timer.label}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => onAdjust(15)}
          style={styles.adjust}
          accessibilityRole="button"
          accessibilityLabel="Add 15 seconds"
          testID="countdown-plus"
        >
          <Text style={styles.adjustText}>+15</Text>
        </Pressable>

        <Pressable
          onPress={onStop}
          style={styles.skip}
          accessibilityRole="button"
          accessibilityLabel={done ? 'Dismiss the timer' : copy.stopHint}
          testID="countdown-skip"
        >
          <Text style={[styles.skipText, { color: accent.ink }]}>{done ? 'Done' : copy.stop}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: 1,
    borderTopColor: vola.line,
    backgroundColor: vola.surface,
    paddingBottom: 26, // clears the home indicator
  },
  barDone: { backgroundColor: vola.surfaceRaised },
  track: { height: 3, backgroundColor: vola.line, width: '100%' },
  fill: { height: 3 },
  fillDone: { backgroundColor: vola.green },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10 },
  adjust: {
    minWidth: 56,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.line,
  },
  adjustText: { fontWeight: '700', fontSize: 15 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  // Tabular figures: without them the whole row jitters as digits change,
  // which is the cheapest way to make a timer feel cheap.
  clock: { fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 0.5 },
  clockDone: { color: vola.green, fontSize: 24 },
  caption: { fontSize: 11, color: vola.textDim, textTransform: 'capitalize' },
  skip: {
    minWidth: 60,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: vola.surfaceRaised,
  },
  skipText: { fontWeight: '700', fontSize: 14 },
});
