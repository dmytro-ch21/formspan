import { dayString } from './calendar';
import type { LoadHistory, LoadPoint } from './records';
import { buildTrend, type Reading, type TrendRangeKey, type TrendSeries } from './trendSeries';

/**
 * Per-exercise load, wired onto the shared trend layer — N84, row 11 of the
 * phone-impossible audit.
 *
 * ## Why this passes the carve-out where N6 said it wouldn't
 *
 * N6 shipped this web-only because the at-the-rack decision ("what do I put
 * on the bar today") is already answered by the double-progression
 * recommendation on `app/exercise/[id].tsx` — a chart there would inform
 * nothing that recommendation leaves open. What is left is "is my top set
 * going up over the last few months", asked while planning the next block —
 * and N57's 2026-08-19 amendment to CLAUDE.md's carve-out is exactly what
 * makes that question answerable on a phone now: value-readable axes, a
 * label on the first and latest points, a delta against a stated period and
 * an entries list are all permitted, provided there is still no second metric
 * and no date-range picker. This module fixes the metric at ONE
 * (`top_weight_kg` — "Top set") and the screen offers only the same seven
 * preset windows `app/goals/trend.tsx` does, all ending today. Est. 1RM and
 * Volume — web's other two metric-picker tabs — stay web-only on purpose;
 * offering a picker here is the thing that would turn this into the web
 * screen.
 *
 * ## Why there is no connecting LINE, only dots
 *
 * `buildTrend` draws a connecting line from its `smooth` parameter's output
 * and draws every raw reading as a dot regardless. Body mass is logged (or
 * meant to be) daily, so a gap in the smoothed line is real information — a
 * fortnight nobody weighed in. A lift is not logged daily; it is logged the
 * days it is trained, which can be anywhere from twice a week to once a
 * month, and a "gap" between two real sessions carries no meaning at all —
 * unlike a missed weigh-in, nothing was skipped. Passing no `smooth` here
 * (see `trendSeries.ts`'s own doc comment: *"Omit for a metric with no
 * meaningful smoothing — the chart then draws readings only, and any delta
 * honestly reports `basis: 'readings'`"*) is that case exactly, not an
 * oversight: every session already IS a real reading, so smoothing across the
 * calendar would average a real number with a hole. The chart still answers
 * "is it going up" — first/latest callouts, a delta with its own evidence
 * line, and the entries list carry that — it just does not draw a line
 * through a shape that would be inventing continuity between training days.
 *
 * ## Why there is no goal line
 *
 * A lift has no prescribed target the way a weight-loss phase does — nothing
 * on this athlete's profile says "get your squat to 140kg by March" — so
 * `goal` is always null and `TrendChart` draws no dashed reference line. If a
 * per-exercise goal is ever added, wiring it through here is one line; until
 * then a chart drawing a dashed line toward nothing would be decoration.
 */

export type LoadMetricKey = 'top_weight_kg';

/** The one metric this screen offers — see the file header for why there is no picker. */
export const LOAD_METRIC_LABEL = 'Top set';

function metricValue(p: LoadPoint): number | null {
  return p.top_weight_kg;
}

export type LoadTrend = {
  series: TrendSeries;
  /** Whether this exercise is measured in a way that could ever carry a weight. */
  carriesLoad: boolean;
};

/**
 * Build the trend for one exercise's history.
 *
 * `today` is passed in, not read off the clock, so this stays a pure function
 * — the same discipline `buildTrend` itself and `useWeightTrend`'s callers
 * both hold to.
 */
export function buildLoadTrend(
  history: LoadHistory | null,
  range: TrendRangeKey,
  today: string = dayString(new Date()),
): LoadTrend {
  const carriesLoad = history?.load_type === 'weight_reps';

  // `null` readings (never loaded, or an exercise that structurally cannot
  // carry this metric) are NOT the same as "loaded, and this session has no
  // value for it" — `buildTrend`'s own `unavailable` vs. `none` distinction,
  // carried through rather than collapsed.
  const readings: Reading[] | null =
    history == null
      ? null
      : history.points
          .filter((p) => metricValue(p) != null)
          .map((p) => ({ on: dayString(new Date(p.started_at)), value: metricValue(p) as number }));

  const series = buildTrend({ readings, today, range });

  return { series, carriesLoad };
}
