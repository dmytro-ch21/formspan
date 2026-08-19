import {
  buildTrend,
  projectToGoal,
  RANGE_DAYS,
  trendBounds,
  type Reading,
  type TrendSeries,
} from '../trendSeries';

const TODAY = '2026-08-19';

/** A reading every `every` days, ending `endOffset` days before today. */
function every(days: number, step: number, from: number, delta: number): Reading[] {
  const out: Reading[] = [];
  for (let i = days - 1; i >= 0; i -= step) {
    out.push({ on: shift(TODAY, -i), value: from + delta * (days - 1 - i) });
  }
  return out;
}

function shift(on: string, days: number): string {
  return new Date(Date.parse(`${on}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A smoother that just averages the readings on or before a date, 7-day window. */
function meanSmoother(readings: Reading[], minReadings = 1) {
  return (on: string) => {
    const from = shift(on, -6);
    const inWindow = readings.filter((r) => r.on >= from && r.on <= on);
    if (inWindow.length < minReadings) return null;
    return inWindow.reduce((s, r) => s + r.value, 0) / inWindow.length;
  };
}

// ---------------------------------------------------------------------------
// A gap is a hole, not a straight line
// ---------------------------------------------------------------------------

// The whole reason segments exist. A line chart interpolates by default, so a
// fortnight nobody weighed in becomes a confident straight line through the
// middle of it — the app inventing a fortnight of data.
test('a gap in the data breaks the line into segments rather than spanning it', () => {
  const readings: Reading[] = [
    { on: shift(TODAY, -29), value: 100 },
    { on: shift(TODAY, -28), value: 100 },
    // ...three weeks of nothing...
    { on: shift(TODAY, -2), value: 96 },
    { on: shift(TODAY, -1), value: 96 },
  ];
  const s = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings) });

  expect(s.segments.length).toBeGreaterThan(1);
  // And no single segment spans the hole.
  for (const seg of s.segments) {
    const spanned = seg[seg.length - 1].day - seg[0].day;
    expect(spanned).toBeLessThan(20);
  }
});

test('an unbroken run stays one segment', () => {
  const readings = every(30, 1, 100, -0.1);
  const s = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings) });
  expect(s.segments).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// An empty series says WHICH kind of empty
// ---------------------------------------------------------------------------

// The distinction the whole union exists for. Four states that a bare
// `points.length === 0` collapses into one sentence that is wrong for three.
describe('emptiness is discriminated', () => {
  test('could not load is not "no data"', () => {
    const s = buildTrend({ readings: null, today: TODAY, range: '1M' });
    expect(s.empty).toEqual({ kind: 'unavailable' });
  });

  test('never recorded anything', () => {
    const s = buildTrend({ readings: [], today: TODAY, range: '1M' });
    expect(s.empty).toEqual({ kind: 'none' });
  });

  // The one a collapsed check gets wrong: two years of weigh-ins reported as
  // "no data yet" the moment the athlete taps 1W.
  test('readings exist, just not in this window', () => {
    const readings: Reading[] = [{ on: shift(TODAY, -300), value: 100 }];
    const s = buildTrend({ readings, today: TODAY, range: '1W' });
    expect(s.empty).toEqual({ kind: 'none-in-range', totalReadings: 1 });
  });

  test('too few to smooth reports the counts rather than claiming nothing exists', () => {
    const readings: Reading[] = [{ on: shift(TODAY, -1), value: 100 }];
    const s = buildTrend({
      readings,
      today: TODAY,
      range: '1M',
      smooth: meanSmoother(readings, 3),
      minReadings: 3,
    });
    expect(s.empty).toEqual({ kind: 'too-few', have: 1, need: 3 });
  });

  test('a drawable series is not empty at all', () => {
    const readings = every(30, 1, 100, -0.1);
    const s = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings) });
    expect(s.empty).toBeNull();
  });
});

// `unavailable` must be decided before any counting, or an empty array and a
// failed load converge on the same answer.
test('a failed load is never downgraded to "no readings"', () => {
  const s = buildTrend({ readings: null, today: TODAY, range: 'All' });
  expect(s.empty?.kind).toBe('unavailable');
  expect(s.empty?.kind).not.toBe('none');
});

// ---------------------------------------------------------------------------
// A delta says how many readings it came from
// ---------------------------------------------------------------------------

test('a delta carries its reading count and its window', () => {
  const readings = every(30, 1, 100, -0.1);
  const s = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings) });
  expect(s.delta).not.toBeNull();
  expect(s.delta!.n).toBe(readings.length);
  expect(s.delta!.basis).toBe('smoothed');
});

// The claim that matters: a delta off two readings and off two hundred are
// different claims, and `n` is what lets the label say which.
test('the same change from far fewer readings reports a far smaller n', () => {
  const many = every(30, 1, 100, -0.1);
  const few: Reading[] = [
    { on: shift(TODAY, -29), value: 100 },
    { on: TODAY, value: 97.1 },
  ];
  const a = buildTrend({ readings: many, today: TODAY, range: '1M', smooth: meanSmoother(many) });
  const b = buildTrend({ readings: few, today: TODAY, range: '1M', smooth: meanSmoother(few) });
  expect(a.delta!.n).toBeGreaterThan(b.delta!.n);
});

// A delta measured off raw readings must not borrow the smoothed line's
// credibility — body mass swings 1–2 kg inside a day on water alone.
test('a delta that could not use the line admits it', () => {
  const readings: Reading[] = [
    { on: shift(TODAY, -20), value: 100 },
    { on: shift(TODAY, -3), value: 98 },
  ];
  const s = buildTrend({ readings, today: TODAY, range: '1M' }); // no smoother
  expect(s.delta!.basis).toBe('readings');
});

test('one reading is a position, not a change', () => {
  const s = buildTrend({ readings: [{ on: TODAY, value: 100 }], today: TODAY, range: '1M' });
  expect(s.delta).toBeNull();
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

test('every preset window ends today', () => {
  const readings = every(400, 1, 100, -0.01);
  for (const range of ['1W', '1M', '3M', '6M', '1Y', 'All'] as const) {
    const s = buildTrend({ readings, today: TODAY, range });
    expect(s.to).toBe(TODAY);
  }
});

test('the fixed windows span the days they name', () => {
  const readings = every(400, 1, 100, -0.01);
  for (const [range, days] of Object.entries(RANGE_DAYS)) {
    const s = buildTrend({ readings, today: TODAY, range: range as '1W' });
    expect(s.from).toBe(shift(TODAY, -(days - 1)));
  }
});

test('All reaches back to the first reading', () => {
  const readings: Reading[] = [
    { on: '2025-01-01', value: 100 },
    { on: TODAY, value: 90 },
  ];
  const s = buildTrend({ readings, today: TODAY, range: 'All' });
  expect(s.from).toBe('2025-01-01');
});

test('Plan reaches back to the plan start', () => {
  const readings = every(400, 1, 100, -0.01);
  const s = buildTrend({ readings, today: TODAY, range: 'Plan', planFrom: '2026-06-01' });
  expect(s.from).toBe('2026-06-01');
});

// A zero-width window would render as a single point and read as "you have one
// reading", which is a statement about the athlete rather than about the range.
test('Plan with no live plan falls back to a real window rather than collapsing', () => {
  const readings = every(400, 1, 100, -0.01);
  const s = buildTrend({ readings, today: TODAY, range: 'Plan', planFrom: null });
  expect(s.from).not.toBe(TODAY);
  expect(s.readings.length).toBeGreaterThan(1);
});

// A device with a wrong clock writes these. A point past the right edge would
// either be clipped to it — a lie about when it happened — or stretch the axis.
test('readings dated in the future are dropped', () => {
  const readings: Reading[] = [
    { on: TODAY, value: 100 },
    { on: shift(TODAY, 5), value: 50 },
  ];
  const s = buildTrend({ readings, today: TODAY, range: '1M' });
  expect(s.readings).toHaveLength(1);
  expect(s.high).toBe(100);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

// A body-mass line starting at zero puts a year of work in the top 5% of the
// box and reads as flat.
test('bounds are not zero-based', () => {
  const b = trendBounds({ low: 95, high: 105 }, { minSpan: 1 });
  expect(b!.min).toBeGreaterThan(0);
  expect(b!.min).toBeLessThan(95);
});

// Otherwise the dashed goal line is drawn off the top of the chart and the
// projection heads for nothing visible.
test('a goal outside the data widens the axis to include it', () => {
  const b = trendBounds({ low: 95, high: 105 }, { minSpan: 1, goal: 80 });
  expect(b!.min).toBeLessThanOrEqual(80);
});

test('a flat series gets a minimum span rather than dividing by zero', () => {
  const b = trendBounds({ low: 100, high: 100 }, { minSpan: 1 });
  expect(b!.max - b!.min).toBeCloseTo(1);
});

test('no data means no bounds', () => {
  expect(trendBounds({ low: null, high: null }, { minSpan: 1 })).toBeNull();
});

// ---------------------------------------------------------------------------
// The projection is a claim about the future
// ---------------------------------------------------------------------------

function losing(): TrendSeries {
  const readings = every(60, 1, 100, -0.05); // 100 kg down to ~97
  return buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) });
}

test('a projection carries the rate and evidence it assumed', () => {
  const p = projectToGoal(losing(), 90);
  expect(p.kind).toBe('projected');
  if (p.kind !== 'projected') return;
  expect(p.basis.goal).toBe(90);
  expect(p.basis.ratePerWeek).toBeLessThan(0);
  expect(p.basis.spanDays).toBeGreaterThan(0);
  expect(p.basis.n).toBeGreaterThan(0);
  expect(p.onDate > TODAY).toBe(true);
});

// Every one of these must render as a sentence naming the absence, never as a
// blank space where a projection would be.
describe('the four refusals are distinguishable', () => {
  test('no goal set — a maintenance phase has no number to hit', () => {
    expect(projectToGoal(losing(), null)).toEqual({ kind: 'none', reason: 'no-goal' });
  });

  test('not enough span to state a rate', () => {
    const readings = every(3, 1, 100, -0.1);
    const s = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings) });
    expect(projectToGoal(s, 90)).toEqual({ kind: 'none', reason: 'no-trend' });
  });

  // THE ONE THAT WOULD RENDER A LIE. A rate running away from the goal divides
  // to a negative number of days, which formats as a date in the PAST and reads
  // as a goal already met.
  test('moving away from the goal never produces a date', () => {
    const readings = every(60, 1, 100, +0.05); // gaining
    const s = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) });
    const p = projectToGoal(s, 90);
    expect(p).toEqual({ kind: 'none', reason: 'moving-away' });
  });

  test('a flat trend is stalled, not a date decades away', () => {
    const readings = every(60, 1, 100, 0);
    const s = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) });
    expect(projectToGoal(s, 90)).toEqual({ kind: 'none', reason: 'stalled' });
  });

  test('already there', () => {
    const readings = every(60, 1, 90, 0);
    const s = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) });
    expect(projectToGoal(s, 90)).toEqual({ kind: 'none', reason: 'reached' });
  });
});

// Gaining toward a goal above you is progress, not "moving away" — the check is
// on direction relative to the goal, not on the sign of the rate.
test('gaining toward a higher goal projects normally', () => {
  const readings = every(60, 1, 70, +0.05);
  const s = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) });
  const p = projectToGoal(s, 80);
  expect(p.kind).toBe('projected');
});
