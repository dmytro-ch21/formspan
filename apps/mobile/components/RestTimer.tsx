import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { formatRest } from '@/lib/rest';

export type RestState = {
  /** Which exercise this rest belongs to, so an adjustment can be saved to it. */
  exerciseID?: string;
  /** Epoch ms the rest ends at. Null while paused. */
  endsAt: number | null;
  /** Seconds left, frozen, while paused. */
  pausedWith: number | null;
  /** What the rest started at, for the progress bar. */
  total: number;
  /** Named so the bar can say what you're resting from. */
  label: string;
};

/**
 * A rest countdown, driven by a deadline rather than by ticks.
 *
 * The distinction matters more than it sounds. A timer that decrements a
 * counter every second drifts, and it stops entirely when iOS throttles the
 * JS thread — which happens the moment the phone goes in a pocket, i.e.
 * during every real rest period. So the only stored state is the epoch
 * millisecond the rest *ends*, and every tick simply re-reads the clock. Put
 * the phone away for two minutes and the timer is correct when you look
 * again, because it was never counting in the first place.
 *
 * Same reason it re-reads on foreground: nothing to reconcile, just recompute.
 */
export function useRestTimer() {
  const [rest, setRest] = useState<RestState | null>(null);
  const [remaining, setRemaining] = useState(0);
  const firedRef = useRef(false);

  const recompute = useCallback((state: RestState | null) => {
    if (!state) return 0;
    if (state.pausedWith != null) return state.pausedWith;
    if (state.endsAt == null) return 0;
    return Math.max(0, (state.endsAt - Date.now()) / 1000);
  }, []);

  useEffect(() => {
    if (!rest) return;
    setRemaining(recompute(rest));
    if (rest.pausedWith != null) return;

    // 250ms so the seconds tick over promptly rather than up to a second
    // late — the difference between "snappy" and "laggy" at a glance.
    const id = setInterval(() => {
      const left = recompute(rest);
      setRemaining(left);
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true;
        // You should not have to be looking at the phone to know rest is
        // over — that's the entire point of a rest timer in a gym.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
    }, 250);

    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setRemaining(recompute(rest));
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [rest, recompute]);

  const start = useCallback((seconds: number, label: string, exerciseID?: string) => {
    firedRef.current = false;
    setRest({ endsAt: Date.now() + seconds * 1000, pausedWith: null, total: seconds, label, exerciseID });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const stop = useCallback(() => setRest(null), []);

  const adjust = useCallback((delta: number) => {
    setRest((r) => {
      if (!r) return r;
      firedRef.current = false;
      if (r.pausedWith != null) {
        return { ...r, pausedWith: Math.max(0, r.pausedWith + delta), total: r.total + delta };
      }
      return {
        ...r,
        endsAt: (r.endsAt ?? Date.now()) + delta * 1000,
        // Grows with the adjustment so the bar can't overflow its track.
        total: Math.max(1, r.total + delta),
      };
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const togglePause = useCallback(() => {
    setRest((r) => {
      if (!r) return r;
      if (r.pausedWith != null) {
        return { ...r, endsAt: Date.now() + r.pausedWith * 1000, pausedWith: null };
      }
      return { ...r, pausedWith: Math.max(0, ((r.endsAt ?? Date.now()) - Date.now()) / 1000) };
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);

  return { rest, remaining, start, stop, adjust, togglePause };
}

export function RestTimerBar({
  rest,
  remaining,
  onAdjust,
  onTogglePause,
  onStop,
}: {
  rest: RestState;
  remaining: number;
  onAdjust: (delta: number) => void;
  onTogglePause: () => void;
  onStop: () => void;
}) {
  const done = remaining <= 0;
  const paused = rest.pausedWith != null;
  const progress = Math.max(0, Math.min(1, remaining / rest.total));

  return (
    <View style={[styles.bar, done && styles.barDone]} testID="rest-timer">
      {/* Drains left to right. Readable from across a gym without reading
          the number at all. */}
      <RNView style={styles.track}>
        <RNView
          style={[styles.fill, { width: `${progress * 100}%` }, done && styles.fillDone]}
        />
      </RNView>

      <View style={styles.row}>
        <Pressable
          onPress={() => onAdjust(-15)}
          style={styles.adjust}
          accessibilityRole="button"
          accessibilityLabel="Take 15 seconds off the rest"
          testID="rest-minus"
        >
          <Text style={styles.adjustText}>−15</Text>
        </Pressable>

        <Pressable
          onPress={onTogglePause}
          style={styles.centre}
          accessibilityRole="button"
          accessibilityLabel={
            done
              ? 'Rest finished'
              : paused
                ? `Paused with ${formatRest(remaining)} left. Resume.`
                : `${formatRest(remaining)} left. Pause.`
          }
          testID="rest-toggle"
        >
          <Text style={[styles.clock, done && styles.clockDone]} testID="rest-remaining">
            {done ? 'Rest done' : formatRest(remaining)}
          </Text>
          <Text style={styles.caption} numberOfLines={1}>
            {paused ? 'Paused' : done ? 'Next set' : rest.label}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => onAdjust(15)}
          style={styles.adjust}
          accessibilityRole="button"
          accessibilityLabel="Add 15 seconds to the rest"
          testID="rest-plus"
        >
          <Text style={styles.adjustText}>+15</Text>
        </Pressable>

        <Pressable
          onPress={onStop}
          style={styles.skip}
          accessibilityRole="button"
          accessibilityLabel={done ? 'Dismiss the rest timer' : 'Skip the rest'}
          testID="rest-skip"
        >
          <Text style={styles.skipText}>{done ? 'Done' : 'Skip'}</Text>
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
  fill: { height: 3, backgroundColor: vola.lime },
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
  skipText: { fontWeight: '700', fontSize: 14, color: vola.lime },
});
