import { MIN_TREND_READINGS, TREND_DAYS, type Measured } from '../anthropometry';
import { buildTrendSeries, MIN_SPAN_KG, RANGE_DAYS, trendBounds } from '../weightTrend';

/**
 * The windowing and fitting for the weight chart.
 *
 * `today` is a parameter everywhere, so none of this reads a clock — the same
 * reason `lib/countdown.ts` takes `now`. A chart test that depends on the real
 * date passes today and fails in March.
 *
 * What is deliberately NOT tested here: the mean itself. That is
 * `anthropometry.test.ts`'s job and this file must not grow a second opinion
 * about it — these tests assert which days get asked and what happens to the
 * answers, never what the answer should be.
 */

/** Daily readings ending at `to`, so a run of days is one line of setup. */
const daily = (to: string, kgs: number[]): Measured[] =>
  kgs.map((kg, i) => ({
    measured_on: new Date(Date.parse(`${to}T00:00:00Z`) - (kgs.length - 1 - i) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    weight_kg: kg,
  }));

const TODAY = '2026-08-17';

describe('the window a range covers', () => {
  it('ends today and spans the range, inclusive', () => {
    const s = buildTrendSeries([], TODAY, 'week');
    expect(s.to).toBe(TODAY);
    // Seven days INCLUDING today, so six back — not seven. An off-by-one here
    // shifts every point without changing the shape, which looks correct.
    expect(s.from).toBe('2026-08-11');
  });

  it('spans a month and a year the same way', () => {
    expect(buildTrendSeries([], TODAY, 'month').from).toBe('2026-07-19');
    // 364 days back, not 365: the window INCLUDES today, so a year ends at
    // 2025-08-18. Writing 2025-08-17 here (today minus a literal year) is the
    // off-by-one the test above warns about, and I made it first time.
    expect(buildTrendSeries([], TODAY, 'year').from).toBe('2025-08-18');
    expect(RANGE_DAYS.year).toBe(365);
  });

  it('drops readings outside the window rather than clipping them to the edge', () => {
    // A reading older than the window must not appear at day 0 — that would
    // draw January's weight as if it were measured last Monday.
    const old = [{ measured_on: '2026-01-01', weight_kg: 90 }];
    expect(buildTrendSeries(old, TODAY, 'week').readings).toEqual([]);
  });

  it('drops readings dated in the future', () => {
    // A device with a wrong clock can write one. Clipped to the right edge it
    // would be a lie about when it happened; left in it would stretch the axis
    // into empty space.
    const ahead = [{ measured_on: '2026-08-20', weight_kg: 80 }];
    expect(buildTrendSeries(ahead, TODAY, 'week').readings).toEqual([]);
  });

  it('ignores a reading with no weight, or a nonsense one', () => {
    const junk: Measured[] = [
      { measured_on: TODAY, weight_kg: null },
      { measured_on: TODAY, weight_kg: 0 },
      { measured_on: TODAY, weight_kg: -80 },
      { measured_on: TODAY },
    ];
    expect(buildTrendSeries(junk, TODAY, 'week').readings).toEqual([]);
  });
});

describe('the smoothed line', () => {
  it('runs on every day with enough readings behind it, not only on weigh-in days', () => {
    // A rolling mean is defined on any date with readings behind it. If the
    // line only existed on days somebody stepped on the scale it would jump
    // between them rather than running through them.
    // Thirteen days of readings for a seven-day window, because the mean at
    // the LEFT edge looks back seven days before it — see the edge test below.
    // Supplying only the window's own days leaves its first days short of
    // `MIN_TREND_READINGS`, which is the code being right and a fixture being
    // lazy; it cost three failures to notice.
    const kgs = [80, 80.4, 79.8, 80.1, 80, 79.9, 79.7, 80, 80.2, 79.6, 80.1, 79.9, 80];
    const s = buildTrendSeries(daily(TODAY, kgs), TODAY, 'week');
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0]).toHaveLength(RANGE_DAYS.week);
  });

  it('BREAKS across a gap instead of drawing a line through it', () => {
    // THE property of this file. A line chart interpolates by default, so a
    // fortnight nobody weighed in becomes a confident straight line — the app
    // inventing data. The nulls `trendWeight` returns are kept as breaks.
    const early = daily('2026-07-24', [80, 80, 80, 80, 80, 80, 80]);
    const late = daily(TODAY, [78, 78, 78, 78, 78, 78, 78]);
    const s = buildTrendSeries([...early, ...late], TODAY, 'month');
    expect(s.segments.length).toBeGreaterThan(1);
    // And nothing bridges the hole: no segment contains both sides.
    for (const seg of s.segments) {
      const days = seg.map((p) => p.day);
      expect(Math.max(...days) - Math.min(...days)).toBe(days.length - 1);
    }
  });

  it('says nothing at all below the minimum number of readings', () => {
    // Two readings is not a trend, and the card's own rule is that null means
    // "not enough yet" rather than zero.
    const sparse = daily(TODAY, [80, 80]).slice(0, MIN_TREND_READINGS - 1);
    expect(buildTrendSeries(sparse, TODAY, 'week').segments).toEqual([]);
  });

  it('reaches the left edge using readings from BEFORE the window', () => {
    // The mean looks back seven days, so the leftmost day of a month chart is
    // computed from readings in the month before it. Windowing the input first
    // would make every chart start from nothing and climb — an artefact of the
    // crop, not something the athlete did.
    const s = buildTrendSeries(daily(TODAY, new Array(40).fill(80)), TODAY, 'month');
    expect(s.segments[0][0].day).toBe(0);
    expect(TREND_DAYS).toBeGreaterThan(1);
  });
});

describe('the change across the window', () => {
  it('measures trend to trend, both ends', () => {
    const falling = daily(TODAY, [83, 83, 83, 82, 82, 82, 82, 81, 81, 81, 80, 80, 80]);
    const s = buildTrendSeries(falling, TODAY, 'week');
    expect(s.deltaKg).not.toBeNull();
    expect(s.deltaKg!).toBeLessThan(0);
  });

  it('refuses a delta when the line does not reach both edges', () => {
    // Otherwise it measures a shorter span than the one on screen and labels
    // it with the range's name — "down 2kg this month" from nine days of data.
    const recentOnly = daily(TODAY, [80, 80, 80, 79]);
    const s = buildTrendSeries(recentOnly, TODAY, 'month');
    expect(s.segments.length).toBeGreaterThan(0);
    expect(s.deltaKg).toBeNull();
  });

  it('is null when there is nothing at all', () => {
    const s = buildTrendSeries([], TODAY, 'week');
    expect(s.deltaKg).toBeNull();
    expect(s.low).toBeNull();
    expect(s.high).toBeNull();
  });
});

describe('fitting the box', () => {
  it('fits the data rather than starting at zero', () => {
    // A zero-based axis puts an athlete's entire year in the top 5% of the box
    // and renders it flat. Body mass has no meaningful zero to compare to.
    const b = trendBounds({ low: 78, high: 82 })!;
    expect(b.min).toBeGreaterThan(0);
    expect(b.min).toBeLessThan(78);
    expect(b.max).toBeGreaterThan(82);
  });

  it('gives a flat series a real span instead of dividing by zero', () => {
    // One reading, or a genuinely stable fortnight. Zero height would make the
    // scale NaN and the line vanish.
    const b = trendBounds({ low: 80, high: 80 })!;
    expect(b.max - b.min).toBeCloseTo(MIN_SPAN_KG, 5);
    expect((b.min + b.max) / 2).toBeCloseTo(80, 5);
  });

  it('has no bounds when there is no data', () => {
    expect(trendBounds({ low: null, high: null })).toBeNull();
  });

  it('covers the raw readings too, not just the trend', () => {
    // The readings are drawn behind the line and swing wider than it does.
    // Bounds from the trend alone would clip them outside the box.
    const spiky = daily(TODAY, [80, 84, 76, 80, 80, 80, 80]);
    const s = buildTrendSeries(spiky, TODAY, 'week');
    expect(s.high!).toBeGreaterThanOrEqual(84);
    expect(s.low!).toBeLessThanOrEqual(76);
  });
});
