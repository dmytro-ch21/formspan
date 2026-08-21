import { render, screen } from '@testing-library/react-native';

import { TrendChart } from '../TrendChart';
import { plotBox, polylineHitsRect, rectsOverlap, type Pt, type Rect } from '@/lib/trendChartLayout';
import { buildTrend, projectToGoal, RANGES, type Reading, type TrendSeries } from '@/lib/trendSeries';

/**
 * What the DRAWING has to get right.
 *
 * `lib/__tests__/trendSeries.test.ts` covers the arithmetic and
 * `lib/__tests__/trendChartLayout.test.ts` covers the placement, both in
 * isolation — and every one of those assertions still passes if the chart never
 * mounts a single path, because a pure function does not care whether anybody
 * drew its output. This file is the other half: it reads the coordinates back
 * off the rendered elements and checks them against the scale the chart itself
 * printed on its axis.
 *
 * **The assertions here are about NUMBERS, not about elements existing.** W12
 * was five defects and four of them would sail past a test that checked a path
 * had been produced — a `d` attribute is present whether or not the line and
 * the dots agree about where 207.4 lives.
 */

const TODAY = '2026-08-19';
const HEIGHT = 200;
const BOX = plotBox(HEIGHT);

function shift(on: string, days: number): string {
  return new Date(Date.parse(`${on}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function meanSmoother(readings: Reading[], min = 1) {
  return (on: string) => {
    const from = shift(on, -6);
    const w = readings.filter((r) => r.on >= from && r.on <= on);
    return w.length >= min ? w.reduce((s, r) => s + r.value, 0) / w.length : null;
  };
}

function daily(days: number, from: number, delta: number): Reading[] {
  const out: Reading[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ on: shift(TODAY, -i), value: from + delta * (days - 1 - i) });
  return out;
}

/**
 * Four decimals, deliberately.
 *
 * The axis labels are how these tests recover the chart's own scale, so their
 * precision is the precision of every value assertion below. At one decimal —
 * what the screen ships — a 2 kg domain over 172px rounds each end by up to
 * 0.05, which is 4px of slop: enough for a genuinely mis-scaled dot to pass.
 */
const fmt4 = (v: number) => v.toFixed(4);

const paths = () => screen.UNSAFE_root.findAllByType('RNSVGPath' as never);
const circles = () => screen.UNSAFE_root.findAllByType('RNSVGCircle' as never);
const texts = () => screen.UNSAFE_root.findAllByType('RNSVGText' as never);
const rects = () => screen.UNSAFE_root.findAllByType('RNSVGRect' as never);

function chart(props: Partial<React.ComponentProps<typeof TrendChart>> = {}) {
  const readings = props.series ? [] : daily(60, 100, -0.05);
  return render(
    <TrendChart
      series={props.series ?? buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) })}
      format={fmt4}
      minSpan={1}
      height={HEIGHT}
      formatDate={(on) => on.slice(5)}
      accessibilityLabel="Weight trend"
      {...props}
    />,
  );
}

/** Every vertex of every drawn path, in viewBox coordinates. */
function pathPoints(): Pt[][] {
  return paths().map((p: any) =>
    String(p.props.d)
      .split(/(?=[ML])/)
      .map((leg) => leg.trim().slice(1).split(','))
      .filter((n) => n.length === 2)
      .map(([x, y]) => ({ x: Number(x), y: Number(y) })),
  );
}

/** The value labels the chart drew, as rectangles. */
function labelRects(): Rect[] {
  return rects().map((r: any) => ({
    x: Number(r.props.x),
    y: Number(r.props.y),
    w: Number(r.props.width),
    h: Number(r.props.height),
  }));
}

/**
 * What an `RNSVGText` node actually says.
 *
 * NOT `props.children`, and not the child strings either. react-native-svg
 * lowers text into an `RNSVGTSpan` host node carrying the string on a
 * **`content` prop** — so `props.children` is a React element whose `String(…)`
 * is `[object Object]`, and walking the children finds no strings at all. Both
 * wrong readings stringify happily and compare unequal to everything, which
 * would have let every text assertion below pass while measuring nothing.
 */
function textOf(node: any): string {
  if (typeof node === 'string') return node;
  if (node?.props?.content != null) return String(node.props.content);
  return (node?.children ?? []).map(textOf).join('');
}

/**
 * The chart's own y-scale, recovered from the axis it printed.
 *
 * Read off the RENDERED labels rather than recomputed from the series, so a
 * dot, a line vertex and the axis are all checked against the same third thing.
 * Recomputing the domain here would just be this test agreeing with a copy of
 * the code under test.
 */
function axisScale(): (py: number) => number {
  const label = (id: string) => {
    const t = texts().find((n: any) => n.props.testID === id) as any;
    return { value: Number(textOf(t)), y: Number(t.props.y) - 3 };
  };
  const top = label('trend-axis-y-0');
  const bottom = label('trend-axis-y-2');
  const perPx = (top.value - bottom.value) / (bottom.y - top.y);
  return (py: number) => bottom.value + (bottom.y - py) * perPx;
}

// ---------------------------------------------------------------------------
// W12's headline: one y-scale, and it is provable
// ---------------------------------------------------------------------------

/**
 * The criterion, verbatim: *a reading of 207.4 renders at the same height as
 * 207.4 on the line*.
 *
 * Built so a reading and the smoothed line genuinely coincide — a fortnight of
 * identical weigh-ins makes the seven-day mean equal to each reading in it — so
 * the two marks must land on the same pixel. Anything that gave the dots their
 * own domain (their own bounds, their own padding, their own height) separates
 * them here.
 */
test('a reading renders at exactly the height the line gives the same value', () => {
  // A noisy fortnight, then a fortnight of identical weigh-ins — over which the
  // seven-day mean IS each reading, to the last decimal place.
  const readings: Reading[] = [];
  for (let day = 0; day < 30; day++) {
    readings.push({ on: shift(TODAY, -(29 - day)), value: day < 15 ? (day % 2 === 0 ? 95.5 : 94.5) : 95 });
  }
  const series = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings, 3) });
  chart({ series });

  // A day deep inside the flat stretch: the mean over the trailing week is
  // exactly the reading taken that morning.
  const on = shift(TODAY, -3);
  const reading = series.readings.find((p) => p.on === on)!;
  const vertexValue = series.segments.flat().find((p) => p.on === on)!.value;
  expect(vertexValue).toBeCloseTo(reading.value, 10);

  const dot = circles().find((c: any) => c.props.testID === `trend-reading-${on}`) as any;
  const line = pathPoints().find((pts) => pts.length > 2)!;
  const vertexX = line.reduce((a, b) => (Math.abs(b.x - Number(dot.props.cx)) < Math.abs(a.x - Number(dot.props.cx)) ? b : a));
  expect(vertexX.x).toBeCloseTo(Number(dot.props.cx), 6);
  expect(vertexX.y).toBeCloseTo(Number(dot.props.cy), 6);
});

/**
 * The general form of the same thing: pixels-per-unit measured off the DOTS and
 * measured off the LINE have to be the same number.
 *
 * This is what the report described — dots "at what looks like a different
 * vertical scale" — expressed as a quantity rather than as an impression, and
 * it fails for any independent scaling of one against the other, including one
 * that happens to coincide at a single value.
 */
test('dots and line agree on how many pixels a kilogram is', () => {
  const readings = daily(60, 100, -0.05);
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
  chart({ series });

  const scale = axisScale();

  const dots = series.readings
    .map((p) => {
      const c = circles().find((n: any) => n.props.testID === `trend-reading-${p.on}`) as any;
      return c ? { value: p.value, y: Number(c.props.cy) } : null;
    })
    .filter((d): d is { value: number; y: number } => d != null);
  expect(dots.length).toBeGreaterThan(30);

  const line = pathPoints().find((pts) => pts.length > 2)!;
  const seg = series.segments.reduce((a, b) => (b.length > a.length ? b : a));

  const perPxDots = (dots[0].value - dots[dots.length - 1].value) / (dots[dots.length - 1].y - dots[0].y);
  const perPxLine = (seg[0].value - seg[seg.length - 1].value) / (line[line.length - 1].y - line[0].y);
  expect(perPxDots).toBeCloseTo(perPxLine, 8);

  // And both agree with the axis, which is the number the athlete reads.
  for (const d of dots) expect(scale(d.y)).toBeCloseTo(d.value, 3);
  for (let i = 0; i < seg.length; i++) expect(scale(line[i].y)).toBeCloseTo(seg[i].value, 3);
});

/**
 * The W12 report's own numbers, as a rendering.
 *
 * 206.0–207.8 lb of readings against a 190 lb goal. Before the domain cap every
 * mark landed inside y 31.7–46.1 of this 200px chart — 14px — which is why a
 * dot 1.4 lb off the line looked like it belonged to another picture.
 */
test('a distant goal no longer flattens a week of readings into a strip', () => {
  const lb = (v: number) => v / 2.2046226218;
  const readings: Reading[] = [209.5, 208.4, 209.1, 207.6, 208.9, 207.4, 208.1, 206.9, 207.8, 206.2, 207.1, 205.9, 206.8, 205.2]
    .map((v, i) => ({ on: shift(TODAY, -(13 - i)), value: lb(v) }));
  const series = buildTrend({ readings, today: TODAY, range: '1W', smooth: meanSmoother(readings, 3) });
  chart({ series, goal: lb(190) });

  const ys = circles()
    .filter((c: any) => String(c.props.testID ?? '').startsWith('trend-reading-'))
    .map((c: any) => Number(c.props.cy));
  const spread = Math.max(...ys) - Math.min(...ys);
  const plotHeight = BOX.bottom - BOX.top;
  expect(spread / plotHeight).toBeGreaterThan(0.25);

  // The goal has not been silently dropped — a missing goal line reads as "no
  // goal set", which is a different fact about the athlete.
  expect(screen.queryByTestId('trend-goal-line')).toBeNull();
  expect(screen.getByTestId('trend-goal-offscale')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// The labels
// ---------------------------------------------------------------------------

test('the latest label is joined to its own point', () => {
  const readings = daily(30, 100, -0.05);
  const series = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings, 3) });
  chart({ series });

  const rect = screen.getByTestId('trend-label-latest');
  const leader = screen.getByTestId('trend-label-latest-leader');
  const latest = series.readings[series.readings.length - 1];
  const dot = circles().find((c: any) => c.props.testID === `trend-reading-${latest.on}`) as any;

  // One end of the leader is the reading's own dot, to the pixel.
  expect(Number(leader.props.x1)).toBeCloseTo(Number(dot.props.cx), 6);
  expect(Number(leader.props.y1)).toBeCloseTo(Number(dot.props.cy), 6);
  // The other end is on the label's edge.
  const r: Rect = {
    x: Number(rect.props.x), y: Number(rect.props.y),
    w: Number(rect.props.width), h: Number(rect.props.height),
  };
  const x2 = Number(leader.props.x2);
  const y2 = Number(leader.props.y2);
  expect(x2).toBeGreaterThanOrEqual(r.x - 0.001);
  expect(x2).toBeLessThanOrEqual(r.x + r.w + 0.001);
  expect(y2).toBeGreaterThanOrEqual(r.y - 0.001);
  expect(y2).toBeLessThanOrEqual(r.y + r.h + 0.001);
  // And it is a short hop, not a wander across the chart.
  expect(Math.hypot(x2 - Number(dot.props.cx), y2 - Number(dot.props.cy))).toBeLessThan(24);
});

/**
 * *"Nothing overlaps: labels do not cover the line, and two labels do not cover
 * each other, at every window."*
 *
 * Every preset, against four shapes of data including the sparse one that broke
 * and one with a projection running to a goal. The assertion reads the rendered
 * rectangles and the rendered paths — not the placer's own answer — so a
 * component that ignored the placer and drew somewhere else would fail here.
 */
describe('nothing overlaps, at every window', () => {
  const shapes: { name: string; readings: Reading[] }[] = [
    { name: 'daily for two months', readings: daily(60, 100, -0.05) },
    { name: 'twelve readings in a fortnight', readings: daily(14, 95, -0.06) },
    {
      name: 'a month of logging, then six weeks of nothing',
      readings: daily(31, 100, -0.05).map((r) => ({ ...r, on: shift(r.on, -45) })),
    },
    { name: 'two readings', readings: [{ on: shift(TODAY, -9), value: 99 }, { on: TODAY, value: 97.5 }] },
  ];

  for (const shape of shapes) {
    for (const range of RANGES) {
      test(`${shape.name} — ${range.key}`, () => {
        const series = buildTrend({
          readings: shape.readings,
          today: TODAY,
          range: range.key,
          smooth: meanSmoother(shape.readings, 3),
          planFrom: shift(TODAY, -40),
        });
        if (series.empty) return expectSkippedEmpty(series);
        chart({ series, goal: 94, projection: projectToGoal(series, 94) });

        const boxes = labelRects();
        const lines = pathPoints();
        const goal = screen.queryByTestId('trend-goal-line');
        if (goal) {
          const gy = Number(goal.props.y1);
          lines.push([{ x: Number(goal.props.x1), y: gy }, { x: Number(goal.props.x2), y: gy }]);
        }

        // Collected rather than asserted one at a time, so a failure names
        // WHICH pair and where — a bare `toBe(false)` on a nested loop tells
        // you a chart is wrong and nothing about how.
        const collisions: string[] = [];
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            if (rectsOverlap(boxes[i], boxes[j])) {
              collisions.push(`labels ${i}+${j}: ${JSON.stringify(boxes[i])} ${JSON.stringify(boxes[j])}`);
            }
          }
          for (const l of lines) {
            if (polylineHitsRect(l, boxes[i])) collisions.push(`label ${i} covers a line: ${JSON.stringify(boxes[i])}`);
          }
        }
        expect(collisions).toEqual([]);

        // Everything stays inside the frame the axis labels live outside of.
        for (const b of boxes) {
          expect(b.x).toBeGreaterThanOrEqual(BOX.left - 0.001);
          expect(b.x + b.w).toBeLessThanOrEqual(BOX.right + 0.001);
          expect(b.y).toBeGreaterThanOrEqual(BOX.top - 0.001);
          expect(b.y + b.h).toBeLessThanOrEqual(BOX.bottom + 0.001);
        }
      });
    }
  }
});

/** An empty window draws no marks at all, which is the other correct answer. */
function expectSkippedEmpty(series: TrendSeries) {
  expect(series.readings.length === 0 || series.segments.length === 0).toBe(true);
}

// ---------------------------------------------------------------------------
// Sparse windows
// ---------------------------------------------------------------------------

/**
 * *"A window with sparse data does not collapse into a corner."*
 *
 * The 3M screenshot. Measured on the old code: every mark between x=273 and
 * x=320 of a 320-wide viewBox — 15% of the width, 90% of the chart empty.
 */
test('a fortnight of readings in a 3M window fills the chart rather than a corner', () => {
  const readings = daily(14, 95, -0.06);
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
  chart({ series });

  const xs = circles()
    .filter((c: any) => String(c.props.testID ?? '').startsWith('trend-reading-'))
    .map((c: any) => Number(c.props.cx));
  const spread = Math.max(...xs) - Math.min(...xs);
  expect(spread / (BOX.right - BOX.left)).toBeGreaterThan(0.75);
});

/**
 * The mirror, and it must NOT fire — found by review before #462 and still the
 * thing this change is most likely to break. `daySpan` used to measure the
 * POINTS rather than the window, so for anybody who stopped logging a week ago
 * the axis shrank to their last weigh-in: the tick labelled "Today" sat on a
 * reading that could be weeks old. Time appeared to end when the athlete
 * stopped logging.
 */
test('a trailing gap leaves empty space, rather than the axis ending at the last reading', () => {
  const readings: Reading[] = [];
  for (let i = 75; i >= 45; i--) readings.push({ on: shift(TODAY, -i), value: 100 - (75 - i) * 0.05 });
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });

  expect(series.to).toBe(TODAY); // the window really does run to today
  chart({ series });

  // The rightmost mark sits where its DAY falls in the WINDOW, not at the right
  // edge. Asserted as a proportion rather than a pixel threshold: a loose
  // threshold is what let the first version of this test pass against the bug
  // it was written for.
  const lastDay = Math.max(...series.readings.map((p) => p.day));
  const expected = BOX.left + (lastDay / 89) * (BOX.right - BOX.left);
  const maxCx = Math.max(
    ...circles()
      .filter((c: any) => String(c.props.testID ?? '').startsWith('trend-reading-'))
      .map((c: any) => Number(c.props.cx)),
  );
  expect(maxCx).toBeCloseTo(expected, 0);
  expect(maxCx).toBeLessThan(BOX.left + (BOX.right - BOX.left) * 0.6);
});

// ---------------------------------------------------------------------------
// Degrading legibly
// ---------------------------------------------------------------------------

test('one reading draws one labelled dot, a readable axis, and no trend line', () => {
  const series = buildTrend({ readings: [{ on: TODAY, value: 97.3 }], today: TODAY, range: '1M' });
  chart({ series });

  expect(paths()).toHaveLength(0);
  const dots = circles().filter((c: any) => String(c.props.testID ?? '').startsWith('trend-reading-'));
  expect(dots).toHaveLength(1);
  expect(labelRects()).toHaveLength(1);
  // The axis still states a range, so the single dot has a value.
  const scale = axisScale();
  expect(scale(Number((dots[0] as any).props.cy))).toBeCloseTo(97.3, 3);
});

test('no readings draws no marks and says so, rather than an empty box', () => {
  const series = buildTrend({ readings: [], today: TODAY, range: '1M' });
  chart({ series });
  expect(paths()).toHaveLength(0);
  expect(circles()).toHaveLength(0);
  expect(screen.getByTestId('trend-chart-nothing')).toBeTruthy();
  expect(screen.queryByTestId('trend-goal-line')).toBeNull();
});

// ---------------------------------------------------------------------------
// The rest of the drawing, unchanged in intent by W12
// ---------------------------------------------------------------------------

// A single path across the hole would be the app inventing a fortnight of
// weigh-ins, and it would look completely normal.
test('a gap is drawn as separate paths, never one line across it', () => {
  const readings: Reading[] = [
    { on: shift(TODAY, -60), value: 100 },
    { on: shift(TODAY, -59), value: 100 },
    { on: shift(TODAY, -58), value: 100 },
    { on: shift(TODAY, -3), value: 96 },
    { on: shift(TODAY, -2), value: 96 },
    { on: shift(TODAY, -1), value: 96 },
  ];
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
  chart({ series });
  expect(series.segments.length).toBeGreaterThan(1);
  expect(paths().length).toBeGreaterThanOrEqual(series.segments.filter((s) => s.length > 1).length);
});

describe('the two dashed marks appear only when they are true', () => {
  test('no goal set means no goal line', () => {
    chart({ goal: null });
    expect(screen.queryByTestId('trend-goal-line')).toBeNull();
    expect(screen.queryByTestId('trend-goal-offscale')).toBeNull();
  });

  test('a goal draws the line', () => {
    chart({ goal: 96 });
    expect(screen.getByTestId('trend-goal-line')).toBeTruthy();
    expect(screen.getByTestId('trend-goal-label')).toBeTruthy();
  });

  // The absence that must not read as an all-clear: a refused projection draws
  // nothing, and the SENTENCE beside the chart is what says why.
  test('a refused projection draws no dashed line', () => {
    const readings = daily(60, 100, +0.05); // gaining, goal is below
    const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
    const p = projectToGoal(series, 90);
    expect(p.kind).toBe('none');
    chart({ series, goal: 90, projection: p });
    expect(screen.queryByTestId('trend-projection')).toBeNull();
  });

  test('a real projection draws one', () => {
    const readings = daily(60, 100, -0.05);
    const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
    chart({ series, goal: 96, projection: projectToGoal(series, 96) });
    expect(screen.getByTestId('trend-projection')).toBeTruthy();
  });

  /**
   * A projection aimed at a goal the axis stops short of has to END AT THE
   * EDGE. Unclipped it runs under the date ticks and off the bottom of the
   * viewBox, which is the same class of defect as a label over the line: a mark
   * somewhere the reader is not looking, saying something untrue about where
   * the chart ends.
   */
  test('a projection toward an off-scale goal is clipped to the plot', () => {
    const readings = daily(60, 100, -0.05);
    const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
    chart({ series, goal: 60, projection: projectToGoal(series, 60) });
    const d = String((screen.getByTestId('trend-projection') as any).props.d);
    for (const m of d.matchAll(/[ML]([-\d.]+),([-\d.]+)/g)) {
      expect(Number(m[2])).toBeGreaterThanOrEqual(BOX.top - 0.001);
      expect(Number(m[2])).toBeLessThanOrEqual(BOX.bottom + 0.001);
    }
  });
});

// The callouts read the RAW reading, never the smoothed line. An athlete who
// steps off a scale and sees a different number on the card than the scale gave
// them will not trust either.
test('the callouts show the measurements, not the trend line', () => {
  const readings: Reading[] = [
    ...daily(30, 100, 0).slice(0, 29),
    { on: TODAY, value: 93.4 }, // a sharp last reading the mean would not follow
  ];
  const series = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings, 3) });
  chart({ series, format: (v) => v.toFixed(1) });

  // Queried off the serialised tree rather than with `getByText`: react-native-
  // svg renders an `RNSVGText` host node, which RNTL's text matcher does not
  // traverse. Measured — the string is present and `queryByText` returns null
  // for it, so a getByText assertion here fails on a correct component.
  const shown = texts().map(textOf);
  const smoothed = meanSmoother(readings, 3)(TODAY)!;
  expect(Math.abs(smoothed - 93.4)).toBeGreaterThan(0.5); // the two really do differ
  expect(shown).toContain('93.4');
  expect(shown).not.toContain(smoothed.toFixed(1));
});

// A stale server derivation plus a fresh weigh-in gives `reached_on` BEFORE the
// latest reading — a negative `daysAway`. The first attempt at this guard
// floored the domain only and left `projEnd` reading the raw value, so the
// dashed line still ran BACKWARD from the latest point to the goal.
test('a projection dated before the latest reading draws nothing, never backwards', () => {
  const readings = daily(60, 100, -0.05);
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
  chart({
    series,
    goal: 90,
    projection: {
      kind: 'projected',
      onDate: shift(TODAY, -10),
      daysAway: -10,
      source: 'plan',
      basis: {
        ratePerWeek: -0.35, fromValue: 97, fromDate: TODAY, goal: 90,
        spanDays: 60, n: 60, basis: 'smoothed',
      },
    },
  });
  expect(screen.queryByTestId('trend-projection')).toBeNull();
});

// Zero would otherwise draw a degenerate vertical dash, which reads as a cliff.
test('an arrival dated today draws nothing rather than a vertical dash', () => {
  const readings = daily(60, 100, -0.05);
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
  chart({
    series,
    goal: 90,
    projection: {
      kind: 'projected', onDate: TODAY, daysAway: 0, source: 'plan',
      basis: { ratePerWeek: -0.35, fromValue: 90, fromDate: TODAY, goal: 90, spanDays: 60, n: 60, basis: 'smoothed' },
    },
  });
  expect(screen.queryByTestId('trend-projection')).toBeNull();
});

// The x-axis has to describe the domain the chart actually drew. A caller that
// computed labels from the window's nominal start printed dates the drawing did
// not use the moment the left edge started moving — which is why `formatDate`
// is a function rather than three finished strings.
test('the x-axis names the day the plot really starts on', () => {
  const readings = daily(14, 95, -0.06);
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
  chart({ series });
  const shown = texts().map(textOf);
  expect(shown).toContain('Today');
  // The window nominally starts 90 days back; the plot does not, and says so.
  expect(shown).not.toContain(shift(TODAY, -89).slice(5));
  expect(shown).toContain(shift(TODAY, -14).slice(5));
});

/**
 * The tick labelled "Today" has to sit ON today.
 *
 * Found in review. The ticks used to be drawn at the plot's edges and centre,
 * which is right only while the x-domain ends at today — and it does not, the
 * moment a projection extends it by `futureDays`. Measured on the first version:
 * a 1M window with arrival 83 days out drew today's reading at x≈171.6 while a
 * tick reading "Today" sat at x=314, a month of future under a label saying now.
 * Same class as an axis that ends at the last reading (#462), from the other
 * side — and the common case, since both callers pass a projection.
 */
test('the Today tick sits on today, not at the right edge, when a projection extends the domain', () => {
  const readings = daily(30, 100, -0.05);
  const series = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings, 3) });
  const projection = projectToGoal(series, 96);
  expect(projection.kind).toBe('projected');
  chart({ series, goal: 96, projection });

  const todayTick = texts().find((t: any) => textOf(t) === 'Today') as any;
  const todayDot = circles().find((c: any) => c.props.testID === `trend-reading-${TODAY}`) as any;
  expect(Number(todayTick.props.x)).toBeCloseTo(Number(todayDot.props.cx), 3);
  // And the domain really was extended, so this is not vacuously true.
  expect(Number(todayTick.props.x)).toBeLessThan(BOX.right - 20);
});

test('with no projection the Today tick is the right edge', () => {
  const readings = daily(30, 100, -0.05);
  const series = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings, 3) });
  chart({ series });
  const todayTick = texts().find((t: any) => textOf(t) === 'Today') as any;
  expect(Number(todayTick.props.x)).toBeCloseTo(BOX.right, 3);
});

/**
 * The off-scale goal marker is placed, not pinned.
 *
 * Pinned to a corner it sat exactly where the latest reading trends and where a
 * clipped projection exits, so a callout could be clamped on top of it — and
 * the overlap matrix could not see the collision, because that assertion reads
 * rectangles and this draws bare text.
 */
test('the off-scale goal marker keeps clear of the labels and the line', () => {
  const readings = daily(60, 100, -0.05);
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
  chart({ series, goal: 60, projection: projectToGoal(series, 60) });

  const marker = screen.getByTestId('trend-goal-offscale');
  const mx = Number(marker.props.x);
  const my = Number(marker.props.y) - 3;
  // Its own box, on the same estimate the placer used.
  const text = textOf(marker);
  const w = Math.max(9 * 2.4, text.length * 9 * 0.62 + 9);
  const rect: Rect = { x: mx - w / 2, y: my - 7, w, h: 14 };

  for (const b of labelRects()) expect(rectsOverlap(rect, b)).toBe(false);
  for (const l of pathPoints()) expect(polylineHitsRect(l, rect)).toBe(false);
  expect(rect.x).toBeGreaterThanOrEqual(BOX.left - 0.001);
  expect(rect.y + rect.h).toBeLessThanOrEqual(BOX.bottom + 0.001);
});

// A picture with no words is unreadable to a screen reader, and the off-scale
// marker is drawn text inside one `image` node — so without this clause
// VoiceOver hears a chart with no goal at all, which is the same collapse the
// drawing refuses to make.
test('an off-scale goal is named in the accessibility label', () => {
  const readings = daily(60, 100, -0.05);
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings, 3) });
  chart({ series, goal: 60, format: (v) => v.toFixed(1), accessibilityLabel: 'Weight over the last three months' });
  const svg = screen.UNSAFE_root.findAllByType('RNSVGSvgView' as never)[0] as any;
  expect(String(svg.props.accessibilityLabel)).toMatch(/60\.0 is below the range shown/);
});
