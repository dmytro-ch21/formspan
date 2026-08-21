import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { daysBetween, shiftDate, trendWeight, type Measured } from '@/lib/anthropometry';
import { PHASE_LABELS, type Checkin, type Phase } from '@/lib/body';
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
 */
export type ProgressCardProps = {
  checkins: Checkin[];
  phase: Phase | null;
  today: string;
  units: UnitSystem;
  unitsReady: boolean;
  /** False until the check-in read settles. Absence is not zero. */
  loaded: boolean;
  onOpen: () => void;
  testID?: string;
};

const SPARK_DAYS = 7;
const SPARK_W = 132;
const SPARK_H = 58;

export function ProgressCard({
  checkins,
  phase,
  today,
  units,
  unitsReady,
  loaded,
  onOpen,
  testID,
}: ProgressCardProps) {
  const now = trendWeight(checkins, today);
  const weekAgo = trendWeight(checkins, shiftDate(today, -SPARK_DAYS));
  const delta = now != null && weekAgo != null ? now - weekAgo : null;

  const ready = loaded && unitsReady;

  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={progressLabel(now, delta, phase, units, ready)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
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

        {phase ? <PhasePill phase={phase} checkins={checkins} today={today} ready={ready} /> : null}
      </RNView>

      <Spark checkins={checkins} today={today} ready={ready} />
    </Pressable>
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
 * The 7-day line.
 *
 * Raw readings, not the smoothed trend — at a week's width the smoothing has
 * nothing to work with, and the dots are the evidence behind the figure on the
 * left rather than a second claim. Fewer than two readings draws nothing at
 * all: a single dot is not a line, and a flat line through one point asserts a
 * stability nobody measured.
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
  const pts = checkins
    .filter((c) => {
      if (c.weight_kg == null || c.weight_kg <= 0) return false;
      const age = daysBetween(c.measured_on, today);
      return age >= 0 && age < SPARK_DAYS;
    })
    .sort((a, b) => a.measured_on.localeCompare(b.measured_on));

  if (!ready || pts.length < 2) {
    return (
      <RNView style={styles.spark}>
        <Text style={styles.sparkAbsent}>{ready ? 'No trend yet' : ''}</Text>
      </RNView>
    );
  }

  const values = pts.map((p) => p.weight_kg as number);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A perfectly flat week would divide by zero; give it a hair of range so the
  // line sits in the middle rather than at the top.
  const span = hi - lo < 0.01 ? 1 : hi - lo;

  const x = (i: number) => (pts.length === 1 ? SPARK_W / 2 : (i / (pts.length - 1)) * (SPARK_W - 10) + 5);
  const y = (v: number) => SPARK_H - 10 - ((v - lo) / span) * (SPARK_H - 20);

  const points = pts.map((p, i) => `${x(i)},${y(p.weight_kg as number)}`).join(' ');
  const lastIdx = pts.length - 1;

  return (
    <RNView style={styles.spark}>
      <Text style={styles.sparkLabel}>7-day trend</Text>
      <Svg width={SPARK_W} height={SPARK_H}>
        <Polyline
          points={points}
          fill="none"
          stroke={vola.lime}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {pts.map((p, i) => (
          <Circle
            key={p.measured_on}
            cx={x(i)}
            cy={y(p.weight_kg as number)}
            r={i === lastIdx ? 4 : 2.5}
            fill={i === lastIdx ? vola.lime : vola.surface}
            stroke={vola.lime}
            strokeWidth={i === lastIdx ? 2 : 1.5}
          />
        ))}
      </Svg>
    </RNView>
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
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  pressed: { backgroundColor: vola.surfaceHover },
  left: { flex: 1, gap: 3 },
  eyebrow: { fontSize: 10, letterSpacing: 1, color: vola.textMuted, fontWeight: '700' },
  weight: {
    fontSize: 32,
    fontWeight: '800',
    color: vola.text,
    fontVariant: ['tabular-nums'],
    lineHeight: 36,
  },
  deltaRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  deltaArrow: { fontSize: 13, color: vola.textMuted },
  delta: { fontSize: 13, color: vola.textMuted, fontVariant: ['tabular-nums'] },
  deltaAbsent: { fontSize: 12, color: vola.textDim },
  absent: { fontSize: 13, color: vola.textDim, maxWidth: 190 },

  phaseRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  phasePill: {
    borderWidth: 1,
    borderColor: vola.lime,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  phaseLabel: { fontSize: 10, fontWeight: '700', color: vola.lime, letterSpacing: 0.6 },
  phasePct: { fontSize: 12, color: vola.textMuted, fontVariant: ['tabular-nums'] },

  spark: { width: SPARK_W, alignItems: 'flex-end', gap: 4, justifyContent: 'center' },
  sparkLabel: { fontSize: 10, color: vola.textDim },
  sparkAbsent: { fontSize: 11, color: vola.textDim },
});
