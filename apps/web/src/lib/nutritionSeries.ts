import { addDays } from "@/lib/history";
import type { HistoryDay } from "@/lib/api";
import type { Checkin, DayTotals, Target } from "@/lib/nutritionApi";

/**
 * The day-by-day series the analytical surface draws.
 *
 * Pure: strings and numbers in, strings and numbers out. No fetching, no
 * React, no dates-with-instants — every key is a `YYYY-MM-DD` the API has
 * already resolved into the athlete's own calendar, so the arithmetic here is
 * `history.ts`'s UTC string arithmetic and nothing else.
 *
 * It exists as its own module because the two rules N28 is *for* are
 * arithmetic rules, and arithmetic is the half a component test cannot pin
 * down. Both are enforced here and covered by `__tests__/nutritionSeries.test.ts`:
 *
 * **1. An unlogged day is a gap, never a zero.** `totals` is `null` for a day
 * with no entries and the renderer draws nothing there. A zero-filled day is a
 * claim that somebody ate nothing, and it is a claim that propagates: it drags
 * every mean toward zero and puts a bar on the floor of the chart that reads
 * as a fasting day rather than as an evening somebody forgot to log. The
 * server already gets this right — `DayTotals` returns rows only for days that
 * have entries — so the danger is entirely on this side, in the reflex to
 * `?? 0` a lookup that missed.
 *
 * **2. An average is labelled with how many days it came from.** Every mean in
 * here is a `{ kcal, days, considered }`, never a bare number, so a caller
 * cannot render the figure without having the count in its hand. Four logged
 * days out of seven is a genuinely different statement than seven out of
 * seven, and a "7-day average" that quietly means "the four of the last seven
 * I bothered with" is the exact dishonesty the label prevents.
 */

/** The mean window, matching the backend's `TrendDays`. */
export const MEAN_WINDOW_DAYS = 7;

/**
 * How many weigh-ins a trend point needs, matching the backend's
 * `MinTrendReadings`. Below it there is no trend, only readings — and one
 * reading through a 7-day smoother is not a smoothed number, it is the same
 * number with a reassuring name on it.
 *
 * Note the weekly ADJUSTMENT rule is stricter still (`MinWeighinsPerHalf`, 4).
 * That is deliberate on the backend's side and not something to reconcile
 * here: this constant governs a line on a chart, that one governs how much
 * somebody eats.
 */
export const MIN_TREND_READINGS = 3;

/** A mean, and the evidence behind it. Never separable — see rule 2 above. */
export type Mean = {
  value: number;
  /** How many days actually contributed. */
  days: number;
  /** How many days were looked at. `days < considered` means gaps. */
  considered: number;
};

export type TrendPoint = {
  kg: number;
  readings: number;
};

export type DayPoint = {
  date: string;
  /** Null where nothing was logged. A GAP — see rule 1. */
  totals: DayTotals | null;
  /** The target live on this day, or null if none had been set yet. */
  target: Target | null;
  /** Trailing 7-day mean intake, or null when no day in the window was logged. */
  mean: Mean | null;
  /** Trailing 7-day mean bodyweight in kg, or null below MIN_TREND_READINGS. */
  trend: TrendPoint | null;
  /** Training on this day, or null. Drawn as the strip under the bars. */
  training: HistoryDay | null;
};

/** Every date in an inclusive range, ascending. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The target live on a day: the newest row on or before it.
 *
 * Not "the row with this date" — a target set in March is what a day in May is
 * judged against, which is why `ListTargets` carries in the row live at the
 * start of the window.
 */
export function targetOn(targets: Target[], on: string): Target | null {
  let best: Target | null = null;
  for (const t of targets) {
    if (t.effective_on <= on && (!best || t.effective_on > best.effective_on)) best = t;
  }
  return best;
}

/**
 * How far back a lead-in has to reach for the left edge's mean to be honest.
 *
 * Without it the first six points of any window are computed from a truncated
 * lookback and read as a dip that is really just the edge of the request. The
 * counts would still be truthful — that is rule 2 doing its job — but "3 days"
 * on the 1st of a window means "the window started" rather than "you logged
 * three days", and those are different facts wearing the same label.
 */
export function leadIn(from: string): string {
  return addDays(from, -(MEAN_WINDOW_DAYS - 1));
}

export type SeriesInput = {
  from: string;
  to: string;
  /** Day roll-ups, which may reach back before `from` for the lead-in. */
  days: DayTotals[];
  targets: Target[];
  checkins: Checkin[];
  training: HistoryDay[];
};

export function buildSeries(input: SeriesInput): DayPoint[] {
  const byDay = new Map(input.days.map((d) => [d.eaten_on, d]));
  const byTraining = new Map(input.training.map((d) => [d.date, d]));
  // Weigh-ins only. A check-in that recorded a waist and no scale is a real
  // check-in and not a weight reading, so counting it would inflate `readings`
  // with rows that contribute nothing to the mean.
  const byWeight = new Map<string, number>();
  for (const c of input.checkins) {
    if (c.weight_kg != null) byWeight.set(c.measured_on, c.weight_kg);
  }

  return dateRange(input.from, input.to).map((date) => {
    const window = dateRange(addDays(date, -(MEAN_WINDOW_DAYS - 1)), date);

    let sum = 0;
    let logged = 0;
    for (const d of window) {
      const row = byDay.get(d);
      // No `?? 0`. A missing row contributes nothing to the sum AND nothing to
      // the divisor — which is the whole difference between a mean of what was
      // eaten and a mean dragged down by days nobody recorded.
      if (row) {
        sum += row.kcal;
        logged += 1;
      }
    }

    let weightSum = 0;
    let readings = 0;
    for (const d of window) {
      const kg = byWeight.get(d);
      if (kg != null) {
        weightSum += kg;
        readings += 1;
      }
    }

    return {
      date,
      totals: byDay.get(date) ?? null,
      target: targetOn(input.targets, date),
      mean:
        logged > 0
          ? { value: sum / logged, days: logged, considered: window.length }
          : null,
      trend:
        readings >= MIN_TREND_READINGS
          ? { kg: weightSum / readings, readings }
          : null,
      training: byTraining.get(date) ?? null,
    };
  });
}

/**
 * The mean of a whole window, for the headline figure.
 *
 * Same contract as the rolling one and for the same reason: it returns its own
 * denominator, so no caller can print the number without the count.
 */
export function windowMean(
  points: DayPoint[],
  pick: (t: DayTotals) => number,
): Mean | null {
  let sum = 0;
  let days = 0;
  for (const p of points) {
    if (p.totals) {
      sum += pick(p.totals);
      days += 1;
    }
  }
  if (days === 0) return null;
  return { value: sum / days, days, considered: points.length };
}

/**
 * How many of the window's days have anything logged on them.
 *
 * Rendered next to every average, and it is the number that decides whether
 * the chart is showing eating habits or showing logging habits.
 */
export function adherence(points: DayPoint[]): { logged: number; considered: number } {
  return {
    logged: points.filter((p) => p.totals !== null).length,
    considered: points.length,
  };
}

/**
 * The phrase every average is rendered with. One function so the wording
 * cannot drift between the six places that need it, and so "from 1 day" never
 * comes out as "from 1 days".
 */
export function fromDays(mean: Mean): string {
  return `from ${mean.days} of ${mean.considered} ${mean.considered === 1 ? "day" : "days"}`;
}

/**
 * The net change across a window's trend line: last point minus first.
 *
 * Null unless BOTH ends have a real trend point. Substituting a raw weigh-in
 * for a missing end would compare a smoothed number against an unsmoothed one
 * and report the day's water weight as progress.
 */
export function trendChangeKG(points: DayPoint[]): { kg: number; from: string; to: string } | null {
  const withTrend = points.filter((p) => p.trend !== null);
  if (withTrend.length < 2) return null;
  const first = withTrend[0];
  const last = withTrend[withTrend.length - 1];
  return { kg: last.trend!.kg - first.trend!.kg, from: first.date, to: last.date };
}
