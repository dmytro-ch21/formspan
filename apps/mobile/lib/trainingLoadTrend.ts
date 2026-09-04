import { daysBetween } from './anthropometry';
import type { SessionLoad } from './biometric';

/**
 * The pure half of the Progress-tab training-load trend — N489/#850.
 *
 * ## Why this is a daily SUM, not a per-session dot
 *
 * `TrendChart`/`trendSeries.ts` (weight, VO2max) draw one point per READING.
 * A session's TRIMP is not that: an athlete can log two sessions in one day
 * (an AM lift, a PM roll), and two raw dots at the same x-coordinate would
 * either overlap invisibly or read as a chart bug. Summing same-day sessions
 * into one `Reading` is also the more honest number to show anyway — "how
 * much training load landed on this day", which is what an athlete standing
 * in front of the fridge deciding whether to train again actually wants to
 * know, not "here is one of the two things you did today."
 *
 * ## Why the smoothed line is a 7-day rolling SUM, not a rolling MEAN
 *
 * `trendWeight` (anthropometry.ts) averages because a body has one weight at
 * a time and the mean IS the trend. Training load is cumulative — "how much
 * work landed this week" — and load-management literature (and every
 * consumer fitness app that shows one) reports it as a trailing weekly
 * total, not a per-day average scaled back up. A sum is also legible without
 * translation: "312 this week vs 180 last week" reads directly; a mean would
 * need dividing by 7 in the reader's head to mean the same thing.
 *
 * ## Why the "not enough evidence" gate is different from `trendWeight`'s
 *
 * `trendWeight` requires >= `MIN_TREND_READINGS` (3) actual weigh-ins in the
 * window before it will report anything — a single stray reading is not a
 * trend. Training load is different: a rest week (zero sessions in the
 * trailing 7 days) is real, current information an athlete who has been
 * training for months should see as a flat/falling line, not as "not enough
 * data". So the gate here is not a minimum COUNT within the window; it is
 * "does this date fall on or after the athlete's first ever session with a
 * computed load." Before that date there is no evidence of ANY kind — not
 * even zero — so the smoother returns null rather than asserting a week of
 * training that predates the athlete's own history. On or after it, a
 * trailing week with no sessions in it legitimately sums to zero, and zero
 * is shown.
 */

/** One day's total TRIMP — the daily rollup `readings` and the smoother
 *  both work from. */
export type DailyLoad = { on: string; trimp: number };

/** Sum same-day `SessionLoad` entries into one `DailyLoad` per day that had
 *  at least one session, using the LOCAL calendar day of `started_at`. The
 *  caller supplies `dayOf` rather than this file parsing `started_at`
 *  itself, so it stays free of any timezone decision — `dayString(new
 *  Date(...))` at the call site is the same "local day, never UTC" rule
 *  every other trend hook in this app already follows (see
 *  `useWeightTrend.ts`'s note on the identical trap). */
export function dailyLoads(sessions: SessionLoad[], dayOf: (startedAt: string) => string): DailyLoad[] {
  const totals = new Map<string, number>();
  for (const s of sessions) {
    const on = dayOf(s.started_at);
    totals.set(on, (totals.get(on) ?? 0) + s.trimp);
  }
  return Array.from(totals.entries())
    .map(([on, trimp]) => ({ on, trimp: round(trimp, 1) }))
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
}

/** How many trailing days a "weekly load" figure sums over. Seven, matching
 *  the training week every other rolling figure in this app already uses
 *  (see `anthropometry.ts`'s `TREND_DAYS`) — a shorter window swings wildly
 *  between a training day and a rest day; a longer one blurs distinct weeks
 *  together. */
export const TRAINING_LOAD_WINDOW_DAYS = 7;

/**
 * The 7-day trailing training-load sum ending on `on` — the smoothed line's
 * value for one day.
 *
 * Returns null when `on` predates the earliest day with ANY recorded load —
 * see this file's own doc comment for why that is the right gate instead of
 * a minimum-readings count. Once real history exists, a trailing window with
 * zero sessions in it legitimately returns 0.
 */
export function weeklyTrainingLoad(loads: DailyLoad[], on: string): number | null {
  if (loads.length === 0) return null;
  const earliest = loads.reduce((min, l) => (l.on < min ? l.on : min), loads[0].on);
  if (on < earliest) return null;

  let sum = 0;
  for (const l of loads) {
    const age = daysBetween(l.on, on);
    if (age >= 0 && age < TRAINING_LOAD_WINDOW_DAYS) sum += l.trimp;
  }
  return round(sum, 1);
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
