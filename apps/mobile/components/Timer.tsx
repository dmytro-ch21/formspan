import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View as RNView } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { countdownCopy, useRemaining, type RemainingClock } from '@/components/Countdown';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { EASE, MS, SWAP_SCALE } from '@/constants/Motion';
import { useAccent } from '@/lib/AccentProvider';
import {
  formatCountdown,
  isAdjustable,
  remainingAt,
  stepOf,
  type Countdown,
} from '@/lib/countdown';
import { runProgress, type Run } from '@/lib/intervalRun';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { PressableScale } from '@/components/ui/PressableScale';

/**
 * The timer, at the top of the screen, in two sizes.
 *
 * ## Why the top, and why not the bottom any more
 *
 * It lived in a bar pinned to the bottom, which is where a phone's controls
 * belong — and that is exactly why it was wrong. The bottom of a session screen
 * is where the thumb lives: "+ Set", the done ticks, the swipe-to-delete rows.
 * A countdown parked there is a permanent 90pt reduction in the working area,
 * directly under the hand, competing with the controls the athlete is actually
 * using between sets. It also meant the one thing you want to read from three
 * metres away was the thing furthest from your eyeline when the phone is
 * propped against a water bottle.
 *
 * Above the content it costs nothing while minimised, reads at a glance, and the
 * expanded form can be big without burying the log.
 *
 * ## Two sizes, one state
 *
 * `minimized` is the only difference. The expanded card is what you look at
 * during a timed set — a ring you can read across a gym and a clock in the
 * middle of it. The bar is what a rest is, because rest is time you spend
 * looking at anything except the phone: {@link useCountdown} opens rest
 * minimised and work expanded for that reason, and the athlete can override
 * either with one tap.
 *
 * ## Every colour comes from the accent
 *
 * The ring, the label, the pause control and the run progress are all
 * `accent.accent` / `accent.ink`, at different opacities. Nothing here reaches
 * for `vola.lime` or `vola.green` — the old bar did, so a yellow-themed app grew
 * a green progress bar the moment a rest finished. The one non-accent colour is
 * the track behind the ring, which is `vola.line`: it is the absence of
 * progress, not a state.
 *
 * Kind is carried by the WORD ("Work", "Rest", "Get ready") and by opacity, not
 * by hue — there is only one hue available, and inventing a second would break
 * the promise the accent setting makes.
 */

/** The ring's progress arc, driven on the UI thread — see `Ring` (F57/#1140). */
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** How solid the ring is, by kind. Work is the one you are counting on. */
const RING_OPACITY: Record<Countdown['kind'], number> = {
  work: 1,
  ready: 0.85,
  rest: 0.55,
};

export type TimerControls = {
  timer: Countdown;
  remaining: number;
  run: Run | null;
  minimized: boolean;
  onMinimize: () => void;
  onExpand: () => void;
  onAdjust: (delta: number) => void;
  onTogglePause: () => void;
  /** Ends the countdown and dismisses the surface. */
  onStop: () => void;
  /** Ends this step and moves to the next one; only meaningful inside a run. */
  onSkip: () => void;
};

/**
 * How much room the collapsed bar needs above the content.
 *
 * Exported so the session screen can pad its scroll view by exactly this and
 * nothing else. A magic number repeated in two files is how a bar ends up
 * covering the first exercise on one build and floating over a gap on the next.
 *
 * The EXPANDED card still overlays rather than pushing: it is modal by intent,
 * and pushing 380pt of log down and back up every time a countdown starts and
 * finishes would make the screen jump under the thumb between every set.
 */
export const TIMER_BAR_SPACE = 64;

/**
 * N558/#1047 — the space is RESERVED for the life of a live session, not added
 * when a timer appears.
 *
 * It used to be `timer && minimized ? TIMER_BAR_SPACE : 0`, which moved the
 * whole workout log 64pt on four different taps — starting a rest, ending one,
 * expanding the bar and minimising the card — each on the frame the bar
 * appeared or went, with nothing on screen explaining the jump. The athlete's
 * thumb is usually on the tick that started the rest, so the row they just
 * touched left from under it about twenty times a session.
 *
 * Reserving rather than ANIMATING the padding, and the argument is recorded in
 * `docs/decisions/history.md` under N558. In short: an animated padding re-runs
 * Yoga over the entire log every frame on the screen least able to afford it;
 * a transform "FLIP" of the content fights the scroll offset in ways only a
 * device can judge; and both still MOVE the log under the thumb, just more
 * slowly — which the motion audit's own out-of-scope list rules out ("a jump is
 * over before the finger lands; a 300ms slide is not"). Reserved space moves
 * nothing, costs no frames, needs no Reduce Motion branch, and removes the
 * reverse jump on stop/expand/minimise as well. The price is 64pt of room above
 * the first exercise while no timer is showing, visible only when scrolled to
 * the very top.
 *
 * `timerShowing` keeps the space while a surface is still up on a session that
 * has just been finished, so finishing mid-rest does not slide the report under
 * the bar. The finished report with no timer gets its 64pt back.
 */
export function timerSpaceFor(session: { finished: boolean; timerShowing: boolean }): number {
  return !session.finished || session.timerShowing ? TIMER_BAR_SPACE : 0;
}

/*
  F55/#1134 — how the timer surface arrives, leaves, and changes size.

  Gate: a rest starts ~20 times a session and the bar ↔ card swap is a toggle,
  both in the "tens of times" band — so nothing here is longer than
  `MS.control`, and none of it is a spring (no finger carried velocity in).
  Purpose: spatial consistency.

  **Arrival and departure are opacity only, at `MS.press`.** The 64pt the bar
  appears into is already reserved (see `timerSpaceFor`), so the bar has
  nowhere to travel FROM, and a translate on an event that happens twenty times
  a session is decoration. N558 used `FadeInDown` / `FadeOutUp`, which rise 25pt
  from BELOW the slot — while two comments here said "from above". Removing the
  travel removes the direction question with it.

  **Every animation here carries `ReduceMotion.Never`, and that is not a
  bypass.** `ReduceMotion.System` is Reanimated's snapshot of the setting at app
  launch, and with Reduce Motion on it skips an animation outright — opacity
  included, so the surface popped in rather than fading. Reduced motion means
  gentler, not nothing. The decision is made in JavaScript from the LIVE
  `useReducedMotion()` hook instead, exactly as `Drain` below already does: a
  fade is kept in every state, and what Reduce Motion (or the OS not having
  answered yet) removes is the swap's scale, the only movement left here.
*/
const EASE_OUT = Easing.bezier(...EASE.out);

const ARRIVE = FadeIn.duration(MS.press).easing(EASE_OUT).reduceMotion(ReduceMotion.Never);
const LEAVE = FadeOut.duration(MS.press).easing(EASE_OUT).reduceMotion(ReduceMotion.Never);

/**
 * Bar ↔ card, as ONE persistent value: 0 is the bar, 1 is the card.
 *
 * N558 built the swap from keyed mount/unmount layout animations, and those
 * cannot retarget: a `Keyframe` always restarts from its frame-0 values, and
 * `FadeOut` always starts from opacity 1. So expanding and then minimising
 * within ~180ms faded the card in toward ~30%, SNAPPED it to 100%, and faded it
 * out again — a flash on a toggle. `/review-animations` blocked on exactly that.
 *
 * Assigning a new `withTiming` to a shared value starts from its CURRENT
 * presentation value, so a reversal continues from wherever the crossfade is.
 * Both forms stay mounted for that to be possible; the one not being shown is
 * hidden from touches and from assistive technology, so it exists only as a
 * fading picture.
 */
const SWAP_TIMING = { duration: MS.control, easing: EASE_OUT, reduceMotion: ReduceMotion.Never };

/**
 * The surface's props. `remaining` is NOT one of them — the surface subscribes
 * to the countdown's clock itself, so the 250ms tick re-renders this subtree
 * and not the screen that mounts it. See `RemainingClock` in `Countdown.tsx`.
 */
export type TimerSurfaceProps = Omit<TimerControls, 'remaining'> & { clock: RemainingClock };

export function TimerSurface({ clock, ...controls }: TimerSurfaceProps) {
  const remaining = useRemaining(clock);
  const props: TimerControls = { ...controls, remaining };
  const expanded = !props.minimized;

  /*
    F57/#1140 — the countdown's fractions are armed HERE, once, and both forms
    read them. The bar's fill and the card's ring are the same quantity — time
    left over the total — so two animations of it could only ever disagree.
    Before F57 the bar drained on the UI thread and the card's ring stepped at
    4Hz from `remaining`, so expanding a smooth bar revealed a stepping clock.
  */
  const total = props.timer.total;
  const drainAt = useCallback((secondsLeft: number) => fractionOf(secondsLeft, total), [total]);
  const drain = useCountdownFraction(props.timer, remaining, drainAt, true);
  const run = props.run;
  const inRun = run != null && run.steps.length > 1;
  // The run bar FILLS, over the whole run, measured in time (`runProgress`) —
  // a different quantity from the drain, armed by the same rules.
  const runAt = useCallback(
    (secondsLeft: number) => (run ? runProgress(run, secondsLeft) : 0),
    [run],
  );
  const runFill = useCountdownFraction(props.timer, remaining, runAt, inRun);

  // Seeded to the form the surface opens in, so an arrival is the layer's own
  // fade and nothing else — no crossfade playing inside it.
  const swap = useSharedValue(expanded ? 1 : 0);
  // The first run has nothing to animate (the seed IS the target), so it arms
  // nothing: a timing to where the value already is would be one more
  // UI-thread animation per rest, and it would muddy the drain's own
  // "armed once" accounting in `timerContinuity.test.tsx`.
  const swapArmed = useRef(false);
  useEffect(() => {
    if (!swapArmed.current) {
      swapArmed.current = true;
      return;
    }
    swap.set(withTiming(expanded ? 1 : 0, SWAP_TIMING));
  }, [expanded, swap]);

  // The scale is the one piece of movement, so it is the piece Reduce Motion
  // removes. `null` — the OS has not answered — holds rather than guesses.
  const scaled = useReducedMotion() === false;
  const barStyle = useAnimatedStyle(() => ({
    opacity: 1 - swap.get(),
    transform: [{ scale: scaled ? SWAP_SCALE + (1 - SWAP_SCALE) * (1 - swap.get()) : 1 }],
  }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: swap.get(),
    transform: [{ scale: scaled ? SWAP_SCALE + (1 - SWAP_SCALE) * swap.get() : 1 }],
  }));

  return (
    <Animated.View
      // `box-none` so the area beside the collapsed bar is not a dead zone over
      // the list: a full-screen overlay that swallows touches is the classic way
      // a timer makes the screen behind it feel broken.
      //
      // No safe-area inset: this screen sits under a navigation header, which
      // has already cleared the status bar. Adding `insets.top` on top of that
      // would float the timer a status bar's height below where it belongs.
      pointerEvents="box-none"
      style={styles.layer}
      entering={ARRIVE}
      exiting={LEAVE}
      testID="countdown-layer"
    >
      {/*
        The form being shown stays in flow and sizes the layer; the other lies
        over it, absolutely positioned at the same top edge, so switching which
        one is in flow never moves either. The card renders after the bar, so
        it is on top while it fades in either direction.

        The hidden form takes no touches (`pointerEvents="none"`) and is hidden
        from VoiceOver and TalkBack — a half-faded button that still answered a
        tap, or a second set of controls read aloud, would be worse than the
        flash this replaces.
      */}
      <RNView pointerEvents="box-none">
        <Animated.View
          pointerEvents={expanded ? 'none' : 'box-none'}
          accessibilityElementsHidden={expanded}
          importantForAccessibility={expanded ? 'no-hide-descendants' : 'auto'}
          style={[styles.swapForm, expanded && styles.swapBehind, barStyle]}
          testID="countdown-form-bar"
        >
          <TimerBar {...props} drain={drain} />
        </Animated.View>
        <Animated.View
          pointerEvents={expanded ? 'box-none' : 'none'}
          accessibilityElementsHidden={!expanded}
          importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
          style={[styles.swapForm, !expanded && styles.swapBehind, cardStyle]}
          testID="countdown-form-card"
        >
          <TimerCard {...props} drain={drain} runFill={runFill} />
        </Animated.View>
      </RNView>
    </Animated.View>
  );
}

/** `remaining / total`, clamped to the track. */
function fractionOf(seconds: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, seconds / total)) : 0;
}

/**
 * The collapsed bar's drain — N558/#1047.
 *
 * It was a percentage-width flex child re-laid-out every 250ms by a screen-wide
 * re-render: a four-step-a-second stair, and ~360 renders per 90-second rest.
 * It is now ONE predetermined animation per change of the countdown itself,
 * running on the UI thread, which never asks React or Yoga for anything until
 * the countdown changes again.
 *
 * - **What moves**: `scaleX` on an absolutely positioned, childless fill with
 *   `transformOrigin: 'left'`. A transform, so no layout pass at all. (The fill
 *   has no corner radius, so `scaleX`'s one drawback — smearing a radius — does
 *   not arise.)
 * - **Which curve**: `Easing.linear` for the drain. Constant progress is the one
 *   place linear is correct: the bar IS a clock, and an eased clock lies.
 * - **When it is armed**: on a change of `timer` — start, ±15s, pause, resume,
 *   the next step of a run — never on a tick. Each re-arm starts from wherever
 *   the fill currently IS on screen (assigning a new animation to a shared value
 *   picks up its presentation value), bridges to the countdown's true position
 *   over `MS.control`, and then drains linearly to empty at the deadline. So +15s
 *   visibly grows the bar rather than snapping it, and a resume continues from
 *   the paused width rather than from the top.
 * - **Time source**: the countdown's own deadline (`endsAt` / `pausedWith`), the
 *   same model the digits read, so the bar and the digits reach zero together.
 *   A UI-thread timing animation is timestamp-based, so a backgrounded app comes
 *   back to the right width rather than resuming where it was suspended.
 *
 * ## Reduce Motion
 *
 * With Reduce Motion on — or before the OS has answered (`null`, see
 * `useReducedMotion`) — nothing is animated: the fill is SET to the current
 * fraction on each digit repaint, which is exactly the bar's pre-N558 behaviour,
 * minus the screen-wide re-render. It is state indication, not decoration, so
 * it stays; it just steps instead of gliding.
 *
 * `reduceMotion: ReduceMotion.Never` on the timings is deliberate and is not a
 * bypass. The decision has already been made in JavaScript by the LIVE hook.
 * Reanimated's `System` reads a launch-time snapshot instead, so an athlete who
 * turned Reduce Motion OFF mid-session would have every drain "reduced" to its
 * destination — an empty bar for the whole rest, the one failure worse than a
 * stair.
 */
/**
 * F57/#1140 — `Drain`'s arming, lifted into a hook so it runs ONCE per surface.
 *
 * Everything in the doc comment above still holds, word for word: a transform
 * on a childless absolute fill, linear to the deadline, armed on a change of
 * the countdown and never on a tick, the first arm jumping and later arms
 * bridging from the value on screen, Reduce Motion (and an unanswered OS)
 * stepping with the digits instead. What changed is WHO reads the value: the
 * bar's fill, the card's ring, and — through a second call with `runProgress` —
 * the run bar. `fractionAt(secondsLeft)` is what the fraction is at a given
 * amount of time left; the animation heads for `fractionAt(0)` at the deadline.
 *
 * `active: false` arms nothing and writes nothing, which is what keeps a lone
 * rest (no run) from spending UI-thread animations on a bar that isn't shown.
 * It also FORGETS that it armed: a set tick with auto-rest on ends a run
 * without closing the surface, so a second run can bring the run bar back
 * within one mount, and bridging from the fill the old run left behind would
 * glide backwards across the bar (found in review). It jumps instead.
 */
function useCountdownFraction(
  timer: Countdown,
  remaining: number,
  fractionAt: (secondsLeft: number) => number,
  active: boolean,
): SharedValue<number> {
  const reduced = useReducedMotion();
  // Seeded from the digits' value so a form that mounts with a rest already
  // under way shows its true position on its first frame.
  const value = useSharedValue(fractionAt(remaining));
  /*
    Whether this has armed since the surface mounted. The FIRST arm jumps to the
    true position instead of bridging, because on a fresh rest the seed above is
    stale: the countdown's clock publishes in an effect that runs after this
    first render, so `remaining` can still be 0 (or the last rest's value).
    Bridging from that seed would refill the bar from empty over 180ms at the
    start of every rest (found in review). Re-arms after that — ±15s, pause,
    resume, the next step — bridge from the value that is really on screen.
  */
  const armed = useRef(false);

  useEffect(() => {
    if (!active) {
      armed.current = false;
      return;
    }
    if (reduced !== false) return;
    const first = !armed.current;
    armed.current = true;
    const leftMs = remainingAt(timer, Date.now()) * 1000;
    const bridgeMs = first ? 0 : Math.min(MS.control, leftMs);
    const bridge = {
      duration: first ? 0 : MS.control,
      easing: EASE_OUT,
      reduceMotion: ReduceMotion.Never,
    };

    if (timer.pausedWith != null || leftMs <= 0) {
      // Frozen, or spent: settle on the true position and stay there.
      value.set(withTiming(fractionAt(leftMs / 1000), bridge));
      return;
    }

    // Two legs, one assignment: the bridge (zero-length on a first arm), then
    // the linear leg to where the fraction is at the deadline.
    value.set(
      withSequence(
        withTiming(fractionAt((leftMs - bridgeMs) / 1000), { ...bridge, duration: bridgeMs }),
        withTiming(fractionAt(0), {
          duration: leftMs - bridgeMs,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
      ),
    );
  }, [timer, reduced, value, active, fractionAt]);

  useEffect(() => {
    // Assigning a plain value also cancels an animation in flight, which is
    // what makes turning Reduce Motion ON mid-rest stop the glide immediately.
    if (active && reduced !== false) value.set(fractionAt(remaining));
  }, [active, reduced, remaining, value, fractionAt]);

  return value;
}

/** The collapsed bar's fill: reads the surface's drain, arms nothing itself. */
function DrainFill({ drain, color }: { drain: SharedValue<number>; color: string }) {
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: drain.get() }] }));
  return (
    <RNView style={styles.track}>
      <Animated.View
        style={[styles.fill, { backgroundColor: color }, fill]}
        testID="countdown-drain"
      />
    </RNView>
  );
}

/**
 * The card's run bar, since F57 a `scaleX` fill read from the surface's
 * `runFill` rather than an animated `width: %` repainted — and re-laid-out —
 * on every 250ms tick. A separate component because `useAnimatedStyle` is a
 * hook and the bar only exists inside a run.
 */
function RunFill({ runFill, color }: { runFill: SharedValue<number>; color: string }) {
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: runFill.get() }] }));
  return (
    <Animated.View
      style={[styles.runFill, { backgroundColor: color }, style]}
      testID="countdown-run-fill"
    />
  );
}

/**
 * The ring.
 *
 * Two circles: a full track, and the progress arc drawn on top with
 * `strokeDasharray` at the full circumference and a `strokeDashoffset` that
 * grows as time drains. Rotated -90° so it empties from twelve o'clock, which is
 * where every clock anybody has ever read starts.
 *
 * `strokeLinecap="round"` on the arc only. On the track it would leave two blunt
 * ends meeting at the top on a full circle.
 */
function Ring({
  size,
  stroke,
  drain,
  color,
  opacity,
  children,
}: {
  size: number;
  stroke: number;
  /** The surface's drain (F57/#1140) — the same value the collapsed bar reads. */
  drain: SharedValue<number>;
  color: string;
  opacity: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // On the UI thread: the arc unwinds continuously with the drain instead of
  // stepping on the 250ms repaint, and React is not asked for a frame.
  const arc = useAnimatedProps(() => ({
    strokeDashoffset: c * (1 - Math.max(0, Math.min(1, drain.get()))),
  }));
  return (
    <RNView style={{ width: size, height: size }}>
      <Svg
        width={size}
        height={size}
        style={styles.ring}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={vola.line}
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeOpacity={opacity}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          animatedProps={arc}
          fill="none"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <RNView style={styles.ringCentre}>{children}</RNView>
    </RNView>
  );
}

function TimerCard({
  minimized,
  timer,
  remaining,
  run,
  drain,
  runFill,
  onMinimize,
  onAdjust,
  onTogglePause,
  onStop,
  onSkip,
}: TimerControls & { drain: SharedValue<number>; runFill: SharedValue<number> }) {
  const accent = useAccent();
  const copy = countdownCopy(timer.kind);
  const done = remaining <= 0;
  const paused = timer.pausedWith != null;
  const step = stepOf(timer);
  const adjustable = isAdjustable(timer.kind);
  const inRun = run != null && run.steps.length > 1;

  return (
    <View
      style={styles.card}
      testID="countdown-timer"
      // Modal by intent, and now modal to VoiceOver too: without this the
      // focus order walks straight past the card into the set list behind it,
      // mid-timed-set, which is the one moment the timer IS the screen. The
      // collapsed bar deliberately does not do this — it is a status strip
      // over a list you are still meant to be using.
      //
      // Modal ONLY while the card is the form on screen (F55/#1134). The card
      // now stays mounted behind the bar when minimised; its wrapper is hidden
      // from assistive technology, but a view that stays modal while hidden is
      // exactly how a screen reader gets trapped, so this does not rely on
      // iOS resolving the two the right way round.
      accessibilityViewIsModal={!minimized}
    >
      <RNView style={styles.cardHead}>
        <RNView style={styles.kindRow}>
          <RNView style={[styles.kindDot, { backgroundColor: accent.accent }]} />
          <Text style={[styles.kind, { color: accent.ink }]}>{copy.title.toUpperCase()}</Text>
        </RNView>
        <PressableScale
          onPress={onMinimize}
          hitSlop={12}
          style={styles.headButton}
          accessibilityRole="button"
          accessibilityLabel="Minimise the timer"
          testID="countdown-minimize"
        >
          <Icon name="minimise" size={18} color={vola.textMuted} />
        </PressableScale>
      </RNView>

      <Ring
        size={196}
        stroke={12}
        drain={drain}
        color={accent.accent}
        opacity={RING_OPACITY[timer.kind]}
      >
        <Text style={styles.clock} testID="countdown-remaining">
          {formatCountdown(remaining)}
        </Text>
        <Text style={styles.clockSub} numberOfLines={1}>
          {paused ? 'Paused' : done ? copy.doneCaption : timer.label}
        </Text>
      </Ring>

      {inRun && (
        <Text style={styles.runLine}>
          {/* The run's own position, which the per-interval ring cannot show:
              the ring is about this forty seconds, and this is about the other
              three sets still to come. */}
          Set {run.steps[run.at].ordinal} of {run.steps[run.at].total}
        </Text>
      )}
      {inRun && (
        <RNView style={styles.runTrack}>
          <RunFill runFill={runFill} color={accent.accent} />
        </RNView>
      )}

      <RNView style={styles.controls}>
        <PressableScale
          onPress={() => onAdjust(-step)}
          disabled={!adjustable}
          style={[styles.adjust, !adjustable && styles.off]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !adjustable }}
          accessibilityLabel={`Take ${step} seconds off`}
          testID="countdown-minus"
        >
          <Text style={styles.adjustText}>−{step}</Text>
        </PressableScale>

        <PressableScale
          onPress={onTogglePause}
          disabled={!adjustable}
          style={[
            styles.playPause,
            { backgroundColor: accent.accent },
            !adjustable && styles.off,
          ]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !adjustable }}
          accessibilityLabel={
            paused
              ? `Paused with ${formatCountdown(remaining)} left. Resume.`
              : `${formatCountdown(remaining)} left. Pause.`
          }
          testID="countdown-toggle"
        >
          <Icon name={paused ? 'play' : 'pause'} size={22} color={accent.on} strokeWidth={2} />
        </PressableScale>

        <PressableScale
          onPress={() => onAdjust(step)}
          disabled={!adjustable}
          style={[styles.adjust, !adjustable && styles.off]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !adjustable }}
          accessibilityLabel={`Add ${step} seconds`}
          testID="countdown-plus"
        >
          <Text style={styles.adjustText}>+{step}</Text>
        </PressableScale>
      </RNView>

      <RNView style={styles.footer}>
        {inRun && (
          <PressableScale
            onPress={onSkip}
            style={styles.footerButton}
            accessibilityRole="button"
            accessibilityLabel={
              timer.kind === 'work'
                ? 'Finish this set now and log the time so far'
                : `Skip this ${copy.title.toLowerCase()}`
            }
            testID="countdown-next"
          >
            <Text style={[styles.footerText, { color: accent.ink }]}>
              {timer.kind === 'work' ? 'Done early' : 'Skip'}
            </Text>
          </PressableScale>
        )}
        <PressableScale
          onPress={onStop}
          style={styles.footerButton}
          accessibilityRole="button"
          accessibilityLabel={done ? 'Dismiss the timer' : inRun ? 'End the run' : copy.stopHint}
          testID="countdown-skip"
        >
          <Text style={styles.footerStop}>{done ? 'Done' : inRun ? 'End' : copy.stop}</Text>
        </PressableScale>
      </RNView>
    </View>
  );
}

/**
 * The collapsed form — the shape the old bottom bar had, moved to the top.
 *
 * Deliberately the same controls and the same testIDs as the card, because they
 * are the same timer: an athlete who minimised a rest still needs ±, pause and
 * skip without expanding it first, and a test should not have to know which form
 * is on screen to press pause.
 */
function TimerBar({
  timer,
  remaining,
  run,
  drain,
  onExpand,
  onAdjust,
  onTogglePause,
  onStop,
  onSkip,
}: TimerControls & { drain: SharedValue<number> }) {
  const accent = useAccent();
  const copy = countdownCopy(timer.kind);
  const done = remaining <= 0;
  const paused = timer.pausedWith != null;
  const step = stepOf(timer);
  const adjustable = isAdjustable(timer.kind);
  const inRun = run != null && run.steps.length > 1;

  return (
    <View style={styles.bar} testID="countdown-timer">
      <RNView style={styles.barRow}>
        <PressableScale
          onPress={onExpand}
          hitSlop={8}
          style={styles.barLabel}
          accessibilityRole="button"
          accessibilityLabel={`${copy.title}. ${formatCountdown(remaining)} left. Expand the timer.`}
          testID="countdown-expand"
        >
          <RNView style={[styles.kindDot, { backgroundColor: accent.accent }]} />
          <Text style={[styles.barKind, { color: accent.ink }]}>{copy.title}</Text>
        </PressableScale>

        <PressableScale
          onPress={onExpand}
          style={styles.barClockTap}
          accessibilityRole="button"
          accessibilityLabel={`${formatCountdown(remaining)} left. Expand the timer.`}
          testID="countdown-remaining-tap"
        >
          <Text style={styles.barClock} testID="countdown-remaining">
            {done ? copy.done : formatCountdown(remaining)}
          </Text>
          <Text style={styles.barCaption} numberOfLines={1}>
            {paused ? 'Paused' : done ? copy.doneCaption : timer.label}
            {run && run.steps.length > 1
              ? ` · ${run.steps[run.at].ordinal}/${run.steps[run.at].total}`
              : ''}
          </Text>
        </PressableScale>

        <PressableScale
          onPress={() => onAdjust(-step)}
          disabled={!adjustable}
          hitSlop={6}
          style={[styles.barChip, !adjustable && styles.off]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !adjustable }}
          accessibilityLabel={`Take ${step} seconds off`}
          testID="countdown-minus"
        >
          <Text style={styles.barChipText}>−{step}</Text>
        </PressableScale>
        <PressableScale
          onPress={() => onAdjust(step)}
          disabled={!adjustable}
          hitSlop={6}
          style={[styles.barChip, !adjustable && styles.off]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !adjustable }}
          accessibilityLabel={`Add ${step} seconds`}
          testID="countdown-plus"
        >
          <Text style={styles.barChipText}>+{step}</Text>
        </PressableScale>
        <PressableScale
          onPress={onTogglePause}
          disabled={!adjustable}
          hitSlop={6}
          style={[styles.barPlay, { backgroundColor: accent.accent }, !adjustable && styles.off]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !adjustable }}
          accessibilityLabel={paused ? 'Resume' : 'Pause'}
          testID="countdown-toggle"
        >
          <Icon name={paused ? 'play' : 'pause'} size={14} color={accent.on} strokeWidth={2.2} />
        </PressableScale>
        {/*
          Inside a run the bar gets BOTH controls, and that is a bug fix rather
          than parity for its own sake.

          It used to render one button labelled "Skip" wired to `onStop`. Every
          rest step of a guided run opens minimised, so that button was the
          default presentation of the feature's main loop — and tapping the
          thing that says "Skip the rest" ended the entire workout. There was
          also no way to advance a minimised step at all without expanding it
          first, which is precisely the state an athlete mid-circuit is in.
        */}
        {inRun && (
          <PressableScale
            onPress={onSkip}
            hitSlop={6}
            style={styles.barStop}
            accessibilityRole="button"
            accessibilityLabel={
              timer.kind === 'work'
                ? 'Finish this set now and log the time so far'
                : `Skip this ${copy.title.toLowerCase()}`
            }
            testID="countdown-next"
          >
            <Text style={[styles.barStopText, { color: accent.ink }]}>
              {timer.kind === 'work' ? 'Done' : 'Skip'}
            </Text>
          </PressableScale>
        )}
        <PressableScale
          onPress={onStop}
          hitSlop={6}
          style={styles.barStop}
          accessibilityRole="button"
          accessibilityLabel={
            done ? 'Dismiss the timer' : inRun ? 'End the run' : copy.stopHint
          }
          testID="countdown-skip"
        >
          <Text style={styles.barStopText}>
            {done ? 'Done' : inRun ? 'End' : copy.stop}
          </Text>
        </PressableScale>
      </RNView>

      {/* Drains left to right. Readable from across a gym without reading the
          number at all — the one thing the collapsed form kept from the bar it
          replaces. Continuously, on the UI thread, since N558 — see `Drain`. */}
      <DrainFill drain={drain} color={accent.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', top: 6, left: 0, right: 0, paddingHorizontal: 10 },
  // F55: both forms scale from the edge the layer is pinned to, so the card
  // opens DOWN from where the bar sits rather than growing about its centre
  // (a 380pt card scaled from the centre moves its top edge ~6pt).
  swapForm: { transformOrigin: 'top' },
  swapBehind: { position: 'absolute', top: 0, left: 0, right: 0 },

  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    paddingTop: 12,
    paddingBottom: 14,
    alignItems: 'center',
    // Lifts the card off the list behind it without a scrim — a scrim would
    // dim the log, and the log is what the timer is about.
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  kindRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  kindDot: { width: 7, height: 7, borderRadius: 4 },
  kind: { fontSize: 11, fontWeight: '800', letterSpacing: 1.6 },
  headButton: { minWidth: 34, minHeight: 34, alignItems: 'center', justifyContent: 'center' },

  ring: { position: 'absolute', top: 0, left: 0 },
  ringCentre: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Tabular figures: without them the whole row jitters as digits change,
  // which is the cheapest way to make a timer feel cheap.
  clock: { fontSize: 46, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 0.5 },
  clockSub: {
    fontSize: 12,
    color: vola.textMuted,
    marginTop: 2,
    maxWidth: 140,
    textAlign: 'center',
  },

  runLine: { fontSize: 12, color: vola.textMuted, marginTop: 10, fontWeight: '600' },
  runTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: vola.line,
    alignSelf: 'stretch',
    marginHorizontal: 28,
    marginTop: 8,
    overflow: 'hidden',
  },
  // F57: absolutely positioned and childless, so scaling it touches no layout;
  // `transformOrigin: 'left'` makes it grow rightward the way the width did.
  runFill: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '100%', transformOrigin: 'left' },

  controls: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 },
  adjust: {
    minWidth: 62,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
  },
  adjustText: { fontWeight: '700', fontSize: 15, fontVariant: ['tabular-nums'] },
  playPause: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  off: { opacity: 0.3 },

  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  footerButton: {
    minHeight: 42,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: vola.surfaceRaised,
  },
  footerText: { fontWeight: '700', fontSize: 14 },
  footerStop: { fontWeight: '700', fontSize: 14, color: vola.textMuted },

  bar: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  barLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  barKind: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  barClockTap: { flex: 1, paddingHorizontal: 4 },
  barClock: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  barCaption: { fontSize: 10, color: vola.textDim },
  barChip: {
    minWidth: 40,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: vola.line,
  },
  barChipText: { fontWeight: '700', fontSize: 12, fontVariant: ['tabular-nums'] },
  barPlay: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  barStop: {
    minHeight: 34,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: vola.surfaceRaised,
  },
  barStopText: { fontWeight: '700', fontSize: 12, color: vola.textMuted },

  track: { height: 3, backgroundColor: vola.line, width: '100%', overflow: 'hidden' },
  // Absolutely positioned and childless, so animating it touches no layout: the
  // track's size never depends on the fill. `transformOrigin` pins the scale to
  // the left edge, so it drains toward the left like the width did.
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '100%',
    transformOrigin: 'left',
  },
});
