import { daysBetween, shiftDate } from './anthropometry';
import { targetOn, type DayTotals, type StoredTarget } from './nutritionApi';
import { buildTrend, RANGE_DAYS, type Reading, type TrendRangeKey, type TrendSeries } from './trendSeries';

/**
 * Nutrition, wired onto the shared trend layer — N84, row 6 of the
 * phone-impossible audit ("intake vs bodyweight vs training load, 7-day
 * mean, adherence %", `/dashboard/nutrition`).
 *
 * ## The one question this answers, and the two it deliberately does not
 *
 * Web's page is a THREE-way join — intake, bodyweight and training load, four
 * stat tiles, on one timeline — and that is exactly the shape CLAUDE.md's
 * carve-out reserves for web: a second metric disqualifies a mobile chart, and
 * this page has three. The narrowest slice that is still a real decision made
 * away from a desk is **"is my eating tracking the target I set"** — kcal
 * against `target_kcal`, which is already the plan you are trying to hit
 * rather than a second independent series to compare against the first. That
 * makes the dashed reference line here the same shape as `app/goals/trend.tsx`'s
 * goal line: a flat target, not a second measured quantity.
 *
 * Bodyweight and training load are left OUT on purpose, not merely deferred —
 * they are the comparison the web screen exists for, and adding either here
 * would be exactly the "second metric" the carve-out forbids. `/dashboard/nutrition`
 * stays the place to ask "did the week I ate least happen to be the week I
 * trained hardest".
 *
 * ## Why the smoothed line is a 7-day mean, not raw daily kcal
 *
 * Matches the backend's `TrendDays` / web's `MEAN_WINDOW_DAYS` (`nutritionSeries.ts`):
 * a single day's kcal swings far more than an athlete's actual adherence
 * does, and the mean is the number both surfaces already treat as the
 * headline. `meanKcal` below reads only days that were actually logged inside
 * its trailing window — an unlogged day is a gap, never a zero, matching
 * web's rule 1: zero-filling would drag every mean toward a fast nobody had.
 *
 * ## Adherence
 *
 * `logged` / `considered` over the SAME window the chart draws, so the one
 * number the athlete cannot get from the chart alone (how consistently they
 * are logging, as opposed to what the mean says on the days they did) rides
 * alongside it as text — not a second chart, not a second axis, the same way
 * `trend.tsx`'s evidence line ("N readings…") is text beside its one chart
 * rather than a second series on it.
 */

/** Matches the backend's `TrendDays` and web's `nutritionSeries.MEAN_WINDOW_DAYS`. */
export const MEAN_WINDOW_DAYS = 7;

/**
 * The widest window the server allows in one `/nutrition/days` call — matches
 * `apps/web/src/app/dashboard/nutrition/page.tsx`'s own `MAX_DAY_WINDOW`
 * (itself matching the backend's `maxDayWindowDays`). The screen fetches
 * exactly this much, once, regardless of which range chip is selected — see
 * `app/goals/nutritionTrend.tsx`'s own header comment for why re-fetching per
 * range both wastes a request and, worse, makes "All" lie about data that
 * exists outside whatever window the tapped chip alone would have asked for.
 * `adherence`'s own `All`/`Plan` case below uses this SAME constant, so "days
 * logged" on `All` describes the same window the chart draws it against.
 */
export const MAX_DAY_WINDOW = 366;

export type NutritionTrend = {
  series: TrendSeries;
  /** The target live TODAY, or null — a target-less account has nothing to draw a line against. */
  goalKcal: number | null;
  adherence: { logged: number; considered: number };
};

/**
 * The trailing mean kcal ending on `on`, or null if nothing was logged in the
 * `MEAN_WINDOW_DAYS` days up to and including it.
 *
 * A closure over `byDay` rather than a re-scan per call: `buildTrend` asks
 * this once per day in the window, and a linear scan per day would make the
 * `1Y` chip an O(n²) pass over the whole fetch.
 */
function meanBuilder(byDay: Map<string, number>): (on: string) => number | null {
  return (on: string) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < MEAN_WINDOW_DAYS; i++) {
      const kcal = byDay.get(shiftDate(on, -i));
      if (kcal != null) {
        sum += kcal;
        n += 1;
      }
    }
    return n === 0 ? null : sum / n;
  };
}

/**
 * Build the trend from a window's day totals and targets.
 *
 * `days` and `targets` are exactly what `listDays`/`listTargets` return —
 * this does no fetching and no date-math beyond what the trend needs, so it
 * is testable with no network and no clock.
 */
export function buildNutritionTrend(
  days: DayTotals[],
  targets: StoredTarget[],
  range: TrendRangeKey,
  today: string,
): NutritionTrend {
  const byDay = new Map(days.map((d) => [d.eaten_on, d.kcal]));

  const readings: Reading[] = days.map((d) => ({ on: d.eaten_on, value: d.kcal }));
  const series = buildTrend({ readings, today, range, smooth: meanBuilder(byDay) });

  const goalKcal = targetOn(targets, today)?.kcal ?? null;

  const windowDays = range === 'All' || range === 'Plan' ? MAX_DAY_WINDOW : RANGE_DAYS[range];
  const from = shiftDate(today, -(windowDays - 1));
  const considered = daysBetween(from, today) + 1;
  const logged = days.filter((d) => d.eaten_on >= from && d.eaten_on <= today).length;

  return { series, goalKcal, adherence: { logged, considered } };
}
