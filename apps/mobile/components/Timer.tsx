import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { countdownCopy } from '@/components/Countdown';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { formatCountdown, isAdjustable, stepOf, type Countdown } from '@/lib/countdown';
import { runProgress, type Run } from '@/lib/intervalRun';

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
 * The EXPANDED card deliberately gets no such padding: it is modal by intent —
 * it is what you are looking at during a timed set — and pushing 380pt of log
 * down and back up every time a countdown starts and finishes would make the
 * screen jump under the thumb between every set.
 */
export const TIMER_BAR_SPACE = 64;

export function TimerSurface(props: TimerControls) {
  return (
    <RNView
      // `box-none` so the area beside the collapsed bar is not a dead zone over
      // the list: a full-screen overlay that swallows touches is the classic way
      // a timer makes the screen behind it feel broken.
      //
      // No safe-area inset: this screen sits under a navigation header, which
      // has already cleared the status bar. Adding `insets.top` on top of that
      // would float the timer a status bar's height below where it belongs.
      pointerEvents="box-none"
      style={styles.layer}
    >
      {props.minimized ? <TimerBar {...props} /> : <TimerCard {...props} />}
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
        <Pressable
          onPress={onMinimize}
          hitSlop={12}
          style={styles.headButton}
          accessibilityRole="button"
          accessibilityLabel="Minimise the timer"
          testID="countdown-minimize"
        >
          <Icon name="minimise" size={18} color={vola.textMuted} />
        </Pressable>
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
        <Pressable
          onPress={() => onAdjust(-step)}
          disabled={!adjustable}
          style={[styles.adjust, !adjustable && styles.off]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !adjustable }}
          accessibilityLabel={`Take ${step} seconds off`}
          testID="countdown-minus"
        >
          <Text style={styles.adjustText}>−{step}</Text>
        </Pressable>

        <Pressable
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
        </Pressable>

        <Pressable
          onPress={() => onAdjust(step)}
          disabled={!adjustable}
          style={[styles.adjust, !adjustable && styles.off]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !adjustable }}
          accessibilityLabel={`Add ${step} seconds`}
          testID="countdown-plus"
        >
          <Text style={styles.adjustText}>+{step}</Text>
        </Pressable>
      </RNView>

      <RNView style={styles.footer}>
        {inRun && (
          <Pressable
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
          </Pressable>
        )}
        <Pressable
          onPress={onStop}
          style={styles.footerButton}
          accessibilityRole="button"
          accessibilityLabel={done ? 'Dismiss the timer' : inRun ? 'End the run' : copy.stopHint}
          testID="countdown-skip"
        >
          <Text style={styles.footerStop}>{done ? 'Done' : inRun ? 'End' : copy.stop}</Text>
        </Pressable>
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
  const progress = timer.total > 0 ? remaining / timer.total : 0;
  const inRun = run != null && run.steps.length > 1;

  return (
    <View style={styles.bar} testID="countdown-timer">
      <RNView style={styles.barRow}>
        <Pressable
          onPress={onExpand}
          hitSlop={8}
          style={styles.barLabel}
          accessibilityRole="button"
          accessibilityLabel={`${copy.title}. ${formatCountdown(remaining)} left. Expand the timer.`}
          testID="countdown-expand"
        >
          <RNView style={[styles.kindDot, { backgroundColor: accent.accent }]} />
          <Text style={[styles.barKind, { color: accent.ink }]}>{copy.title}</Text>
        </Pressable>

        <Pressable
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
        </Pressable>

        <Pressable
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
        </Pressable>
        <Pressable
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
        </Pressable>
        <Pressable
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
        </Pressable>
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
          <Pressable
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
          </Pressable>
        )}
        <Pressable
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
        </Pressable>
      </RNView>

      {/* Drains left to right. Readable from across a gym without reading the
          number at all — the one thing the collapsed form kept from the bar it
          replaces. */}
      <RNView style={styles.track}>
        <RNView
          style={[
            styles.fill,
            { width: `${Math.max(0, Math.min(1, progress)) * 100}%`, backgroundColor: accent.accent },
          ]}
        />
      </RNView>
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

  track: { height: 3, backgroundColor: vola.line, width: '100%' },
  fill: { height: 3 },
});
