import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { MIN_TREND_READINGS, type Measured } from '@/lib/anthropometry';
import { formatWeight, toDisplayWeight, weightUnit, type UnitSystem } from '@/lib/units';
import {
  buildTrendSeries,
  RANGES,
  trendBounds,
  type TrendPoint,
  type TrendRange,
} from '@/lib/weightTrend';

/**
 * The weight trend, on the phone.
 *
 * ## Why this is on mobile at all
 *
 * The platform rule sends analysis to web, and this is the first deliberate
 * exception to it — see CLAUDE.md, which now names the test rather than the
 * verdict. A chart you read in three seconds to answer "is what I am doing
 * working" is decision support, and the decision it supports (eat more, hold,
 * push the cut) is made in a kitchen or a supermarket, not at a desk. The
 * analytical version — comparing phases, exporting, correlating with training
 * load — stays on web and is not this.
 *
 * The consequence is that this is deliberately SMALL: three ranges, one metric,
 * no axes to read off, no tooltips, no zoom. Everything that would make it a
 * report rather than a glance was left out on purpose. If it grows a second
 * metric selector it has become the web screen and should move.
 *
 * ## Two series
 *
 * The faint dots are the readings; the solid line is the seven-day mean. Body
 * mass swings 1–2 kg inside a day, so the dots exist to show how noisy the
 * underlying data is — an athlete who sees only a smooth line will read a
 * two-day wobble as a trend, and one who sees only dots cannot read a direction
 * at all. `lib/weightTrend.ts` builds both; the arithmetic is
 * `lib/anthropometry.ts`'s and is not duplicated here.
 *
 * ## The line breaks where the data does
 *
 * A gap in weigh-ins renders as a gap. See the segment note in
 * `lib/weightTrend.ts` — this component just draws one path per segment, which
 * is the whole mechanism.
 */

const H = 140;
const PAD_Y = 10;
/** Radius of a reading dot. Small — they are texture, not the subject. */
const DOT = 1.8;

export function WeightTrend({
  checkins,
  today,
  units,
}: {
  checkins: Measured[];
  today: string;
  units: UnitSystem;
}) {
  const accent = useAccent();
  const [range, setRange] = useState<TrendRange>('month');
  // Width is fixed by the viewBox rather than measured: the SVG scales to its
  // container, so the drawing never needs a layout pass and cannot flash at the
  // wrong size on first render.
  const W = 320;

  const series = useMemo(
    () => buildTrendSeries(checkins, today, range),
    [checkins, today, range],
  );
  const bounds = useMemo(() => trendBounds(series), [series]);

  const span = Math.max(1, RANGE_LEN(series.from, series.to));
  const x = (p: TrendPoint) => (p.day / span) * W;
  const y = (kg: number) =>
    bounds ? H - PAD_Y - ((kg - bounds.min) / (bounds.max - bounds.min)) * (H - PAD_Y * 2) : H / 2;

  const paths = series.segments
    // A single point has no line to draw, but it is still a real day of data —
    // drawn as a dot below rather than dropped, so a week with one qualifying
    // day does not render as an empty box.
    .filter((seg) => seg.length > 1)
    .map((seg) => seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p)},${y(p.kg)}`).join(' '));
  const lonely = series.segments.filter((seg) => seg.length === 1).map((seg) => seg[0]);

  const enough = series.segments.length > 0;

  return (
    <View style={styles.card}>
      <RNView style={styles.head}>
        <Text style={styles.title}>WEIGHT</Text>
        <RNView style={styles.ranges}>
          {RANGES.map((r) => {
            const on = r.key === range;
            return (
              <Pressable
                key={r.key}
                onPress={() => setRange(r.key)}
                hitSlop={8}
                style={[styles.range, on && { backgroundColor: accent.accent }]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`Show the last ${r.label.toLowerCase()}`}
                testID={`trend-range-${r.key}`}
              >
                <Text style={[styles.rangeText, on && { color: accent.ink }]}>{r.label}</Text>
              </Pressable>
            );
          })}
        </RNView>
      </RNView>

      {enough ? (
        <>
          <Text style={styles.delta} testID="trend-delta">
            {series.deltaKg == null
              ? // Not "0 kg". The line does not reach both edges of the window,
                // so the honest answer is that this range cannot be summarised
                // — see `deltaKg`.
                `Not enough of this ${range} to compare`
              : `${series.deltaKg > 0 ? '+' : ''}${round1(
                  toDisplayWeight(series.deltaKg, units),
                )} ${weightUnit(units)} this ${range}`}
          </Text>
          <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
            {series.readings.map((p) => (
              <Circle
                key={`${p.on}-r`}
                cx={x(p)}
                cy={y(p.kg)}
                r={DOT}
                fill={vola.line}
                opacity={0.9}
              />
            ))}
            {paths.map((d) => (
              <Path
                key={d.slice(0, 24)}
                d={d}
                stroke={accent.accent}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            ))}
            {lonely.map((p) => (
              <Circle key={`${p.on}-t`} cx={x(p)} cy={y(p.kg)} r={3} fill={accent.accent} />
            ))}
          </Svg>
          <RNView style={styles.foot}>
            <Text style={styles.bound}>{formatWeight(bounds ? bounds.min : null, units)}</Text>
            <Text style={styles.bound}>{formatWeight(bounds ? bounds.max : null, units)}</Text>
          </RNView>
        </>
      ) : (
        // The same honesty the check-in card uses: say there is not enough
        // rather than drawing a confident line through two points.
        <Text style={styles.empty} testID="trend-empty">
          {`Weigh in on ${MIN_TREND_READINGS} days and the trend appears here.`}
        </Text>
      )}
    </View>
  );
}

/** Days between the window's ends, so `day` maps onto the full width. */
function RANGE_LEN(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: 1, borderColor: vola.line, padding: 14, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 12, letterSpacing: 1, opacity: 0.6 },
  ranges: { flexDirection: 'row', gap: 6 },
  range: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: vola.line },
  rangeText: { fontSize: 12 },
  delta: { fontSize: 15 },
  foot: { flexDirection: 'row', justifyContent: 'space-between' },
  bound: { fontSize: 11, opacity: 0.5 },
  empty: { fontSize: 14, opacity: 0.7, paddingVertical: 24, textAlign: 'center' },
});
