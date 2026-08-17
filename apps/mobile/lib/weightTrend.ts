import { daysBetween, shiftDate, trendWeight, type Measured } from './anthropometry';

/**
 * Turning check-ins into something a phone can draw.
 *
 * **The arithmetic is NOT here.** `lib/anthropometry.ts` owns what a trend
 * means — the seven-day rolling mean, the minimum readings, the rate — and this
 * file only decides which days to ask it about and how to fit the answers into
 * a box. A second implementation of the mean would be a third number the app
 * could report for the same body, which is the defect this whole area was
 * written to avoid.
 *
 * ## Why the trend line and the readings are separate series
 *
 * Body mass swings 1–2 kg inside a day on water, glycogen and last night's
 * meal. Drawing the raw readings alone gives a sawtooth nobody can read a
 * direction from; drawing only the smoothed line hides how noisy the underlying
 * data is, which is exactly what an athlete needs to know before believing a
 * two-day "gain". So both are returned and the chart draws the readings faintly
 * behind the trend.
 *
 * ## Gaps are holes, not straight lines
 *
 * A line chart interpolates by default, so a fortnight nobody weighed in comes
 * out as a confident straight line through the middle of it — the app inventing
 * a fortnight of data. `trendWeight` already returns null when a day has too
 * few readings behind it, and {@link buildTrendSeries} preserves those nulls as
 * SEGMENT BREAKS rather than dropping them. A gap therefore renders as a gap.
 */

export type TrendRange = 'week' | 'month' | 'year';

/**
 * How far back each range reaches, and how the x-axis is labelled.
 *
 * A year is 365 days rather than 12 calendar months because the axis is a
 * count of days back from today, not a calendar — the same reason
 * `feed.FeedWindow` on the server is a rolling duration. Calendar months would
 * make the leftmost point's meaning depend on today's date.
 */
export const RANGE_DAYS: Record<TrendRange, number> = {
  week: 7,
  month: 30,
  year: 365,
};

export const RANGES: { key: TrendRange; label: string }[] = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
];

/** One reading, or one day of the smoothed line. `kg` is always kilograms. */
export type TrendPoint = {
  /** `YYYY-MM-DD`. */
  on: string;
  /** Days back from the window's start — 0 at the left edge. */
  day: number;
  kg: number;
};

export type TrendSeries = {
  range: TrendRange;
  /** The window, inclusive at both ends. */
  from: string;
  to: string;
  /** Every raw reading inside the window, oldest first. */
  readings: TrendPoint[];
  /**
   * The smoothed line, split into continuous runs. Each run is drawn as one
   * path; the breaks between them are days with too little data behind them.
   */
  segments: TrendPoint[][];
  /** Lowest and highest KG across BOTH series, or null when there is nothing. */
  low: number | null;
  high: number | null;
  /**
   * Change across the window, trend-to-trend, in kg. Null unless the smoothed
   * line exists at both ends — a delta measured off two raw readings is the
   * noise this file exists to suppress, and it is the number an athlete would
   * most like to over-read.
   */
  deltaKg: number | null;
};

/**
 * The days the window covers, oldest first.
 *
 * `days` is the span, so a week is today plus the six before it. Off-by-one
 * here shifts every point on the chart by a day without changing its shape,
 * which is the kind of wrong that looks right.
 */
function windowDays(today: string, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(shiftDate(today, -i));
  return out;
}

/**
 * Build both series for a range.
 *
 * `today` is passed in rather than read from the clock so the whole thing is
 * testable — the same reason every function in `lib/countdown.ts` takes `now`.
 *
 * Readings dated in the FUTURE are dropped. They should not exist, but a device
 * with a wrong clock can write one, and a point beyond the right edge would
 * either be clipped to it (a lie about when it happened) or stretch the axis
 * into empty space.
 */
export function buildTrendSeries(
  checkins: Measured[],
  today: string,
  range: TrendRange,
): TrendSeries {
  const days = windowDays(today, RANGE_DAYS[range]);
  const from = days[0];
  const to = days[days.length - 1];

  const readings: TrendPoint[] = checkins
    .filter((c) => c.weight_kg != null && c.weight_kg > 0)
    .map((c) => ({ on: c.measured_on, day: daysBetween(from, c.measured_on), kg: c.weight_kg! }))
    .filter((p) => p.day >= 0 && p.day < days.length)
    .sort((a, b) => a.day - b.day);

  // The smoothed line is asked for every day in the window, INCLUDING days with
  // no reading of their own: a rolling mean is defined on any date that has
  // enough readings behind it, and skipping the empty days would make the line
  // jump between weigh-ins rather than run continuously through them.
  //
  // `trendWeight` is given the whole list, not the windowed one — its seven-day
  // lookback reaches back BEFORE `from`, and windowing first would make the
  // left edge of every chart start from nothing and climb, an artefact of the
  // crop rather than anything the athlete did.
  const segments: TrendPoint[][] = [];
  let run: TrendPoint[] = [];
  days.forEach((on, i) => {
    const kg = trendWeight(checkins, on);
    if (kg == null) {
      if (run.length) segments.push(run);
      run = [];
      return;
    }
    run.push({ on, day: i, kg });
  });
  if (run.length) segments.push(run);

  const all = [...readings, ...segments.flat()];
  const low = all.length ? Math.min(...all.map((p) => p.kg)) : null;
  const high = all.length ? Math.max(...all.map((p) => p.kg)) : null;

  // Trend-to-trend across the window, and only when the line reaches both ends.
  // Taking the first and last SEGMENT would quietly measure a shorter span than
  // the one on screen and label it with the range's name.
  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];
  const startsAtEdge = firstSeg?.[0]?.day === 0;
  const endsAtEdge = lastSeg?.[lastSeg.length - 1]?.day === days.length - 1;
  const deltaKg =
    firstSeg && lastSeg && startsAtEdge && endsAtEdge
      ? round(lastSeg[lastSeg.length - 1].kg - firstSeg[0].kg, 2)
      : null;

  return { range, from, to, readings, segments, low, high, deltaKg };
}

/**
 * The y-axis bounds for a series.
 *
 * **Never zero-based, and that is a deliberate departure from the usual rule.**
 * A bar chart starting above zero exaggerates differences and is rightly
 * frowned on; a body-mass line chart starting at zero is worse, because an
 * athlete's whole year of work occupies the top 5% of the box and reads as a
 * flat line. The quantity has no meaningful zero to compare against — nobody is
 * heading for 0 kg — so the axis fits the data.
 *
 * `pad` keeps the line off the edges. A completely flat series (one reading, or
 * a genuinely stable fortnight) would otherwise have zero height and divide by
 * zero when scaled, so it is given a minimum span and centred in it.
 */
export const MIN_SPAN_KG = 1;

export function trendBounds(
  series: Pick<TrendSeries, 'low' | 'high'>,
  padFraction = 0.1,
): { min: number; max: number } | null {
  if (series.low == null || series.high == null) return null;
  const span = series.high - series.low;
  if (span < MIN_SPAN_KG) {
    const mid = (series.high + series.low) / 2;
    return { min: mid - MIN_SPAN_KG / 2, max: mid + MIN_SPAN_KG / 2 };
  }
  const pad = span * padFraction;
  return { min: series.low - pad, max: series.high + pad };
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
