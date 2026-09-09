import type { Measured } from '../anthropometry';
import { MIN_SPARK_POINTS, SPARK_DAYS, sparkPolyline, sparkWeek } from '../sparkWeek';

/**
 * The arithmetic behind Today's seven-day weight line (N201/#637).
 *
 * **The bug these exist for is not a rendering bug.** `Spark` used to place a
 * point at `(i / (n - 1)) * width` — its index in the list of readings — which
 * is invisible until an axis appears underneath it, and then it is a component
 * whose job is reporting measurements putting Thursday's weigh-in under
 * Tuesday's letter. Geometry is the one part of a chart a "did it render"
 * assertion can never see, so it is asserted here as numbers and again against
 * the real drawing in `components/__tests__/progressSpark.test.tsx`.
 *
 * `2026-08-30` is a Sunday, so the seven slots ending on it spell exactly the
 * `M T W T F S S` the reference (`~/Desktop/trend-face.jpeg`) shows.
 */

const TODAY = '2026-08-30';
const MON = '2026-08-24';
const TUE = '2026-08-25';
const WED = '2026-08-26';
const THU = '2026-08-27';
const FRI = '2026-08-28';
const SAT = '2026-08-29';
const SUN = '2026-08-30';

const BOX = { width: 132, height: 52, inset: 7, pad: 9 };

function w(measured_on: string, weight_kg: number | null): Measured {
  return { measured_on, weight_kg };
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

test('seven slots, oldest first, ending today', () => {
  const { days } = sparkWeek([], TODAY, BOX);
  expect(days).toHaveLength(SPARK_DAYS);
  expect(days.map((d) => d.on)).toEqual([MON, TUE, WED, THU, FRI, SAT, SUN]);
});

test('the letters are the weekdays of those seven dates', () => {
  const { days } = sparkWeek([], TODAY, BOX);
  expect(days.map((d) => d.letter)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
});

// The grid ends today, so today is the last slot — never a slot in the middle,
// whatever the reference's mock happens to show.
test('only the last slot is today', () => {
  const { days } = sparkWeek([], TODAY, BOX);
  expect(days.map((d) => d.isToday)).toEqual([false, false, false, false, false, false, true]);
});

test('the letters rotate with the day the week ends on', () => {
  // A Wednesday. The same seven slots, a different seven letters — a fixed
  // `M…S` string would be wrong on six days in seven.
  const { days } = sparkWeek([], WED, BOX);
  expect(days.map((d) => d.letter)).toEqual(['T', 'F', 'S', 'S', 'M', 'T', 'W']);
});

test('slots are evenly spaced, first and last inset from the edges', () => {
  const { days } = sparkWeek([], TODAY, BOX);
  expect(days[0].x).toBeCloseTo(7, 6);
  expect(days[6].x).toBeCloseTo(125, 6);
  const gaps = days.slice(1).map((d, i) => d.x - days[i].x);
  for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 6);
});

// ---------------------------------------------------------------------------
// The fix: x comes from the DATE, not from the index
// ---------------------------------------------------------------------------

/**
 * **This is the test the ticket was written around.** Six readings in a
 * seven-day week with Wednesday missing. Index positioning spreads six points
 * across the full width — the sixth of them, Sunday, lands at the last slot by
 * luck, but Thursday lands at slot 2 (Wednesday's letter), Friday at slot 3,
 * Saturday at slot 4. Every reading after the gap is reported a day early.
 */
test('a missing day leaves a gap; every other point keeps its own letter', () => {
  const readings = [
    w(MON, 92.0),
    w(TUE, 91.8),
    // no Wednesday
    w(THU, 91.5),
    w(FRI, 91.4),
    w(SAT, 91.2),
    w(SUN, 91.0),
  ];
  const { days, points } = sparkWeek(readings, TODAY, BOX);

  expect(points).toHaveLength(6);
  expect(points.map((p) => p.on)).not.toContain(WED);

  const slot = new Map(days.map((d) => [d.on, d.x]));
  for (const p of points) {
    expect(p.x).toBeCloseTo(slot.get(p.on) as number, 6);
  }

  // Stated as absolute numbers as well, because the loop above would still
  // pass if BOTH sides were computed from the index. Thursday is the fourth
  // slot of seven, and it is the fourth wherever it sits in the array.
  const thu = points.find((p) => p.on === THU)!;
  expect(thu.x).toBeCloseTo(66, 6);
  // What index positioning would have produced for the same reading: the third
  // of six points, at (2/5) * (132 - 10) + 5.
  expect(thu.x).not.toBeCloseTo(53.8, 1);
});

test('one reading at each end of the week does not stretch to fill it', () => {
  const { points } = sparkWeek([w(MON, 92), w(TUE, 91.6)], TODAY, BOX);
  // Index positioning puts two points at the two ENDS of the box. These two
  // are Monday and Tuesday, so they belong in the first two slots and the
  // right-hand five sevenths of the chart stays empty.
  expect(points[0].x).toBeCloseTo(7, 6);
  expect(points[1].x).toBeCloseTo(26.6667, 3);
});

test('a reading older than the window is not placed at all', () => {
  const readings = [w('2026-08-23', 95), w(TUE, 91.8), w(SUN, 91)];
  const { points } = sparkWeek(readings, TODAY, BOX);
  expect(points.map((p) => p.on)).toEqual([TUE, SUN]);
});

test('a reading dated after today is not placed either', () => {
  const readings = [w(SAT, 91.2), w(SUN, 91), w('2026-08-31', 90)];
  const { points } = sparkWeek(readings, TODAY, BOX);
  expect(points.map((p) => p.on)).toEqual([SAT, SUN]);
});

test('readings arriving out of order are still placed by date', () => {
  const { points } = sparkWeek([w(SUN, 91), w(MON, 92), w(THU, 91.5)], TODAY, BOX);
  expect(points.map((p) => p.on)).toEqual([MON, THU, SUN]);
  expect(points.map((p) => p.x)).toEqual([7, 66, 125].map((n) => expect.closeTo(n, 6)));
});

// Two saves of one day are one fact, not a same-day swing the chart can date.
test('two readings on one day collapse to the later one', () => {
  const { points } = sparkWeek([w(MON, 92), w(MON, 91.5), w(SUN, 91)], TODAY, BOX);
  expect(points).toHaveLength(2);
  expect(points[0].value).toBe(91.5);
});

// ---------------------------------------------------------------------------
// Drawing nothing is a real answer
// ---------------------------------------------------------------------------

test('one reading draws no line', () => {
  expect(sparkWeek([w(SUN, 91)], TODAY, BOX).points).toEqual([]);
  expect(MIN_SPARK_POINTS).toBe(2);
});

test('no readings draw no line, and the grid is still described', () => {
  const { days, points } = sparkWeek([], TODAY, BOX);
  expect(points).toEqual([]);
  expect(days).toHaveLength(SPARK_DAYS);
});

test('a null or non-positive weight is not a reading', () => {
  const readings = [w(MON, null), w(TUE, 0), w(WED, -1), w(THU, 91)];
  expect(sparkWeek(readings, TODAY, BOX).points).toEqual([]);
});

test('the polyline is empty below two points', () => {
  expect(sparkPolyline([])).toBe('');
  expect(sparkPolyline(sparkWeek([w(SUN, 91)], TODAY, BOX).points)).toBe('');
});

// ---------------------------------------------------------------------------
// The vertical axis
// ---------------------------------------------------------------------------

test('a heavier reading sits higher in the box', () => {
  const { points } = sparkWeek([w(MON, 92), w(SUN, 90)], TODAY, BOX);
  expect(points[0].y).toBeLessThan(points[1].y);
  expect(points[0].y).toBeCloseTo(BOX.pad, 6);
  expect(points[1].y).toBeCloseTo(BOX.height - BOX.pad, 6);
});

test('a perfectly flat week does not divide by zero', () => {
  const { points } = sparkWeek([w(MON, 91), w(WED, 91), w(SUN, 91)], TODAY, BOX);
  for (const p of points) expect(Number.isFinite(p.y)).toBe(true);
  // Mid-box rather than pinned to the top edge.
  for (const p of points) expect(p.y).toBeCloseTo(BOX.height - BOX.pad, 6);
});

// Below the lowest point, not level with it: the lightest reading of the week
// still needs a visible line down to its letter.
test('the baseline is the foot of the plot box, below every point', () => {
  const { points, baseline } = sparkWeek([w(MON, 92), w(SUN, 90)], TODAY, BOX);
  expect(baseline).toBe(BOX.height);
  for (const p of points) expect(p.y).toBeLessThan(baseline);
});

// ---------------------------------------------------------------------------
// The ringed point
// ---------------------------------------------------------------------------

test('only the most recent reading is the latest', () => {
  const { points } = sparkWeek([w(MON, 92), w(THU, 91.5), w(SAT, 91.2)], TODAY, BOX);
  expect(points.map((p) => p.latest)).toEqual([false, false, true]);
});

// The ring marks the newest READING, which is not always today: an athlete who
// last weighed in on Thursday should see the ring on Thursday, not floating on
// today's empty slot.
test('the latest point is the last reading, not today', () => {
  const { points } = sparkWeek([w(MON, 92), w(THU, 91.5)], TODAY, BOX);
  const latest = points.find((p) => p.latest)!;
  expect(latest.on).toBe(THU);
  expect(latest.x).toBeCloseTo(66, 6);
});

test('the polyline joins the points in date order', () => {
  const { points } = sparkWeek([w(MON, 92), w(SUN, 90)], TODAY, BOX);
  expect(sparkPolyline(points)).toBe('7,9 125,43');
});
