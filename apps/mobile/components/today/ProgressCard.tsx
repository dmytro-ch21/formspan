import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { Radius, Spacing, TOUCH_MIN } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import { shiftDate, trendWeight, type Measured } from '@/lib/anthropometry';
import { PHASE_LABELS, type Checkin, type Phase } from '@/lib/body';
import {
  MIN_SPARK_POINTS,
  SPARK_DAYS,
  sparkPolyline,
  sparkWeek,
  type SparkPoint,
} from '@/lib/sparkWeek';
import { formatWeight, weightUnitName, toDisplayWeight, type UnitSystem } from '@/lib/units';

/**
 * `PROGRESS` — bodyweight, its direction, and the phase it sits inside.
 *
 * ## Units come from the profile, never from the reference
 *
 * The reference reads `207.5 lb` and `↓ 1.2 lb this week`. That is one athlete's
 * setting, not the design. Every figure here goes through
 * {@link formatWeight}/{@link toDisplayWeight} with the athlete's own
 * {@link UnitSystem}, and **nothing renders until `unitsReady`** — printing
 * kilograms for one frame to somebody who thinks in pounds is the exact bug
 * #483 closed, and this screen was named in that ticket as the place it would
 * come back.
 *
 * Screen readers get {@link weightUnitName} (`pounds`), never the abbreviation:
 * VoiceOver reads `lb` as "L B".
 *
 * ## Both ends of the delta are trends, never raw readings
 *
 * `lib/anthropometry.ts` exists for this: a day-to-day difference is mostly
 * water, and an athlete reading a 1.2 kg overnight "gain" as fat is the failure
 * the smoothing prevents. So the figure is {@link trendWeight} today minus
 * {@link trendWeight} a week ago, and it is **absent rather than approximated**
 * when either end lacks the readings to smooth.
 *
 * ## Two buttons, not one (W26, #1230)
 *
 * The body opens `/goals/trend`; a "Record weight" row beneath it opens
 * today's check-in. N108 rebuilt Today from a reference image with no
 * check-in button and dropped the one-tap weigh-in, so a daily action took
 * two taps through the trend screen. A reference that does not show an action
 * is not a decision to remove it. The row is a sibling of the body, never
 * nested in it — see the comment at the row.
 */
export type ProgressCardProps = {
  checkins: Checkin[];
  phase: Phase | null;
  today: string;
  units: UnitSystem;
  unitsReady: boolean;
  /** False until the check-in read settles. Absence is not zero. */
  loaded: boolean;
  /** The card's body: opens the readable trend. */
  onOpen: () => void;
  /**
   * The "Record weight" row: opens today's check-in. Offered in every state,
   * including `Checking…` — logging a weight does not depend on having read
   * the old ones.
   */
  onRecordWeight: () => void;
  testID?: string;
};

const SPARK_W = 132;
/** Height of the PLOT. The letter row below it is `SPARK_AXIS_H` on top. */
const SPARK_H = 52;
const SPARK_INSET = 7;
const SPARK_PAD = 9;
/** The `M T W T F S S` row. Tall enough for the filled disc that marks today. */
const SPARK_AXIS_H = 17;
/**
 * Width of one letter's box.
 *
 * The slots are spaced by `sparkWeek`'s own step — `(SPARK_W - 2 * SPARK_INSET)
 * / (SPARK_DAYS - 1)`, i.e. 19.67 — NOT by `SPARK_W / SPARK_DAYS`, which is a
 * different number (18.9) and was what this comment used to cite. 18 is under
 * the real step, so adjacent boxes never touch.
 *
 * Each box is centred on its slot (`left: x - SPARK_SLOT / 2`), so the outer
 * two reach 2pt past the nominal 132pt width at each end. Nothing clips — no
 * ancestor sets `overflow: 'hidden'`, and the card's body has 14pt of padding
 * and a 12pt column gap for it to sit in — but a future change to `SPARK_INSET`
 * or `SPARK_W` has to be made against the step above, not against this constant.
 */
const SPARK_SLOT = 18;
/** The Record weight row's plus. 14, the size MomentumCard's link rows use for their glyphs. */
const RECORD_ICON = 14;

export function ProgressCard({
  checkins,
  phase,
  today,
  units,
  unitsReady,
  loaded,
  onOpen,
  onRecordWeight,
  testID,
}: ProgressCardProps) {
  const now = trendWeight(checkins, today);
  const weekAgo = trendWeight(checkins, shiftDate(today, -SPARK_DAYS));
  const delta = now != null && weekAgo != null ? now - weekAgo : null;

  const ready = loaded && unitsReady;

  return (
    <RNView style={styles.card}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={progressLabel(now, delta, phase, units, ready)}
        style={({ pressed }) => [styles.body, pressed && styles.pressed]}
        testID={testID}
      >
        <RNView style={styles.left}>
          <Text style={styles.eyebrow}>PROGRESS</Text>

          {!ready ? (
            <Text style={styles.absent}>Checking…</Text>
          ) : now == null ? (
            // Not a zero and not a dash pretending to be a number. Three
            // readings inside a week is what a trend needs; saying so is more
            // use than an em dash.
            <Text style={styles.absent} testID="progress-empty">
              Weigh in for a few days and the trend appears here
            </Text>
          ) : (
            <>
              <Text style={styles.weight}>{formatWeight(now, units)}</Text>
              {delta == null ? (
                <Text style={styles.deltaAbsent}>Not enough readings to compare</Text>
              ) : (
                <RNView style={styles.deltaRow}>
                  {/*
                    A TEXT arrow, not an icon, and that is the fix rather than a
                    style choice. The icon set has `chevron-down` and no
                    `chevron-up`, so a weight GAIN was rendering with the
                    right-pointing disclosure chevron — direction-free, and read
                    as a navigation affordance — while a loss got a real
                    down-arrow. The direction of a measured number existed only
                    in the accessibility label, for exactly one of the two
                    directions.

                    Deliberately uncoloured: up is not failure and down is not
                    success, and which one an athlete wants depends on the phase
                    sitting directly underneath this line.
                  */}
                  <Text style={styles.deltaArrow}>{delta < 0 ? '↓' : '↑'}</Text>
                  <Text style={styles.delta}>
                    {formatWeight(Math.abs(delta), units)} this week
                  </Text>
                </RNView>
              )}
            </>
          )}

          {phase ? (
            <PhasePill phase={phase} checkins={checkins} today={today} ready={ready} />
          ) : null}
        </RNView>

        <Spark checkins={checkins} today={today} ready={ready} />
      </Pressable>

      {/*
        W26 (#1230): the weigh-in, one tap from Today. N108 rebuilt this card
        as a single button onto the trend, and a daily action became two taps
        through another screen.

        A SIBLING of the body, never a child of it. A Pressable is one
        accessibility element, so a button nested inside it is grouped away:
        VoiceOver reads the outer label and the inner control cannot be
        focused. Side by side, they are two buttons with two labels.

        Rendered in every state, `Checking…` included: recording today's
        weight does not depend on having read the old ones, and the empty
        state's own copy tells the athlete to weigh in.
      */}
      <Pressable
        onPress={onRecordWeight}
        accessibilityRole="button"
        accessibilityLabel="Record weight"
        accessibilityHint="Opens today's check-in"
        style={({ pressed }) => [styles.record, pressed && styles.pressed]}
        testID={testID ? `${testID}-record` : undefined}
      >
        <Icon name="plus" size={RECORD_ICON} color={vola.lime} />
        <Text style={styles.recordLabel}>Record weight</Text>
      </Pressable>
    </RNView>
  );
}

/**
 * The phase, and how far through it the athlete is.
 *
 * The reference shows `CUTTING`. **The label comes from `PHASE_LABELS`**, which
 * says `Cut` — this app already has a vocabulary for phases and a second one on
 * one screen is how two surfaces start disagreeing about the same fact.
 *
 * The percentage is shown **only when there is a target to be a percentage of.**
 * A maintenance phase has no number to hit, and `68% of the way` to an unstated
 * destination is a fabricated figure.
 */
function PhasePill({
  phase,
  checkins,
  today,
  ready,
}: {
  phase: Phase;
  checkins: Measured[];
  today: string;
  ready: boolean;
}) {
  const label = PHASE_LABELS[phase.kind].label;
  const pct = phaseProgress(phase, checkins, today);

  return (
    <RNView style={styles.phaseRow}>
      <RNView style={styles.phasePill}>
        <Text style={styles.phaseLabel}>{label.toUpperCase()}</Text>
      </RNView>
      {ready && pct != null ? (
        <Text style={styles.phasePct}>{Math.round(pct)}% of the way</Text>
      ) : null}
    </RNView>
  );
}

/**
 * How far between the phase's starting trend and its target weight.
 *
 * Null whenever any of the three inputs is missing, and clamped to 0–100 so a
 * phase that has overshot does not report 115% — the phase is done at that
 * point, which the number 100 says perfectly well.
 */
export function phaseProgress(
  phase: Phase,
  checkins: Measured[],
  today: string,
): number | null {
  if (phase.target_weight_kg == null) return null;
  const start = trendWeight(checkins, phase.started_on);
  const now = trendWeight(checkins, today);
  if (start == null || now == null) return null;
  const span = phase.target_weight_kg - start;
  // A phase that starts at its own target has no journey to be a fraction of.
  if (Math.abs(span) < 0.05) return null;
  return Math.max(0, Math.min(100, ((now - start) / span) * 100));
}

/**
 * The 7-day line — the reference (`~/Desktop/trend-face.jpeg`, N201/#637) in
 * the space this card has for it.
 *
 * Five things make it that chart rather than a sparkline, and each is here for
 * a reason the reference states by showing it:
 *
 * - **`M T W T F S S` beneath the line**, so a dot is a day rather than a
 *   position in a list;
 * - **today marked**, in a filled disc, because "is the last dot today or
 *   Thursday" is the first question anybody asks of a week;
 * - **drop-lines** from each point to the foot of the plot, which is what ties
 *   a dot to its letter across a gap of empty space;
 * - **a glow under the line** — two wider, low-opacity passes of the same
 *   stroke, not a shadow. `MacroRings` records that the user rejected a bloom
 *   around the RINGS, twice; this is the one place they asked for it, in their
 *   own reference, in the words *"The trend should nicely be shown as I gave
 *   you the reference, period."* Both are honoured by keeping the glow here
 *   and out of there.
 * - **the latest reading ringed** rather than filled, so the newest fact is
 *   the one the eye lands on.
 *
 * ## The x-positions are dates, and that is the whole point
 *
 * See {@link sparkWeek}. This used to place point `i` at `i / (n - 1)` of the
 * width — its INDEX — which draws the same picture for "weighed in every day"
 * and "weighed in four times", and would put those four readings under four
 * letters that are not their days the moment an axis appeared. A missing day
 * is a gap here, and a gap is the honest drawing.
 *
 * ## What has not changed
 *
 * Raw readings, not the smoothed trend: at a week's width the smoothing has
 * nothing to work with, and the dots are the evidence behind the figure on the
 * left rather than a second claim. And **fewer than two readings draws nothing
 * at all** — not the line, and not the letters either, because an axis under
 * an absent chart is scaffolding for something that is not there.
 */
function Spark({
  checkins,
  today,
  ready,
}: {
  checkins: Measured[];
  today: string;
  ready: boolean;
}) {
  const { days, points, baseline } = sparkWeek(checkins, today, {
    width: SPARK_W,
    height: SPARK_H,
    inset: SPARK_INSET,
    pad: SPARK_PAD,
  });

  if (!ready || points.length < MIN_SPARK_POINTS) {
    return (
      <RNView style={styles.spark}>
        <Text style={styles.sparkAbsent}>{ready ? 'No trend yet' : ''}</Text>
      </RNView>
    );
  }

  const line = sparkPolyline(points);

  return (
    <RNView
      style={styles.spark}
      testID="today-spark-wrap"
      /*
        One card, one announcement. The Pressable above already says the
        weight, the direction and the phase; seven single letters and eight
        dots read out individually is noise on top of an answer already given.
      */
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={styles.sparkLabel}>{SPARK_DAYS}-day trend</Text>
      <Svg width={SPARK_W} height={SPARK_H} testID="today-spark">
        {/*
          Drop-lines first, so the line and its dots sit on top of them. Faint
          on purpose: they exist to carry the eye down to a letter, and a
          full-strength rule per point would draw a grid nobody asked for.
        */}
        {points.map((p) => (
          <Line
            key={`drop-${p.on}`}
            x1={p.x}
            y1={p.y}
            x2={p.x}
            y2={baseline}
            stroke={vola.lime}
            strokeOpacity={0.22}
            strokeWidth={1}
          />
        ))}

        {/*
          The glow: the same polyline twice more, wider and dimmer, under the
          real one. Two passes rather than a blur — `react-native-svg` filters
          are not uniformly supported on this app's runtime, and a shadow
          would be a `shadow*`/`elevation` prop, which is the treatment
          `MacroRings` records as refused. Both passes are `vola.lime`, which
          has a mono twin, so a monochrome build gets a grey halo rather than
          the one green thing in a black-and-white app.
        */}
        <Polyline
          points={line}
          fill="none"
          stroke={vola.lime}
          strokeOpacity={0.1}
          strokeWidth={9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Polyline
          points={line}
          fill="none"
          stroke={vola.lime}
          strokeOpacity={0.2}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Polyline
          points={line}
          fill="none"
          stroke={vola.lime}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {points.map((p) => (
          <SparkDot key={p.on} point={p} />
        ))}
      </Svg>

      {/*
        The axis. Absolutely positioned on the SAME x each point was placed at,
        rather than seven flexed boxes: a flex row would space the letters
        evenly by its own arithmetic, which is only accidentally the grid the
        points were drawn on, and would drift the moment either changes.
      */}
      <RNView style={styles.axis} testID="today-spark-axis">
        {days.map((d, i) => (
          <RNView
            key={d.on}
            testID={`today-spark-day-${i}`}
            style={[styles.axisSlot, { left: d.x - SPARK_SLOT / 2 }]}
          >
            {d.isToday ? (
              <RNView style={styles.axisToday} testID="today-spark-today">
                <Text style={styles.axisTodayLetter} testID={`today-spark-letter-${i}`}>
                  {d.letter}
                </Text>
              </RNView>
            ) : (
              <Text style={styles.axisLetter} testID={`today-spark-letter-${i}`}>
                {d.letter}
              </Text>
            )}
          </RNView>
        ))}
      </RNView>
    </RNView>
  );
}

/**
 * One reading.
 *
 * The latest is a RING with a halo, every other one a filled disc — the
 * reference's own emphasis, and the right way round: the newest fact is the
 * one being reported, and an outline reads as "here" where a bigger blob just
 * reads as heavier.
 */
function SparkDot({ point }: { point: SparkPoint }) {
  if (!point.latest) {
    return (
      <Circle
        cx={point.x}
        cy={point.y}
        r={2.5}
        fill={vola.lime}
        testID={`today-spark-point-${point.on}`}
      />
    );
  }
  return (
    <>
      <Circle cx={point.x} cy={point.y} r={7} fill={vola.lime} fillOpacity={0.18} />
      <Circle
        cx={point.x}
        cy={point.y}
        r={4.5}
        // The card's own ground, not `transparent`: the glow pass underneath
        // would otherwise show through the middle of the ring and fill it in.
        fill={vola.surface}
        stroke={vola.lime}
        strokeWidth={2.5}
        testID={`today-spark-point-${point.on}`}
      />
    </>
  );
}

function progressLabel(
  now: number | null,
  delta: number | null,
  phase: Phase | null,
  units: UnitSystem,
  ready: boolean,
): string {
  if (!ready) return 'Progress, still loading';
  if (now == null) return 'Progress. No weight trend yet — weigh in for a few days.';
  const unit = weightUnitName(units);
  const parts = [`Progress. ${toDisplayWeight(now, units)} ${unit}`];
  if (delta != null) {
    parts.push(
      `${delta < 0 ? 'down' : 'up'} ${toDisplayWeight(Math.abs(delta), units)} ${unit} this week`,
    );
  }
  if (phase) parts.push(PHASE_LABELS[phase.kind].label);
  return parts.join(', ');
}

const styles = StyleSheet.create({
  // The visual card. Not pressable itself: it holds the two buttons.
  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.card,
  },
  // Each button rounds its own outer corners to the card's radius, so a
  // press tint follows the card's shape. `overflow: 'hidden'` on the card
  // would do the same, and would break the "nothing clips" guarantee
  // SPARK_SLOT's comment gives the axis letters.
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.cardPadding,
    paddingVertical: Spacing.cardPadding,
    borderTopLeftRadius: Radius.card,
    borderTopRightRadius: Radius.card,
  },
  pressed: { backgroundColor: vola.surfaceHover },
  // Full card width and at least TOUCH_MIN tall, so it clears the 44pt floor
  // by its own size. No hitSlop, which would reach up into the body's target.
  record: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xsPlus,
    minHeight: TOUCH_MIN,
    paddingHorizontal: Spacing.cardPadding,
    borderTopWidth: 1,
    borderTopColor: vola.line,
    borderBottomLeftRadius: Radius.card,
    borderBottomRightRadius: Radius.card,
  },
  // `vola.lime`, as elsewhere on this card (the phase pill, the trend line).
  recordLabel: { ...Typography.emphasis, color: vola.lime },
  left: { flex: 1, gap: 3 },
  eyebrow: { ...Typography.eyebrow, color: vola.textMuted },
  // 32, not `display`: the card's one hero figure, with its own tight leading.
  weight: {
    fontSize: 32,
    fontWeight: '800',
    color: vola.text,
    fontVariant: ['tabular-nums'],
    lineHeight: 36,
  },
  deltaRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xxs },
  deltaArrow: { ...Typography.meta, color: vola.textMuted },
  delta: { ...Typography.meta, color: vola.textMuted, fontVariant: ['tabular-nums'] },
  deltaAbsent: { ...Typography.caption, color: vola.textDim, fontWeight: '400' },
  absent: { ...Typography.meta, color: vola.textDim, maxWidth: 190 },

  // Wraps, so the percentage drops under the pill rather than running into the
  // spark: `MAKING WEIGHT` plus "100% of the way" is wider than this column,
  // and was before N561 moved the label onto `Typography.eyebrow`'s tracking.
  phaseRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xsPlus,
  },
  phasePill: {
    borderWidth: 1,
    borderColor: vola.lime,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.smPlus,
    paddingVertical: 3,
  },
  phaseLabel: { ...Typography.eyebrow, color: vola.lime },
  phasePct: {
    ...Typography.caption,
    color: vola.textMuted,
    fontVariant: ['tabular-nums'],
    fontWeight: '400',
  },

  spark: { width: SPARK_W, alignItems: 'flex-end', gap: Spacing.xs, justifyContent: 'center' },
  sparkLabel: { ...Typography.caption, color: vola.textDim },
  sparkAbsent: { ...Typography.caption, color: vola.textDim, fontWeight: '400' },

  axis: { width: SPARK_W, height: SPARK_AXIS_H },
  axisSlot: {
    position: 'absolute',
    top: 0,
    width: SPARK_SLOT,
    height: SPARK_AXIS_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `textMuted`, not `textDim`: this is the label a value is read against, and
  // the axis on `/goals/trend` is the same weight. Dim is for absences.
  // 11 is the scale's floor, not a role: these are single glyphs in a 17pt row
  // and a 15pt disc, where `eyebrow`'s tracking or `caption`'s 12pt would crowd.
  axisLetter: { fontSize: Typography.eyebrow.fontSize, color: vola.textMuted, fontWeight: '600' },
  axisToday: {
    width: 15,
    height: 15,
    borderRadius: Radius.sm,
    backgroundColor: vola.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The app's ground on the accent, which is the pairing `accents.green.on`
  // states — the accent is never dark enough for white text.
  // The same 11pt floor as `axisLetter`, for the same reason.
  axisTodayLetter: { fontSize: Typography.eyebrow.fontSize, color: vola.bg, fontWeight: '800' },
});
