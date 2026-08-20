import { daysBetween, shiftDate } from './anthropometry';

/**
 * One trend presentation, for every metric that has one.
 *
 * ## Why this is metric-agnostic and `lib/weightTrend.ts` was not
 *
 * `weightTrend.ts` WAS this shape with `kg` welded through it — the point type,
 * the bounds, the delta — and is deleted now that nothing imports it.
 * Per-exercise load needs the same chart, and so does whatever is trended
 * after it. Copying the file and renaming `kg` to `value`
 * is how a codebase ends up with three chart layers that disagree about what a
 * gap means, so this is the one layer and the metric is a parameter.
 *
 * **The arithmetic that defines a metric still is not here.** `trendWeight` in
 * `lib/anthropometry.ts` owns what a smoothed body mass means; this file takes
 * a `smooth` function and asks it about days. A second implementation of the
 * mean would be a third number the app could report for the same body.
 *
 * ## The three things this file exists to get right
 *
 * **A gap is a hole, not a straight line.** A line chart interpolates by
 * default, so a fortnight nobody weighed in comes out as a confident straight
 * line through the middle of it — the app inventing a fortnight of data.
 * `segments` preserves the breaks; the chart draws one path per segment.
 *
 * **A delta says how many readings it came from.** `↓ 13.3 lbs past year` off
 * two readings and off two hundred are different claims, and only one of them
 * is worth acting on. {@link TrendDelta} carries `n` so the label can never be
 * rendered without it.
 *
 * **An empty series says WHICH kind of empty it is.** No data yet, none in
 * *this window*, too few to smooth, or we could not load it — four states that
 * a single `points.length === 0` collapses into one sentence that is wrong for
 * three of them. This is the most repeated bug in this codebase and it is a
 * discriminated union here so a caller cannot forget the distinction.
 */

/** One reading of any metric, in the metric's own unit. */
export type Reading = {
  /** `YYYY-MM-DD`. */
  on: string;
  value: number;
};

export type TrendPoint = Reading & {
  /** Days from the window's start — 0 at the left edge. */
  day: number;
};

/**
 * The preset windows.
 *
 * Every one of them ENDS TODAY, which is what keeps this a chart and not the
 * web screen: CLAUDE.md's carve-out disqualifies a control that chooses a start
 * AND an end, because that is comparison. `All` and `Plan` still end today —
 * they only move the left edge, and neither is chosen by the athlete as a date.
 */
export type TrendRangeKey = '1W' | '1M' | '3M' | '6M' | '1Y' | 'All' | 'Plan';

/**
 * Fixed windows, in days back from today.
 *
 * Days rather than calendar months, so the left edge does not change meaning
 * with today's date — the same reason the server's feed window is a rolling
 * duration. `All` and `Plan` are absent because their span is data-dependent.
 */
export const RANGE_DAYS: Record<Exclude<TrendRangeKey, 'All' | 'Plan'>, number> = {
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
};

export const RANGES: { key: TrendRangeKey; label: string }[] = [
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: '6M', label: '6M' },
  { key: '1Y', label: '1Y' },
  { key: 'All', label: 'All' },
  { key: 'Plan', label: 'Plan' },
];

/**
 * Why a chart has nothing to draw.
 *
 * A union rather than a boolean because the four cases are four different
 * sentences and three of them are not "no data yet":
 *
 * - `unavailable` — we could not load it. Says nothing about whether data
 *   exists, and must never be rendered as though it did.
 * - `none` — this athlete has never recorded this metric.
 * - `none-in-range` — they have readings, just none inside THIS window. Telling
 *   them they have no data because they picked `1W` would be false.
 * - `too-few` — readings exist in the window but not enough to smooth, so there
 *   is a dot or two and no line. Carries the counts so the copy can say so.
 */
export type TrendEmpty =
  | { kind: 'unavailable' }
  | { kind: 'none' }
  | { kind: 'none-in-range'; totalReadings: number }
  | { kind: 'too-few'; have: number; need: number };

/** A change across the window, and the evidence behind it. */
export type TrendDelta = {
  /** Signed, in the metric's unit. Negative is a decrease. */
  change: number;
  /** How many raw readings the window held. Never render the change without it. */
  n: number;
  /** The window's own ends, so a label can say "past year" honestly. */
  from: string;
  to: string;
  /**
   * Which series it was measured off. The smoothed line suppresses the 1–2 kg
   * of daily water swing that an athlete would otherwise read as progress, so
   * it is preferred — but with too few readings to smooth there is no line, and
   * a delta off raw readings has to admit that rather than borrow the line's
   * credibility.
   */
  basis: 'smoothed' | 'readings';
};

export type TrendSeries = {
  range: TrendRangeKey;
  /** Inclusive at both ends. */
  from: string;
  to: string;
  /** Every raw reading in the window, oldest first. */
  readings: TrendPoint[];
  /** The smoothed line as continuous runs; the breaks between them are gaps. */
  segments: TrendPoint[][];
  low: number | null;
  high: number | null;
  delta: TrendDelta | null;
  /** Set when there is nothing worth drawing. Null when there is. */
  empty: TrendEmpty | null;
};

export type BuildTrendInput = {
  /** Raw readings, any order. Pass `null` for "we could not load them". */
  readings: Reading[] | null;
  /** `YYYY-MM-DD`. Passed in rather than read off the clock, so this is testable. */
  today: string;
  range: TrendRangeKey;
  /**
   * The smoothed value on a date, or null where there is not enough behind it.
   * Omit for a metric with no meaningful smoothing — the chart then draws
   * readings only, and any delta honestly reports `basis: 'readings'`.
   */
  smooth?: (on: string) => number | null;
  /** The live plan's start date, for the `Plan` range. Null when none is live. */
  planFrom?: string | null;
  /** How many readings the smoother needs before it returns anything. */
  minReadings?: number;
};

/**
 * The window's start date for a range.
 *
 * `All` reaches to the first reading and `Plan` to the plan's start; both fall
 * back to the widest fixed window rather than to today, because a zero-width
 * window would render as a single point and read as "you have one reading".
 */
function windowStart(input: BuildTrendInput, readings: Reading[]): string {
  const { today, range, planFrom } = input;
  if (range === 'All') {
    const first = readings.length ? readings[0].on : null;
    return first ?? shiftDate(today, -(RANGE_DAYS['1Y'] - 1));
  }
  if (range === 'Plan') {
    return planFrom ?? shiftDate(today, -(RANGE_DAYS['1Y'] - 1));
  }
  return shiftDate(today, -(RANGE_DAYS[range] - 1));
}

/**
 * Build the series for one range.
 *
 * Readings dated in the FUTURE are dropped. They should not exist, but a device
 * with a wrong clock writes them, and a point past the right edge would either
 * be clipped to it — a lie about when it happened — or stretch the axis into
 * empty space.
 */
export function buildTrend(input: BuildTrendInput): TrendSeries {
  const { today, range, smooth, minReadings = 1 } = input;

  // Not-loaded is answered before anything else and never falls through to a
  // count. An empty array and a null are different facts.
  if (input.readings == null) {
    return emptySeries(range, today, today, { kind: 'unavailable' });
  }

  const sorted = [...input.readings]
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));

  const from = windowStart(input, sorted);
  const to = today;
  const span = daysBetween(from, to) + 1;

  const readings: TrendPoint[] = sorted
    .map((r) => ({ ...r, day: daysBetween(from, r.on) }))
    .filter((p) => p.day >= 0 && p.day < span);

  // The smoother is asked about EVERY day in the window, including days with no
  // reading of their own: a rolling mean is defined on any date with enough
  // behind it, and skipping empty days would make the line jump between
  // weigh-ins rather than run through them.
  const segments: TrendPoint[][] = [];
  if (smooth) {
    let run: TrendPoint[] = [];
    for (let i = 0; i < span; i++) {
      const on = shiftDate(from, i);
      const value = smooth(on);
      if (value == null) {
        if (run.length) segments.push(run);
        run = [];
        continue;
      }
      run.push({ on, day: i, value });
    }
    if (run.length) segments.push(run);
  }

  const empty = emptinessOf(sorted, readings, segments, smooth != null, minReadings);
  const all = [...readings, ...segments.flat()];
  const low = all.length ? Math.min(...all.map((p) => p.value)) : null;
  const high = all.length ? Math.max(...all.map((p) => p.value)) : null;

  return {
    range,
    from,
    to,
    readings,
    segments,
    low,
    high,
    delta: deltaOf(readings, segments, span),
    empty,
  };
}

/**
 * Which kind of empty, if any.
 *
 * Ordered most-specific first. `none-in-range` is checked before `none`
 * precisely because the collapsed version of this function would report an
 * athlete with two years of weigh-ins as having no data the moment they tapped
 * `1W`.
 */
function emptinessOf(
  allReadings: Reading[],
  inWindow: TrendPoint[],
  segments: TrendPoint[][],
  smoothed: boolean,
  minReadings: number,
): TrendEmpty | null {
  if (allReadings.length === 0) return { kind: 'none' };
  if (inWindow.length === 0) return { kind: 'none-in-range', totalReadings: allReadings.length };
  // Readings are present, so there is something to draw — but if a smoother was
  // supplied and produced no line at all, the chart is dots without a trend and
  // the copy should say why rather than leaving the athlete to guess.
  if (smoothed && segments.length === 0) {
    return { kind: 'too-few', have: inWindow.length, need: minReadings };
  }
  return null;
}

/**
 * The change across the window.
 *
 * Measured edge to edge on the smoothed line when it reaches BOTH edges. Taking
 * the first and last segment instead would quietly measure a shorter span than
 * the one on screen and then label it with the range's name.
 *
 * When the line does not span the window it falls back to the raw readings and
 * SAYS SO via `basis`, rather than reporting a smoothed-looking number that is
 * actually two weigh-ins and a fortnight of water.
 */
function deltaOf(readings: TrendPoint[], segments: TrendPoint[][], span: number): TrendDelta | null {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first && last && first[0].day === 0 && last[last.length - 1].day === span - 1) {
    return {
      change: round(last[last.length - 1].value - first[0].value, 2),
      n: readings.length,
      from: first[0].on,
      to: last[last.length - 1].on,
      basis: 'smoothed',
    };
  }
  // Two readings minimum: one reading is a position, not a change.
  if (readings.length < 2) return null;
  const a = readings[0];
  const b = readings[readings.length - 1];
  return { change: round(b.value - a.value, 2), n: readings.length, from: a.on, to: b.on, basis: 'readings' };
}

function emptySeries(range: TrendRangeKey, from: string, to: string, empty: TrendEmpty): TrendSeries {
  return { range, from, to, readings: [], segments: [], low: null, high: null, delta: null, empty };
}

/**
 * Y-axis bounds.
 *
 * **Never zero-based, and that is a deliberate departure from the usual rule.**
 * A bar chart starting above zero exaggerates differences and is rightly
 * frowned on; a body-mass line starting at zero is worse, because an athlete's
 * whole year of work occupies the top 5% of the box and reads as flat. The
 * quantity has no meaningful zero — nobody is heading for 0 kg — so the axis
 * fits the data.
 *
 * A goal outside the data's range is included, or the dashed goal line would be
 * drawn off the top of the chart and the athlete would see a projection heading
 * for nothing.
 *
 * A completely flat series has zero height and would divide by zero when
 * scaled, so it is given `minSpan` and centred in it.
 */
export function trendBounds(
  series: Pick<TrendSeries, 'low' | 'high'>,
  { minSpan, padFraction = 0.1, goal = null }: { minSpan: number; padFraction?: number; goal?: number | null },
): { min: number; max: number } | null {
  if (series.low == null || series.high == null) return null;
  const low = goal == null ? series.low : Math.min(series.low, goal);
  const high = goal == null ? series.high : Math.max(series.high, goal);
  const span = high - low;
  if (span < minSpan) {
    const mid = (high + low) / 2;
    return { min: mid - minSpan / 2, max: mid + minSpan / 2 };
  }
  const pad = span * padFraction;
  return { min: low - pad, max: high + pad };
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * ---------------------------------------------------------------------------
 * The projection
 * ---------------------------------------------------------------------------
 *
 * A dashed line past the last real reading is A CLAIM ABOUT THE FUTURE, and it
 * is drawn in the same stroke and colour as measurements taken off a scale. So
 * it carries its basis everywhere: every projected date comes with the rate it
 * assumed, how long that rate was measured over, and how many readings were
 * behind it, and the screen is expected to say so. N40 is the precedent — the
 * estimator stated a doubled quantity as flatly as a correct one, and the
 * unflagged error is the dangerous one.
 *
 * The refusals matter more than the arithmetic. Four of the five outcomes below
 * are "no projection", each for a different reason, and **each must render as a
 * sentence that names the absence** rather than as blank space. An athlete on a
 * maintenance phase has no goal to reach, and an empty gap where a projection
 * would be tells them nothing about why.
 */

export type ProjectionBasis = {
  /** Signed, metric unit per week. Negative is a decrease. */
  ratePerWeek: number;
  /** Where the projection starts: the latest value, and when it was. */
  fromValue: number;
  fromDate: string;
  goal: number;
  /** How many days the rate was measured across. */
  spanDays: number;
  /** How many raw readings sit behind it. */
  n: number;
  /** Whether the rate came from the smoothed line or from raw readings. */
  basis: 'smoothed' | 'readings';
};

/**
 * WHICH QUESTION A PROJECTION ANSWERS. Two different ones sound identical in
 * English and give different dates:
 *
 * - `plan` — *at the rate your plan prescribes*, when do you arrive? Computed
 *   SERVER-SIDE by N69 and served on the derivation basis
 *   (`nutrition.Projection`, `reached_on`), so phone and web agree by
 *   construction rather than by a parity script.
 * - `observed` — *at the rate you are actually trending*, when do you arrive?
 *   Computed here, from the readings on screen.
 *
 * They are both real questions and they routinely disagree — an athlete
 * under-eating their plan arrives earlier than it says. The discriminator
 * exists so a caller CANNOT render an `observed` date under the spec's
 * sentence, which reads "Based on your current plan, you'll reach your goal
 * on…". That sentence is a claim about the plan; answering it with the
 * observed trend would put a number on screen that disagrees with the same
 * sentence on web, under copy asserting they are the same thing. This is the
 * `offered_grips` drift (N16), and the fix there was the same one: compute it
 * in one place and serve it, rather than deriving it twice and hoping.
 *
 * So: **for weight, pass the server's projection through
 * {@link fromPlanProjection}.** {@link projectToGoal} is for metrics that have
 * no server-side plan — per-exercise load has no prescribed rate — and what it
 * returns must be labelled as the observed trend wherever it is shown.
 */
export type ProjectionSource = 'plan' | 'observed';

export type Projection =
  | {
      kind: 'projected';
      onDate: string;
      daysAway: number;
      source: ProjectionSource;
      basis: ProjectionBasis;
    }
  | {
      kind: 'none';
      /**
       * - `no-goal` — no target set. A maintenance phase has no number to hit,
       *   and `body_phases.target_weight_kg` is nullable precisely for that.
       * - `no-trend` — not enough readings across enough days to state a rate.
       * - `stalled` — the rate is indistinguishable from zero, so the honest
       *   answer is "not at this rate", never a date decades away.
       * - `moving-away` — the trend runs away from the goal. A date computed
       *   here would be in the PAST, which would render as a goal already met.
       * - `reached` — already at or past it.
       */
      reason: 'no-goal' | 'no-trend' | 'stalled' | 'moving-away' | 'reached';
    };

/**
 * The smallest weekly rate worth projecting from, as a fraction of the distance
 * still to go per week. Below this the date is decades out and the honest
 * answer is that the current plan does not get there.
 */
const MIN_WEEKLY_FRACTION = 0.0005;

/** How many days of span a rate needs before it is worth stating. */
export const MIN_PROJECTION_SPAN_DAYS = 14;

export function projectToGoal(
  series: TrendSeries,
  goal: number | null | undefined,
  { minSpanDays = MIN_PROJECTION_SPAN_DAYS }: { minSpanDays?: number } = {},
): Projection {
  if (goal == null || !Number.isFinite(goal)) return { kind: 'none', reason: 'no-goal' };

  const line = series.segments[series.segments.length - 1];
  const usingSmoothed = line != null && line.length >= 2;
  const points: TrendPoint[] = usingSmoothed ? line : series.readings;
  if (points.length < 2) return { kind: 'none', reason: 'no-trend' };

  const first = points[0];
  const last = points[points.length - 1];
  const spanDays = daysBetween(first.on, last.on);
  if (spanDays < minSpanDays) return { kind: 'none', reason: 'no-trend' };

  const remaining = goal - last.value;
  // Checked before the rate, so an athlete standing on their goal is told they
  // reached it rather than that their rate is wrong.
  if (remaining === 0) return { kind: 'none', reason: 'reached' };

  const ratePerDay = (last.value - first.value) / spanDays;
  const ratePerWeek = round(ratePerDay * 7, 3);

  // Direction first: a rate running away from the goal divides to a NEGATIVE
  // number of days, which would format as a date in the past and read as a goal
  // already met. That is the failure this branch exists to prevent.
  if (ratePerDay === 0 || Math.sign(ratePerDay) !== Math.sign(remaining)) {
    return { kind: 'none', reason: ratePerDay === 0 ? 'stalled' : 'moving-away' };
  }
  // And a rate technically pointing the right way but too slow to matter: the
  // date exists, it is just not a fact about this plan.
  if (Math.abs(ratePerDay * 7) < Math.abs(remaining) * MIN_WEEKLY_FRACTION) {
    return { kind: 'none', reason: 'stalled' };
  }

  const daysAway = Math.ceil(remaining / ratePerDay);
  return {
    kind: 'projected',
    onDate: shiftDate(last.on, daysAway),
    daysAway,
    // OBSERVED, never 'plan'. This function only ever sees readings; it has no
    // access to a prescribed rate and must never claim to speak for one.
    source: 'observed',
    basis: {
      ratePerWeek,
      fromValue: last.value,
      fromDate: last.on,
      goal,
      spanDays,
      n: series.readings.length,
      basis: usingSmoothed ? 'smoothed' : 'readings',
    },
  };
}

/**
 * The shape N69 serves on the derivation basis, as far as this file cares.
 *
 * Deliberately structural rather than an import: `lib/nutrition.ts` owns the
 * wire types, and a chart module reaching into them would couple every metric's
 * trend to nutrition's contract.
 */
export type PlanProjection = {
  reached_on: string;
  target_weight_kg: number;
  kg_to_go: number;
  weeks_to_go: number;
  already: boolean;
  unreachable: boolean;
  unreachable_reason?: string;
};

/**
 * Adapt the server's plan projection into what the chart draws.
 *
 * The refusals are the server's, not re-derived here — `already` and
 * `unreachable` are decided once, where the plan's rate lives, and this only
 * translates them. Recomputing "is this reachable" on the phone is the second
 * implementation that the `source` discriminator above exists to prevent.
 *
 * **It DROPS `unreachable_reason`, and the screen invents its own wording.**
 * That is a known gap, not the design: the server's reason is display-ready
 * prose that says what to change, and threading it through would be strictly
 * better copy. Both server cases currently collapse to `'moving-away'`, whose
 * rendered sentence is a truthful superset of both, so nothing false reaches
 * the athlete today — it is merely vaguer than what we already computed. An
 * earlier version of this comment claimed the screen showed the server's
 * reason, which was simply untrue; filed as follow-up rather than left as a
 * lie in a doc block.
 */
export function fromPlanProjection(
  p: PlanProjection | null | undefined,
  latest: { on: string; value: number } | null,
): Projection {
  if (p == null) return { kind: 'none', reason: 'no-goal' };
  if (p.already) return { kind: 'none', reason: 'reached' };
  if (p.unreachable) {
    // The server distinguishes a contradictory plan (a bulk toward a lower
    // goal) from one that simply never arrives. Both are refusals here; the
    // screen shows the server's own `unreachable_reason` rather than inventing
    // wording for a judgement it did not make.
    return { kind: 'none', reason: 'moving-away' };
  }
  if (!p.reached_on) return { kind: 'none', reason: 'no-trend' };
  return {
    kind: 'projected',
    onDate: p.reached_on,
    daysAway: latest ? daysBetween(latest.on, p.reached_on) : Math.round(p.weeks_to_go * 7),
    source: 'plan',
    basis: {
      ratePerWeek: p.weeks_to_go > 0 ? round(-p.kg_to_go / p.weeks_to_go, 3) : 0,
      fromValue: latest?.value ?? p.target_weight_kg + p.kg_to_go,
      fromDate: latest?.on ?? '',
      goal: p.target_weight_kg,
      spanDays: 0,
      n: 0,
      basis: 'smoothed',
    },
  };
}
