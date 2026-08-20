import { useMemo } from 'react';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { daysBetween } from '@/lib/anthropometry';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { trendBounds, type Projection, type TrendSeries } from '@/lib/trendSeries';

/**
 * The trend chart itself — one drawing, every metric.
 *
 * Everything about WHAT the numbers mean lives in `lib/trendSeries.ts`; this
 * file only turns a series into paths. That split is the reason it can be
 * shared: per-exercise load and body mass disagree about smoothing, units and
 * what a goal is, and agree completely about how a line with a hole in it is
 * drawn.
 *
 * ## Why it may carry labels at all
 *
 * CLAUDE.md's mobile carve-out forbade "axes to read values off" until the user
 * struck that on 2026-08-19 (N57). The rule was meant to keep *analysis* off
 * the phone and instead produced a 105-line chart with no axis labels, no value
 * labels and no point labels — their verdict was "pretty much useless". A chart
 * you cannot read a number off answers no question in three seconds, so the
 * athlete goes to a desk anyway, which is what the carve-out existed to
 * prevent. Value-readable axes, first/latest point labels, a dashed projection
 * to a dashed goal line and an entries list are now all permitted.
 *
 * **What still disqualifies this is unchanged**: a second metric, or a
 * date-range picker — a control choosing a start AND an end. The range chips
 * are seven PRESETS that all end today, `Plan` included, which is one question
 * asked at seven depths rather than a comparison.
 */

/** Drawn width. Fixed by the viewBox rather than measured, so the chart never
 * needs a layout pass and cannot flash at the wrong size on first render. */
const W = 320;
const PAD_Y = 18;
const DOT = 1.8;

export type TrendChartProps = {
  series: TrendSeries;
  /** The metric's goal, in the metric's own unit. Null when none is set. */
  goal?: number | null;
  projection?: Projection;
  /** Formats a value for a label — unit conversion belongs to the caller. */
  format: (value: number) => string;
  /** Smallest y-axis span, in the metric's unit. Stops a flat series dividing by zero. */
  minSpan: number;
  height?: number;
  /** Short labels for the three x-axis ticks: start, middle, today. */
  axisLabels?: [string, string, string];
  accessibilityLabel: string;
  testID?: string;
};

export function TrendChart({
  series,
  goal = null,
  projection,
  format,
  minSpan,
  height = 150,
  axisLabels,
  accessibilityLabel,
  testID,
}: TrendChartProps) {
  const accent = useAccent();
  const H = height;

  const bounds = useMemo(() => trendBounds(series, { minSpan, goal }), [series, minSpan, goal]);

  const dataSpan = Math.max(1, daySpan(series));
  const projected = projection?.kind === 'projected' ? projection : null;

  /**
   * How far past today the chart draws.
   *
   * Capped at the window's own span, so the future can never take more than
   * half the width. Uncapped, a goal eighteen months out would squash a month
   * of real readings into a sliver and the athlete would be reading mostly
   * empty space.
   *
   * The cap is also what makes the drawing honest: when arrival falls beyond
   * the cap the dashed line EXITS THE RIGHT EDGE still travelling, rather than
   * being bent to meet the goal line inside the box. A projection that visibly
   * lands is one that lands within the period shown; anything else says "not
   * yet, keep going", which is true.
   */
  // Floored at 0. A server derivation that predates a fresh weigh-in can hand
  // back a `reached_on` BEFORE the latest reading, making `daysAway` negative —
  // which would shrink the domain, clip points past the right edge, and draw
  // the dashed line BACKWARD to the goal, visually claiming an arrival behind
  // the latest point. One token, and it cannot happen.
  const futureDays = projected ? Math.max(0, Math.min(projected.daysAway, dataSpan)) : 0;
  const totalSpan = dataSpan + futureDays;

  const x = (day: number) => (day / totalSpan) * W;
  const y = (value: number) =>
    bounds
      ? H - PAD_Y - ((value - bounds.min) / (bounds.max - bounds.min)) * (H - PAD_Y * 2)
      : H / 2;

  // One path per segment. The breaks between them are days the metric had too
  // little behind it — drawn as gaps, because a line chart's default is to
  // interpolate and inventing a fortnight of weigh-ins is worse than a hole.
  const paths = series.segments
    .filter((s) => s.length > 1)
    .map((s) => s.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day)},${y(p.value)}`).join(' '));
  // A one-day segment has no line but is still a real day of data, so it is
  // drawn as a dot rather than dropped.
  const lonely = series.segments.filter((s) => s.length === 1).map((s) => s[0]);

  const first = series.readings[0] ?? null;
  const latest = series.readings[series.readings.length - 1] ?? null;

  // Where the dashed projection ends. Exact arrival when it fits inside the
  // cap; otherwise the value it has reached at the cap, so the slope stays true
  // rather than being bent toward a target it does not reach on screen.
  const projEnd =
    projected && goal != null && latest
      ? projected.daysAway <= futureDays
        ? { day: latest.day + projected.daysAway, value: goal }
        : {
            day: latest.day + futureDays,
            value: latest.value + (goal - latest.value) * (futureDays / projected.daysAway),
          }
      : null;

  const ticks: { at: number; label: string }[] = axisLabels
    ? [
        { at: 0, label: axisLabels[0] },
        { at: Math.round((dataSpan - 1) / 2), label: axisLabels[1] },
        { at: dataSpan - 1, label: axisLabels[2] },
      ]
    : [];

  return (
    <Svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {/* The goal line, dashed and labelled with the target. Dashed because it
          is a target rather than a measurement, and the same stroke as the
          projection for the same reason — the two dashed marks are the two
          things on this chart nobody has actually stood on a scale for. */}
      {goal != null && bounds ? (
        <G>
          <Line
            x1={0}
            x2={W}
            y1={y(goal)}
            y2={y(goal)}
            stroke={vola.line}
            strokeWidth={1}
            strokeDasharray="4 4"
            testID="trend-goal-line"
          />
          <SvgText x={W - 2} y={y(goal) - 4} fontSize={10} fill={vola.line} textAnchor="end">
            {format(goal)}
          </SvgText>
        </G>
      ) : null}

      {/* The projection. Same dash as the goal line, deliberately: it is a
          claim about the future and must not read as a measurement. The screen
          states what it assumed — see the projection sentence. */}
      {projEnd && latest ? (
        <Path
          d={`M${x(latest.day)},${y(latest.value)} L${x(projEnd.day)},${y(projEnd.value)}`}
          stroke={accent.accent}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          fill="none"
          opacity={0.8}
          testID="trend-projection"
        />
      ) : null}

      {series.readings.map((p) => (
        <Circle key={`${p.on}-r`} cx={x(p.day)} cy={y(p.value)} r={DOT} fill={vola.line} opacity={0.9} />
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
        <Circle key={`${p.on}-t`} cx={x(p.day)} cy={y(p.value)} r={3} fill={accent.accent} />
      ))}

      {/* The two callouts read the RAW READING, never the smoothed line. An
          athlete who steps off a scale and sees a different number on the card
          than the scale gave them will not trust either. The line is the trend;
          these are the measurements. */}
      {first && bounds ? (
        <Callout x={x(first.day)} y={y(first.value)} text={format(first.value)} filled accent={accent.accent} on={accent.on} />
      ) : null}
      {latest && bounds && latest !== first ? (
        <Callout x={x(latest.day)} y={y(latest.value)} text={format(latest.value)} filled accent={accent.accent} on={accent.on} />
      ) : null}

      {ticks.map((t) => (
        <SvgText
          key={t.label + t.at}
          x={clamp(x(t.at), 12, W - 12)}
          y={H - 3}
          fontSize={10}
          fill={vola.line}
          textAnchor="middle"
        >
          {t.label}
        </SvgText>
      ))}
    </Svg>
  );
}

/** A value label sitting on its point. */
function Callout({
  x,
  y,
  text,
  filled,
  accent,
  on,
}: {
  x: number;
  y: number;
  text: string;
  filled: boolean;
  accent: string;
  on: string;
}) {
  const w = Math.max(26, text.length * 6 + 10);
  const h = 16;
  // Kept inside the box on both axes. A callout on the newest point sits at the
  // right edge by definition, and an unclamped one would be half off-screen —
  // which is exactly the point the athlete most wants to read.
  const cx = clamp(x, w / 2, W - w / 2);
  const cy = clamp(y - 14, h / 2 + 1, undefined);
  return (
    <G>
      <Circle cx={x} cy={y} r={3} fill={accent} />
      <Rect
        x={cx - w / 2}
        y={cy - h / 2}
        width={w}
        height={h}
        rx={5}
        fill={filled ? accent : 'transparent'}
      />
      <SvgText
        x={cx}
        y={cy + 4}
        fontSize={11}
        fontWeight="600"
        fill={filled ? on : accent}
        textAnchor="middle"
      >
        {text}
      </SvgText>
    </G>
  );
}

function clamp(v: number, min: number, max?: number): number {
  const lo = Math.max(v, min);
  return max == null ? lo : Math.min(lo, max);
}

/**
 * Days from the window's START to its END, inclusive — from the series' own
 * `from`/`to`, never from where the data happens to stop.
 *
 * It used to measure the points, and that cropped a TRAILING gap out of
 * existence. `trendWeight` returns null once the last seven days hold too few
 * readings, so for anybody who stopped logging a week ago both the dots and the
 * line end early, the axis shrank to the last data day, and the tick the screen
 * labels "Today" landed on a reading that could be weeks old. A trailing gap
 * has to render as a gap like any other — and a lapsed logger is exactly who
 * the "Record Weight" action is for. Found by review.
 */
function daySpan(series: TrendSeries): number {
  return daysBetween(series.from, series.to) + 1;
}
