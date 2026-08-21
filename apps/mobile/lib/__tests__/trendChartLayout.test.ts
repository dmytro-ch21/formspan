import {
  clipSegment,
  leaderEnd,
  placeLabels,
  plotBounds,
  plotBox,
  plotWindow,
  polylineHitsRect,
  rectsOverlap,
  type BoxRequest,
  type Pt,
  type Rect,
} from '../trendChartLayout';
import { buildTrend, type Reading } from '../trendSeries';

/**
 * The placement arithmetic behind W12.
 *
 * Every defect in that report was geometry — a domain that let the goal squash
 * the data, a domain that let 90% of the width stay empty, labels that landed
 * on the line — and geometry is the one part of a chart that a test asserting
 * "a path was rendered" can never see. So it is asserted here as numbers, and
 * asserted again against the real drawing in
 * `components/__tests__/trendChart.test.tsx`.
 */

const TODAY = '2026-08-19';

function shift(on: string, days: number): string {
  return new Date(Date.parse(`${on}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The y-domain
// ---------------------------------------------------------------------------

// A body-mass line starting at zero puts a year of work in the top 5% of the
// box and reads as flat.
test('bounds are not zero-based', () => {
  const b = plotBounds({ low: 95, high: 105 }, { minSpan: 1 })!;
  expect(b.min).toBeGreaterThan(0);
  expect(b.min).toBeLessThan(95);
});

test('a flat series gets a minimum span rather than dividing by zero', () => {
  const b = plotBounds({ low: 100, high: 100 }, { minSpan: 1 })!;
  expect(b.max - b.min).toBeCloseTo(1);
});

test('no data means no bounds', () => {
  expect(plotBounds({ low: null, high: null }, { minSpan: 1 })).toBeNull();
});

test('a goal already inside the data changes nothing and is drawable', () => {
  const b = plotBounds({ low: 95, high: 105 }, { minSpan: 1, goal: 100 })!;
  expect(b.goalInside).toBe(true);
  expect(b.min).toBeCloseTo(94);
  expect(b.max).toBeCloseTo(106);
});

test('a goal just outside the data widens the axis to include it', () => {
  const b = plotBounds({ low: 95, high: 105 }, { minSpan: 1, goal: 90 })!;
  expect(b.goalInside).toBe(true);
  expect(b.min).toBeLessThanOrEqual(90);
});

/**
 * THE W12 HEADLINE, as arithmetic.
 *
 * The reporter's numbers: readings across 206.0–207.8 lb (93.44–94.26 kg) with
 * a 190 lb (86.18 kg) goal. Before this cap the axis ran from the goal to the
 * data, so 0.82 kg of real movement got 4% of the height — measured on the old
 * code as y 31.7–46.1 of a 200px chart — and at that size a dot and the line
 * are a few pixels apart whatever they say. The chart was never on two scales;
 * it was on one scale with no room left on it.
 */
test('a goal far below the readings does not get to own the axis', () => {
  const plain = plotBounds({ low: 93.44, high: 94.26 }, { minSpan: 1 })!;
  const b = plotBounds({ low: 93.44, high: 94.26 }, { minSpan: 1, goal: 86.18 })!;
  expect(b.goalInside).toBe(false);
  // Refused outright rather than stretched part of the way: a half-empty axis
  // with the readings squashed into the top is the same defect turned down.
  expect(b).toEqual({ ...plain, goalInside: false });
  const dataShare = (94.26 - 93.44) / (b.max - b.min);
  expect(dataShare).toBeGreaterThan(0.75);
});

test('a goal far above the readings is refused the same way', () => {
  const b = plotBounds({ low: 60, high: 62 }, { minSpan: 1, goal: 200 })!;
  expect(b.goalInside).toBe(false);
  expect(b.max).toBeCloseTo(62.2);
  expect(b.min).toBeCloseTo(59.8);
});

// ---------------------------------------------------------------------------
// The x-domain
// ---------------------------------------------------------------------------

function seriesOf(readings: Reading[], range: '1W' | '1M' | '3M') {
  const smooth = (on: string) => {
    const from = shift(on, -6);
    const w = readings.filter((r) => r.on >= from && r.on <= on);
    return w.length >= 3 ? w.reduce((s, r) => s + r.value, 0) / w.length : null;
  };
  return buildTrend({ readings, today: TODAY, range, smooth });
}

function dailyEnding(daysBack: number, count: number): Reading[] {
  const out: Reading[] = [];
  for (let i = daysBack + count - 1; i >= daysBack; i--) out.push({ on: shift(TODAY, -i), value: 94 - i * 0.01 });
  return out;
}

test('a full window is not tightened', () => {
  const s = seriesOf(dailyEnding(0, 90), '3M');
  const w = plotWindow(s);
  expect(w.clipped).toBe(false);
  expect(w.fromDay).toBe(0);
});

/**
 * The 3M screenshot: twelve readings, all inside the last fortnight. Measured
 * on the old code, every mark landed between x=273 and x=320 of a 320-wide
 * viewBox — 15% of the width, and it reads as broken rather than as sparse.
 */
test('a window that is mostly empty tightens onto the data', () => {
  const s = seriesOf(dailyEnding(0, 14), '3M');
  const w = plotWindow(s);
  expect(w.clipped).toBe(true);
  expect(w.firstDataDay).toBe(89 - 13);
  // Just short of the first reading, never past it.
  expect(w.fromDay).toBeLessThan(w.firstDataDay!);
  expect(w.fromDay).toBeGreaterThan(w.firstDataDay! - 4);
  // And the data now occupies most of the drawn span.
  expect((89 - w.fromDay + 1) / 90).toBeLessThan(0.3);
});

/**
 * The mirror, and it must NOT fire. For somebody who stopped logging a
 * fortnight ago the empty right-hand strip IS the information: shrinking onto
 * their last weigh-in would put a tick labelled "Today" on a reading weeks old.
 * That was a real bug once, fixed in #462, and this rule is exactly the kind of
 * change that reintroduces it from the other side.
 */
test('a trailing gap is left alone — only the left edge ever moves', () => {
  // Logged for a month, then stopped six weeks ago.
  const s = seriesOf(dailyEnding(45, 31), '3M');
  const w = plotWindow(s);
  expect(w.clipped).toBe(false);
  expect(w.fromDay).toBe(0);
  expect(w.toDay).toBe(89);
});

test('nothing to draw means nothing to tighten onto', () => {
  const s = buildTrend({ readings: [], today: TODAY, range: '3M' });
  const w = plotWindow(s);
  expect(w.firstDataDay).toBeNull();
  expect(w.clipped).toBe(false);
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const BOX = plotBox(200);

test('a segment leaving the box is trimmed at the boundary, not dropped', () => {
  const cut = clipSegment({ x: 100, y: 100 }, { x: 100, y: 400 }, BOX)!;
  expect(cut[0]).toEqual({ x: 100, y: 100 });
  expect(cut[1].y).toBeCloseTo(BOX.bottom);
});

test('a segment entirely outside the box is null rather than drawn', () => {
  expect(clipSegment({ x: 100, y: 400 }, { x: 200, y: 500 }, BOX)).toBeNull();
});

test('a segment entirely inside the box survives untouched', () => {
  const a = { x: 100, y: 100 };
  const b = { x: 200, y: 120 };
  expect(clipSegment(a, b, BOX)).toEqual([a, b]);
});

test('overlap is detected on both axes, and touching edges do not count', () => {
  const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
  expect(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  expect(rectsOverlap(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  expect(rectsOverlap(a, { x: 0, y: 20, w: 10, h: 10 })).toBe(false);
});

test('a polyline crossing a rectangle is a hit even when no vertex is inside it', () => {
  const line: Pt[] = [
    { x: 0, y: 50 },
    { x: 100, y: 50 },
  ];
  // The rectangle sits between the two vertices — a vertex-only test misses it.
  expect(polylineHitsRect(line, { x: 40, y: 40, w: 20, h: 20 })).toBe(true);
  expect(polylineHitsRect(line, { x: 40, y: 0, w: 20, h: 20 })).toBe(false);
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

function req(key: string, anchor: Pt, text = '207.4'): BoxRequest {
  return { key, anchor, w: 44, h: 16, text };
}

test('a label is moved off the line it would otherwise cover', () => {
  const line: Pt[] = [
    { x: BOX.left, y: 100 },
    { x: BOX.right, y: 100 },
  ];
  const [p] = placeLabels([req('a', { x: 150, y: 100 })], [line], BOX);
  expect(p.clear).toBe(true);
  expect(polylineHitsRect(line, p.rect)).toBe(false);
});

test('two labels on the same point do not land on each other', () => {
  const placed = placeLabels([req('a', { x: 150, y: 100 }), req('b', { x: 150, y: 100 })], [], BOX);
  expect(placed).toHaveLength(2);
  expect(placed.every((p) => p.clear)).toBe(true);
  expect(rectsOverlap(placed[0].rect, placed[1].rect)).toBe(false);
});

/**
 * The clamp runs BEFORE scoring, and this is the case that proves it matters: a
 * label on the newest reading sits at the right-hand edge by definition, so the
 * clamp always moves it. Scoring the offered rectangle rather than the clamped
 * one hands back a position that overlaps exactly where the box is tightest.
 */
test('a label at the very corner is pushed inside the box and still scored there', () => {
  const other = req('other', { x: BOX.right - 30, y: BOX.top + 10 });
  const placed = placeLabels([other, req('latest', { x: BOX.right, y: BOX.top })], [], BOX);
  for (const p of placed) {
    expect(p.rect.x).toBeGreaterThanOrEqual(BOX.left - 0.001);
    expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(BOX.right + 0.001);
    expect(p.rect.y).toBeGreaterThanOrEqual(BOX.top - 0.001);
    expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(BOX.bottom + 0.001);
  }
  expect(rectsOverlap(placed[0].rect, placed[1].rect)).toBe(false);
});

test('a label never sits on top of the point it describes', () => {
  const [p] = placeLabels([req('a', { x: 150, y: 100 })], [], BOX);
  const inside =
    p.anchor.x >= p.rect.x &&
    p.anchor.x <= p.rect.x + p.rect.w &&
    p.anchor.y >= p.rect.y &&
    p.anchor.y <= p.rect.y + p.rect.h;
  expect(inside).toBe(false);
});

// W12's second defect: `205.2` sitting near the x-axis with nothing joining it
// to anything reads as a stray element rather than as today's weigh-in.
test('the leader runs from the point to the nearest edge of its label', () => {
  const [p] = placeLabels([req('a', { x: 150, y: 100 })], [], BOX);
  const end = leaderEnd(p)!;
  expect(end).not.toBeNull();
  // On the label's boundary, and no further from the anchor than the label is.
  const onEdge =
    Math.abs(end.x - p.rect.x) < 0.001 ||
    Math.abs(end.x - (p.rect.x + p.rect.w)) < 0.001 ||
    Math.abs(end.y - p.rect.y) < 0.001 ||
    Math.abs(end.y - (p.rect.y + p.rect.h)) < 0.001;
  expect(onEdge).toBe(true);
  expect(Math.hypot(end.x - p.anchor.x, end.y - p.anchor.y)).toBeLessThan(20);
});

/**
 * The case the first version of the placer failed, kept because it is the one
 * that recurs: the OLDEST reading's label.
 *
 * That label is clamped against the left edge, so a wide one covers a quarter
 * of the plot, and the trend line leaves the same point travelling across
 * exactly that quarter. A fixed rosette of eight positions has no answer — the
 * line passes through all of them — and the least-bad choice was a label lying
 * on the line at 3M, 6M, 1Y and All simultaneously. Numbers taken from that
 * failing render.
 */
test('a wide label at the left edge steps away from a line rather than settling on it', () => {
  const line: Pt[] = [];
  for (let i = 0; i < 58; i++) line.push({ x: 45.2 + i * 2.2, y: 21.43 + i * 1.295 });
  const [p] = placeLabels(
    [{ key: 'first', anchor: { x: 40.72, y: 20.06 }, w: 65.56, h: 16, text: '100.0000' }],
    [line],
    BOX,
  );
  expect(p.clear).toBe(true);
  expect(polylineHitsRect(line, p.rect)).toBe(false);
  // And it is still the NEAREST clear rung — the ladder steps away, it does not
  // exile the label to the far corner.
  expect(Math.abs(p.centre.y - 20.06)).toBeLessThan(90);
});

/**
 * The degenerate end of tightening: ONE reading, logged today.
 *
 * It fills a single day, so an unfloored rule shrinks the axis to two days and
 * the chip that says `1M` sits above ticks reading `18 Aug · 19 Aug · Today`.
 * A week is the narrowest span that still looks like a period.
 */
test('tightening stops at a week, however little data there is', () => {
  const s = seriesOf([{ on: TODAY, value: 94 }], '1M');
  const w = plotWindow(s);
  expect(w.clipped).toBe(true);
  expect(w.toDay - w.fromDay + 1).toBeGreaterThanOrEqual(7);
});
