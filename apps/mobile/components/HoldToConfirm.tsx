import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View as RNView,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';

/**
 * A button you have to hold, for actions a stray tap must not perform.
 *
 * Finishing a session was a single tap on a screen operated with wet hands,
 * one-handed, between sets — and finishing is not reversible from the phone.
 * A hold makes the deliberate case cost 900ms and the accidental case cost
 * nothing, which is the right way round.
 *
 * ## The commit is a timer, not an animation callback
 *
 * The obvious build drives everything from `Animated.timing(...).start(cb)` and
 * commits when `cb` reports `finished`. This does not, and the separation is
 * deliberate: the decision to perform an irreversible action should not depend
 * on the animation system delivering a callback. `useNativeDriver` runs the
 * fill on the UI thread and its callback crosses back over the bridge; a
 * dropped or late callback there would either lose a confirmed action or, if
 * the `finished` flag were ever mishandled, perform one that was cancelled.
 *
 * So the timer decides and the fill only illustrates. It also makes the whole
 * thing testable with fake timers rather than by trying to run an animation in
 * jest.
 *
 * ## `scaleX`, not `width`
 *
 * `useNativeDriver` cannot animate layout properties, and `width` is one. A
 * JS-driven fill on the session screen would stutter against exactly the work
 * that screen does while you are holding the button. A full-width bar scaled
 * from its left edge is the same picture on the UI thread.
 */

/**
 * How long the hold takes.
 *
 * Long enough that a brush of the thumb cannot reach it, short enough that
 * someone who means it does not wonder whether the button is broken. Under
 * ~600ms accidental holds start getting through; past ~1.2s it stops reading
 * as a button at all.
 */
export const HOLD_MS = 900;

/**
 * Does this athlete get a tap-and-confirm instead of a hold?
 *
 * **A screen reader user cannot hold this button.** VoiceOver's activation
 * gesture is a double-tap that synthesises a press and an immediate release —
 * there is no sustained contact to measure, so a hold-only control is not
 * merely awkward for them, it is unreachable, and it fails silently: the button
 * is announced, focusable, and does nothing. They get a confirm dialog, which
 * is the same two-step protection by a different means.
 *
 * A named function rather than an inline `if` because deleting it leaves a
 * control that looks completely fine to everyone who tests it.
 */
export function usesTapFallback(screenReaderEnabled: boolean): boolean {
  return screenReaderEnabled;
}

export function HoldToConfirm({
  label,
  holdingLabel,
  onConfirm,
  confirmTitle,
  confirmBody,
  durationMs = HOLD_MS,
  style,
  textStyle,
  fillColor = vola.lime,
  destructive = false,
  testID,
}: {
  label: string;
  /** Shown while the hold is in progress. Defaults to "Keep holding…". */
  holdingLabel?: string;
  onConfirm: () => void;
  /** Title for the screen-reader confirm dialog. */
  confirmTitle: string;
  /** Body for the screen-reader confirm dialog. */
  confirmBody?: string;
  durationMs?: number;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  fillColor?: string;
  /** Styles the screen-reader dialog's confirm button red. Finishing is not. */
  destructive?: boolean;
  testID?: string;
}) {
  const [holding, setHolding] = useState(false);
  const [screenReader, setScreenReader] = useState(false);
  /*
    Lazy `useState`, not `useRef(new Animated.Value(0)).current`.

    Both create the value once, but the ref form reads `.current` during render,
    which `react-hooks/refs` flags — correctly, since render can run without
    committing. The initialiser form gets the same single instance with none of
    that. (`SwipeToDelete` still uses the older shape and is one of the
    warnings the ratchet is holding.)
  */
  const [progress] = useState(() => new Animated.Value(0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** So the screen-reader effect can disarm without depending on hook order. */
  const disarmRef = useRef<(() => void) | null>(null);

  /*
    A hold in flight when the screen reader comes on must not survive it.

    Both branches return a root `Pressable`, so React reconciles the same host
    instance and merely swaps props — and the fallback has no `onPressOut`. The
    finger that armed the timer would lift against a handler that no longer
    exists, and the commit would fire anyway. Exotic (it needs VoiceOver toggled
    inside a 900ms window) and three lines to remove entirely.
  */
  useEffect(() => {
    if (screenReader) disarmRef.current?.();
  }, [screenReader]);

  useEffect(() => {
    AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => sub.remove();
  }, []);

  /** Stops the countdown. Nothing visual — see the two callers. */
  const disarm = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    disarm();
    setHolding(false);
    // Snaps back rather than easing, so an abandoned hold is unmistakably
    // abandoned — a fill that drains slowly reads as still counting.
    Animated.timing(progress, {
      toValue: 0,
      duration: 140,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [disarm, progress]);

  /*
    Unmount disarms and does NOT animate.

    A hold in flight when the screen closes must not fire — nobody is holding
    anything any more — but running the snap-back here drives an animation
    against a tree that has already gone, which React reports as "unable to
    find node on an unmounted component". Harmless in production and not
    harmless in the suite, where it surfaces inside whichever test runs next.
  */
  useEffect(() => {
    disarmRef.current = disarm;
  }, [disarm]);

  useEffect(() => disarm, [disarm]);

  const start = useCallback(() => {
    if (timer.current) return;
    setHolding(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      progress.setValue(0);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onConfirm();
    }, durationMs);
  }, [durationMs, onConfirm, progress]);

  if (usesTapFallback(screenReader)) {
    return (
      <Pressable
        onPress={() =>
          Alert.alert(confirmTitle, confirmBody, [
            { text: 'Cancel', style: 'cancel' },
            { text: label, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
          ])
        }
        style={[styles.button, style]}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Asks you to confirm"
        testID={testID}
      >
        <Text style={[styles.label, textStyle]}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      style={[styles.button, style]}
      accessibilityRole="button"
      accessibilityLabel={label}
      // Said out loud, because a button that ignores taps with no explanation
      // is indistinguishable from a broken one.
      accessibilityHint="Press and hold to confirm"
      testID={testID}
    >
      <RNView style={styles.fillTrack} pointerEvents="none">
        <Animated.View
          style={[
            styles.fill,
            { backgroundColor: fillColor, transform: [{ scaleX: progress }] },
          ]}
        />
      </RNView>
      <Text style={[styles.label, textStyle]}>{holding ? (holdingLabel ?? 'Keep holding…') : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    // Transparent by default: this control must not impose chrome on a caller.
    // `styles.deleteButton` is a quiet text link with no background of its
    // own, and a base colour here turned it into a filled block — a visual
    // change nobody asked for, in a diff about gestures. Callers that want a
    // filled look pass one (the finish buttons do).
    backgroundColor: 'transparent',
  },
  fillTrack: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Grows from the left edge rather than from the middle. Without this the
    // fill opens outward from the centre, which reads as a pulse rather than
    // as progress toward something.
    transformOrigin: 'left',
    opacity: 0.28,
  },
  label: { fontWeight: '700', fontSize: 16 },
});
