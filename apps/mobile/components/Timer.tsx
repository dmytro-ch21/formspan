import { useEffect } from 'react';
import { StyleSheet, View as RNView } from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  FadeOut,
  FadeOutUp,
  Keyframe,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
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
  N558/#1047 — the four layout animations, built once at module scope.

  Gate: a rest starts ~20 times a session, which is the "tens of times" band —
  so nothing here is longer than `MS.control`, exits are faster than entries,
  and none of it is a spring (no finger carried velocity in). Purpose: spatial
  consistency. The bar used to materialise between two frames; now it arrives
  from just above its own slot and leaves the way it came.

  Every builder carries `ReduceMotion.System`, so with Reduce Motion on each one
  is skipped outright: the surface appears in place, the space it appears into
  was already reserved (see `timerSpaceFor`), and so nothing teleports and
  nothing moves. Note what `System` reads: Reanimated's snapshot of the setting
  at app launch, not a live subscription. Toggling Reduce Motion with the app
  open reaches these builders on the next launch. The DRAIN below does not use
  `System` for exactly that reason — see `Drain`.

  `FadeInDown` rather than the audit's `SlideInUp`: in Reanimated 4.5.1
  `SlideInUp` starts at `-windowHeight` (measured in
  `layoutReanimation/defaultAnimations/Slide.ts`), which in 180ms is a
  ~5,000pt/s fly-in across the header, twenty times a session. `FadeInDown` is a
  25pt slide into the slot under an opacity ramp — it still reads as "from
  above", and it is over before the eye goes looking for it.
*/
const EASE_OUT = Easing.bezier(...EASE.out);

const ARRIVE = FadeInDown.duration(MS.control).easing(EASE_OUT).reduceMotion(ReduceMotion.System);
const LEAVE = FadeOutUp.duration(MS.press).easing(EASE_OUT).reduceMotion(ReduceMotion.System);

/**
 * Bar ↔ card. A crossfade, with the incoming form settling up from
 * `SWAP_SCALE`, so it reads as one surface changing size rather than two
 * surfaces cutting. Opacity and scale only: both are compositor properties, and
 * the layer is absolutely positioned, so the log behind never re-lays-out.
 */
const SWAP_IN = new Keyframe({
  0: { opacity: 0, transform: [{ scale: SWAP_SCALE }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE_OUT },
})
  .duration(MS.control)
  .reduceMotion(ReduceMotion.System);
const SWAP_OUT = FadeOut.duration(MS.press).easing(EASE_OUT).reduceMotion(ReduceMotion.System);

/**
 * The surface's props. `remaining` is NOT one of them — the surface subscribes
 * to the countdown's clock itself, so the 250ms tick re-renders this subtree
 * and not the screen that mounts it. See `RemainingClock` in `Countdown.tsx`.
 */
export type TimerSurfaceProps = Omit<TimerControls, 'remaining'> & { clock: RemainingClock };

export function TimerSurface({ clock, ...controls }: TimerSurfaceProps) {
  const remaining = useRemaining(clock);
  const props: TimerControls = { ...controls, remaining };
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
        `skipEntering` / `skipExiting`: when the whole surface arrives or leaves,
        the layer's own animation is the one that plays. Without this the child's
        swap animation would run on top of it — a fade inside a fade — on every
        rest. The swap animations are for the swap, which is a change of child
        while the layer stays mounted.

        Keyed so React replaces the child rather than reconciling a bar into a
        card — the replacement is what lets the outgoing form fade out while the
        incoming one fades in.
      */}
      <LayoutAnimationConfig skipEntering skipExiting>
        {props.minimized ? (
          <Animated.View key="bar" pointerEvents="box-none" entering={SWAP_IN} exiting={SWAP_OUT}>
            <TimerBar {...props} />
          </Animated.View>
        ) : (
          <Animated.View key="card" pointerEvents="box-none" entering={SWAP_IN} exiting={SWAP_OUT}>
            <TimerCard {...props} />
          </Animated.View>
        )}
      </LayoutAnimationConfig>
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
function Drain({ timer, remaining, color }: { timer: Countdown; remaining: number; color: string }) {
  const reduced = useReducedMotion();
  // Seeded from the digits' value so a bar remounted by minimise shows its true
  // width on its first frame instead of refilling from full.
  const drain = useSharedValue(fractionOf(remaining, timer.total));

  useEffect(() => {
    if (reduced !== false) return;
    const now = Date.now();
    const leftMs = remainingAt(timer, now) * 1000;
    const bridgeMs = Math.min(MS.control, leftMs);
    const bridge = {
      duration: MS.control,
      easing: EASE_OUT,
      reduceMotion: ReduceMotion.Never,
    };

    if (timer.pausedWith != null || leftMs <= 0) {
      // Frozen, or spent: settle on the true width and stay there.
      drain.set(withTiming(fractionOf(leftMs / 1000, timer.total), bridge));
      return;
    }

    drain.set(
      withSequence(
        withTiming(fractionOf((leftMs - bridgeMs) / 1000, timer.total), {
          ...bridge,
          duration: bridgeMs,
        }),
        withTiming(0, {
          duration: leftMs - bridgeMs,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
      ),
    );
  }, [timer, reduced, drain]);

  useEffect(() => {
    // Assigning a plain value also cancels a drain in flight, which is what
    // makes turning Reduce Motion ON mid-rest stop the glide immediately.
    if (reduced !== false) drain.set(fractionOf(remaining, timer.total));
  }, [reduced, remaining, timer.total, drain]);

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
  progress,
  color,
  opacity,
  children,
}: {
  size: number;
  stroke: number;
  progress: number;
  color: string;
  opacity: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, progress));
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
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeOpacity={opacity}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          // Rounded to a tenth of a point: React Native re-renders the SVG on
          // every distinct value, and the 250ms repaint would otherwise push a
          // new float through the native bridge four times a second for a
          // difference nobody can see.
          strokeDashoffset={Math.round(c * (1 - clamped) * 10) / 10}
          fill="none"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <RNView style={styles.ringCentre}>{children}</RNView>
    </RNView>
  );
}

function TimerCard({
  timer,
  remaining,
  run,
  onMinimize,
  onAdjust,
  onTogglePause,
  onStop,
  onSkip,
}: TimerControls) {
  const accent = useAccent();
  const copy = countdownCopy(timer.kind);
  const done = remaining <= 0;
  const paused = timer.pausedWith != null;
  const step = stepOf(timer);
  const adjustable = isAdjustable(timer.kind);
  const progress = timer.total > 0 ? remaining / timer.total : 0;
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
      accessibilityViewIsModal
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
        progress={progress}
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
          <RNView
            style={[
              styles.runFill,
              {
                width: `${runProgress(run, remaining) * 100}%`,
                backgroundColor: accent.accent,
              },
            ]}
          />
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
  onExpand,
  onAdjust,
  onTogglePause,
  onStop,
  onSkip,
}: TimerControls) {
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
      <Drain timer={timer} remaining={remaining} color={accent.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', top: 6, left: 0, right: 0, paddingHorizontal: 10 },

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
  runFill: { height: 3, borderRadius: 2 },

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
