import { useMemo } from 'react';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { shiftDate } from '@/lib/anthropometry';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  CHART_WIDTH,
  clipSegment,
  leaderEnd,
  placeLabels,
  plotBounds,
  plotBox,
  plotWindow,
  type BoxRequest,
  type PlacedBox,
  type Pt,
} from '@/lib/trendChartLayout';
import type { Projection, TrendPoint, TrendSeries } from '@/lib/trendSeries';

/**
 * The trend chart itself — one drawing, every metric.
 *
 * Everything about WHAT the numbers mean lives in `lib/trendSeries.ts` and
 * everything about WHERE a mark goes lives in `lib/trendChartLayout.ts`; this
 * file turns the two answers into elements and does no geometry of its own.
 * That split is the reason it can be shared: per-exercise load and body mass
 * disagree about smoothing, units and what a goal is, and agree completely
 * about how a line with a hole in it is drawn.
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
 * asked at seven depths rather than a comparison. The left edge tightening onto
 * sparse data (W12) is not a picker either: nobody chooses it, and the right
 * edge is still today.
 *
 * ## W12 — what the second report was actually about
 *
 * *"The trend graphs are broken and ugly, overlapping and not understandable."*
 * The headline was that the dots and the line looked like two different
 * y-scales. They never were — both have always gone through one `y()` — but
 * three separate things conspired to make that the honest reading, and all
 * three are fixed in `lib/trendChartLayout.ts`:
 *
 * - **The goal owned the axis.** Readings spanning 206.0–207.8 lb against a
 *   190 lb goal put every mark inside y 31.7–46.1 of a 200px chart. 1.8 lb of
 *   real movement got 14px, under labels 16px tall.
 * - **There was no y-axis**, so nothing said how big a swing was; a 4 lb week
 *   and a 40 lb year drew identically.
 * - **The labels sat on the line and on each other**, so the two things you
 *   could read were covering the thing they described.
 */

const DOT = 2.2;

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
  /**
   * Formats a `YYYY-MM-DD` for an x-axis tick.
   *
   * A FUNCTION rather than three finished strings, which is what it used to be.
   * The chart now decides its own left edge — a window that is mostly empty
   * tightens onto the data — so a caller computing the labels from the window's
   * nominal start would print dates the drawing does not use. That is the
   * axis-labels-lie failure with the sign flipped, and handing the formatting
   * in rather than the result makes it unreachable.
   */
  formatDate?: (on: string) => string;
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
  formatDate,
  accessibilityLabel,
  testID,
}: TrendChartProps) {
  const accent = useAccent();
  const H = height;
  const box = useMemo(() => plotBox(H), [H]);

  const bounds = useMemo(() => plotBounds(series, { minSpan, goal }), [series, minSpan, goal]);
  const win = useMemo(() => plotWindow(series), [series]);

  const projected = projection?.kind === 'projected' ? projection : null;

  /**
   * Days until arrival, clamped once and used everywhere below.
   *
   * A server derivation that predates a fresh weigh-in hands back a
   * `reached_on` BEFORE the latest reading, making `daysAway` negative. The
   * first version of this fix floored the DOMAIN only — and review caught that
   * `projEnd` still read the raw value, so `-3 <= 0` held, and the dashed line
   * was drawn BACKWARD from the latest reading to the goal: an arrival behind
   * the athlete, which is the exact lie the floor was added to prevent. A
   * partial clamp with a comment claiming completeness is worse than none.
   *
   * Zero is treated as no projection rather than as arrival today: it would
   * otherwise draw a degenerate vertical dash, which reads as a cliff.
   */
  const daysAway = projected ? Math.max(0, projected.daysAway) : 0;
  const dataSpan = Math.max(1, win.toDay - win.fromDay + 1);
  /**
   * How far past today the chart draws.
   *
   * Capped at the plotted span, so the future can never take more than half the
   * width. Uncapped, a goal eighteen months out would squash a month of real
   * readings into a sliver. The cap is also what makes the drawing honest: when
   * arrival falls beyond it the dashed line EXITS THE RIGHT EDGE still
   * travelling, rather than being bent to meet the goal line inside the box.
   */
  const futureDays = Math.min(daysAway, dataSpan);

  // Divided by the last INDEX, not the count. Day indices run 0..span-1, so
  // dividing by the count left the final day a full day-width short of the
  // right edge — sub-pixel over a year, but ~14% of the width at 1W.
  const lastIndex = Math.max(1, win.toDay + futureDays - win.fromDay);
  const plotW = box.right - box.left;
  const x = (day: number) => box.left + ((day - win.fromDay) / lastIndex) * plotW;
  const y = (value: number) =>
    bounds
      ? box.bottom - ((value - bounds.min) / (bounds.max - bounds.min)) * (box.bottom - box.top)
      : (box.top + box.bottom) / 2;

  const px = (p: TrendPoint): Pt => ({ x: x(p.day), y: y(p.value) });
  const inWindow = (p: TrendPoint) => p.day >= win.fromDay;

  // One path per segment. The breaks between them are days the metric had too
  // little behind it — drawn as gaps, because a line chart's default is to
  // interpolate and inventing a fortnight of weigh-ins is worse than a hole.
  const runs = series.segments.map((s) => s.filter(inWindow)).filter((s) => s.length > 0);
  const linePts: Pt[][] = runs.filter((s) => s.length > 1).map((s) => s.map(px));
  // A one-day segment has no line but is still a real day of data, so it is
  // drawn as a dot rather than dropped.
  const lonely: Pt[] = runs.filter((s) => s.length === 1).map((s) => px(s[0]));

  const readings = series.readings.filter(inWindow);
  const first = readings[0] ?? null;
  const latest = readings[readings.length - 1] ?? null;

  // Where the dashed projection ends. Exact arrival when it fits inside the
  // cap; otherwise the value it has reached at the cap, so the slope stays true
  // rather than being bent toward a target it does not reach on screen.
  const projEnd =
    projected && goal != null && latest && daysAway > 0
      ? daysAway <= futureDays
        ? { day: latest.day + daysAway, value: goal }
        : {
            day: latest.day + futureDays,
            value: latest.value + (goal - latest.value) * (futureDays / daysAway),
          }
      : null;
  // Clipped to the plot, because a goal below the axis (see `goalInside`) puts
  // the far end of this line under the date ticks. It exits the edge still
  // travelling, which is the true statement: not yet, keep going.
  const projLine =
    projEnd && latest ? clipSegment(px(latest as TrendPoint), { x: x(projEnd.day), y: y(projEnd.value) }, box) : null;

  const goalY = goal != null && bounds?.goalInside ? y(goal) : null;

  // Everything a label must not cover: the trend line, the projection, and the
  // goal line. Assembled here so `placeLabels` can be a pure function over
  // points rather than something that knows what a chart is.
  const obstacles: Pt[][] = [
    ...linePts,
    ...(projLine ? [projLine] : []),
    ...(goalY != null ? [[{ x: box.left, y: goalY }, { x: box.right, y: goalY }]] : []),
  ];

  const requests: BoxRequest[] = [];
  // The latest reading is requested FIRST, so when the two callouts compete it
  // is the one that keeps the better position. It is the number the athlete
  // opened the screen for.
  if (latest && bounds) requests.push(label('latest', px(latest), format(latest.value), 11));
  if (first && bounds && first !== latest) requests.push(label('first', px(first), format(first.value), 11));
  // The goal's own number goes last, so it dodges the measurements rather than
  // the other way round. A target is worth less screen than a reading.
  if (goalY != null && goal != null) {
    requests.push(label('goal', { x: box.right - 14, y: goalY }, format(goal), 9));
  }
  // The off-scale marker goes through the SAME placer rather than being pinned
  // to a corner. Pinned, it sat exactly where the latest reading trends and
  // where the clipped projection exits, so a callout could be clamped on top of
  // it — and no test could see the collision, because it draws bare text and
  // the overlap assertions read rectangles.
  const offScale = goal != null && bounds && !bounds.goalInside;
  if (offScale && goal != null && bounds) {
    const below = goal < bounds.min;
    requests.push(
      label(
        'offscale',
        { x: box.right - 24, y: below ? box.bottom - 6 : box.top + 6 },
        `${below ? '▼' : '▲'} goal ${format(goal)}`,
        9,
      ),
    );
  }
  const placed = placeLabels(requests, obstacles, box);
  const at = (key: string): PlacedBox | undefined => placed.find((p) => p.key === key);

  const gridValues = bounds ? [bounds.max, (bounds.max + bounds.min) / 2, bounds.min] : [];

  /**
   * The three date ticks, each drawn AT ITS OWN DAY.
   *
   * **Not at the plot's edges and centre**, which is what this did first and is
   * wrong the moment a projection exists: the domain then runs past today by
   * `futureDays`, so day `toDay` no longer lands on `box.right` — measured on a
   * 1M window with an arrival 83 days out, today's reading drew at x≈171.6
   * while a tick reading "Today" sat at x=314, a month of future under a label
   * saying now. That is the same lie as an axis that ends at the last reading
   * (#462), arrived at from the other side, and it is the common case rather
   * than an edge one: both callers pass a projection.
   *
   * The strip right of "Today" is deliberately left unlabelled. It is the
   * future, the dashed line is already in it, and the arrival date is stated in
   * words below the chart — a fourth tick would be this drawing making its own
   * claim about when.
   */
  const midDay = Math.round((win.fromDay + win.toDay) / 2);
  const ticks = formatDate
    ? [
        { at: win.fromDay, label: formatDate(shiftDate(series.from, win.fromDay)), anchor: 'start' as const },
        { at: midDay, label: formatDate(shiftDate(series.from, midDay)), anchor: 'middle' as const },
        // Literally today: `buildTrend` ends every window there. Naming it beats
        // printing the date twice. Anchored `end` only when it really is the
        // right edge — with a projection it sits inside the plot and centring it
        // on its own day is what keeps it honest.
        {
          at: win.toDay,
          label: 'Today',
          anchor: (futureDays > 0 ? 'middle' : 'end') as 'middle' | 'end',
        },
      ]
    : [];

  return (
    <Svg
      width="100%"
      height={H}
      viewBox={`0 0 ${CHART_WIDTH} ${H}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        offScale && goal != null
          ? // The marker is drawn text inside one `image` node, so a screen
            // reader gets none of it. Without this clause VoiceOver hears a
            // chart with no goal at all, which is the same collapse the
            // drawing avoids by refusing to drop the marker.
            `${accessibilityLabel}. Goal ${format(goal)} is ${
              bounds && goal < bounds.min ? 'below' : 'above'
            } the range shown`
          : accessibilityLabel
      }
      testID={testID}
    >
      {/* The y-axis: three gridlines and the numbers that make a swing have a
          size. Without them a 4 lb week and a 40 lb year draw identically, and
          the dots' distance from the line means nothing — which is what "the
          dots and the line are on different scales" actually looked like.
          The labels live in the left gutter, OUTSIDE the plot, so they cannot
          collide with anything drawn in it. */}
      {gridValues.map((v, i) => (
        <G key={`grid-${i}`}>
          <Line
            x1={box.left}
            x2={box.right}
            y1={y(v)}
            y2={y(v)}
            stroke={vola.line}
            strokeWidth={1}
            opacity={i === 1 ? 0.6 : 1}
          />
          <SvgText
            x={box.left - 5}
            y={y(v) + 3}
            fontSize={9}
            fill={vola.textDim}
            textAnchor="end"
            testID={`trend-axis-y-${i}`}
          >
            {format(v)}
          </SvgText>
        </G>
      ))}

      {/* The goal line, dashed and labelled with the target. Dashed because it
          is a target rather than a measurement, and the same stroke as the
          projection for the same reason — the two dashed marks are the two
          things on this chart nobody has actually stood on a scale for. */}
      {goalY != null ? (
        <Line
          x1={box.left}
          x2={box.right}
          y1={goalY}
          y2={goalY}
          stroke={vola.textDim}
          strokeWidth={1}
          strokeDasharray="4 4"
          testID="trend-goal-line"
        />
      ) : null}

      {/* A goal too far from the readings to draw. It is NOT dropped: a missing
          goal line reads as "no goal set", which is a different fact. It is
          named at the edge it lies beyond, so the athlete knows the axis stops
          short of it rather than that the target vanished. */}
      <EdgeLabel placed={at('offscale')} testID="trend-goal-offscale" />

      {/* The projection. Same dash as the goal line, deliberately: it is a
          claim about the future and must not read as a measurement. The screen
          states what it assumed — see the projection sentence. */}
      {projLine ? (
        <Path
          d={`M${projLine[0].x},${projLine[0].y} L${projLine[1].x},${projLine[1].y}`}
          stroke={accent.accent}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          fill="none"
          opacity={0.8}
          testID="trend-projection"
        />
      ) : null}

      {/* The raw readings, on the same y() as everything else. Drawn in a
          colour with contrast against the ground rather than in the hairline
          colour they used to use — an invisible dot cannot be read against the
          line no matter what scale it is on. */}
      {readings.map((p) => (
        <Circle
          key={`${p.on}-r`}
          cx={x(p.day)}
          cy={y(p.value)}
          r={DOT}
          fill={vola.textMuted}
          testID={`trend-reading-${p.on}`}
        />
      ))}

      {linePts.map((pts, i) => (
        <Path
          key={`line-${i}`}
          d={pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')}
          stroke={accent.accent}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          testID={`trend-line-${i}`}
        />
      ))}
      {lonely.map((p, i) => (
        <Circle key={`lonely-${i}`} cx={p.x} cy={p.y} r={3} fill={accent.accent} />
      ))}

      {/* The two callouts read the RAW READING, never the smoothed line. An
          athlete who steps off a scale and sees a different number on the card
          than the scale gave them will not trust either. The line is the trend;
          these are the measurements.

          Each is drawn WITH a leader back to its own point, which is the whole
          of W12's second defect: a `205.2` sitting near the x-axis with nothing
          joining it to anything reads as a stray element rather than as today's
          weigh-in. */}
      <Callout placed={at('latest')} accent={accent.accent} on={accent.on} testID="trend-label-latest" />
      <Callout placed={at('first')} accent={accent.accent} on={accent.on} testID="trend-label-first" />
      <GoalLabel placed={at('goal')} />

      {ticks.map((t) => (
        // The anchor is in the key as well as the day: on a one-day window all
        // three ticks sit on day 0 and two of them format to the same string,
        // which is a duplicate React key rather than a drawing fault.
        <SvgText
          key={`${t.anchor}-${t.at}`}
          x={x(t.at)}
          y={H - 4}
          fontSize={9}
          fill={vola.textDim}
          textAnchor={t.anchor}
          testID={`trend-tick-${t.anchor}`}
        >
          {t.label}
        </SvgText>
      ))}

      {/* Nothing to draw. A blank box is a chart of nothing and reads as a
          broken one; the callers each say WHICH kind of empty this is above the
          chart, and this is the floor under a direct render. */}
      {!bounds ? (
        <SvgText
          x={CHART_WIDTH / 2}
          y={(box.top + box.bottom) / 2}
          fontSize={11}
          fill={vola.textDim}
          textAnchor="middle"
          testID="trend-chart-nothing"
        >
          No readings to draw
        </SvgText>
      ) : null}
    </Svg>
  );
}

/**
 * The box a value label needs.
 *
 * Estimated from the character count rather than measured: `react-native-svg`
 * gives no synchronous text metrics, and a chart that waits for a measurement
 * pass flashes at the wrong size on first render. Roughly 0.55em per digit at
 * semibold, plus padding — generous rather than tight, because an
 * underestimate is what puts a label's tail over the line the placer just
 * moved it off.
 */
function label(key: string, anchor: Pt, text: string, fontSize: number): BoxRequest {
  const w = Math.max(fontSize * 2.4, text.length * fontSize * 0.62 + fontSize);
  return { key, anchor, w, h: fontSize + 5, text };
}

/**
 * A muted label the placer positioned — the goal's number, or the off-scale
 * marker. Text only: these are annotations on something already drawn, not
 * measurements of their own, so they get no pill.
 */
function EdgeLabel({ placed, testID }: { placed: PlacedBox | undefined; testID: string }) {
  if (!placed) return null;
  return (
    <SvgText
      x={placed.centre.x}
      y={placed.centre.y + 3}
      fontSize={9}
      fill={vola.textDim}
      textAnchor="middle"
      testID={testID}
    >
      {placed.text}
    </SvgText>
  );
}

/**
 * The goal line's own number.
 *
 * Placed by the same routine as the callouts and therefore subject to the same
 * guarantee — it cannot land on the trend line, on a callout, or on the goal
 * line it belongs to. Unlabelled, a dashed horizontal rule is just a rule.
 */
function GoalLabel({ placed }: { placed: PlacedBox | undefined }) {
  return <EdgeLabel placed={placed} testID="trend-goal-label" />;
}

/**
 * A value label, joined to its point.
 *
 * The leader is what makes "attached" true rather than merely nearby. It is
 * omitted when the label already sits on its point, where a two-pixel stub
 * would read as a smudge.
 */
function Callout({
  placed,
  accent,
  on,
  testID,
}: {
  placed: PlacedBox | undefined;
  accent: string;
  on: string;
  testID: string;
}) {
  if (!placed) return null;
  const end = leaderEnd(placed);
  return (
    <G>
      {end ? (
        <Line
          x1={placed.anchor.x}
          y1={placed.anchor.y}
          x2={end.x}
          y2={end.y}
          stroke={accent}
          strokeWidth={1}
          opacity={0.7}
          testID={`${testID}-leader`}
        />
      ) : null}
      <Circle cx={placed.anchor.x} cy={placed.anchor.y} r={3} fill={accent} />
      <Rect
        x={placed.rect.x}
        y={placed.rect.y}
        width={placed.rect.w}
        height={placed.rect.h}
        rx={5}
        fill={accent}
        testID={testID}
      />
      <SvgText
        x={placed.centre.x}
        y={placed.centre.y + 4}
        fontSize={11}
        fontWeight="600"
        fill={on}
        textAnchor="middle"
      >
        {placed.text}
      </SvgText>
    </G>
  );
}
