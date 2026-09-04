import { dailyLoads, weeklyTrainingLoad, TRAINING_LOAD_WINDOW_DAYS, type DailyLoad } from '../trainingLoadTrend';
import type { SessionLoad } from '../biometric';

/**
 * N489/#850's pure aggregation layer: summing same-day sessions into one
 * daily total, and the 7-day rolling sum that becomes the trend's smoothed
 * line. See the file's own doc comment for why this sums rather than
 * averages, and why the "not enough evidence" gate is "before the earliest
 * known session" rather than a minimum reading count.
 */

let n = 0;
function load(startedAt: string, trimp: number, sport: SessionLoad['sport'] = 'strength'): SessionLoad {
  n += 1;
  return { session_id: `ses-${n}`, sport, started_at: startedAt, trimp };
}

beforeEach(() => {
  n = 0;
});

describe('dailyLoads', () => {
  it('sums two sessions on the same local day into one entry', () => {
    const rows = dailyLoads(
      [load('2026-08-10T08:00:00Z', 50, 'strength'), load('2026-08-10T18:00:00Z', 30, 'bjj')],
      (on) => on.slice(0, 10),
    );
    expect(rows).toEqual([{ on: '2026-08-10', trimp: 80 }]);
  });

  it('keeps sessions on different days as separate entries, sorted ascending', () => {
    const rows = dailyLoads(
      [load('2026-08-12T08:00:00Z', 20), load('2026-08-10T08:00:00Z', 50)],
      (on) => on.slice(0, 10),
    );
    expect(rows.map((r) => r.on)).toEqual(['2026-08-10', '2026-08-12']);
  });

  it('is cross-sport by construction: a bjj and a running session both count', () => {
    const rows = dailyLoads(
      [load('2026-08-10T08:00:00Z', 40, 'bjj'), load('2026-08-10T18:00:00Z', 60, 'running')],
      (on) => on.slice(0, 10),
    );
    expect(rows).toEqual([{ on: '2026-08-10', trimp: 100 }]);
  });

  it('returns an empty list for no sessions', () => {
    expect(dailyLoads([], (on) => on)).toEqual([]);
  });
});

describe('weeklyTrainingLoad', () => {
  const loads: DailyLoad[] = [
    { on: '2026-08-03', trimp: 40 }, // Monday
    { on: '2026-08-05', trimp: 30 }, // Wednesday
    { on: '2026-08-10', trimp: 50 }, // the following Monday
  ];

  it('sums every day within the trailing window, inclusive of `on` itself', () => {
    // 2026-08-09 (Sunday): trailing 7 days = Aug 3–9, which holds both
    // the Aug 3 and Aug 5 entries but not Aug 10 (in the future of `on`).
    expect(weeklyTrainingLoad(loads, '2026-08-09')).toBe(70);
  });

  it('sums every day still within the trailing window, including a day near the far edge', () => {
    // 2026-08-10: trailing 7 days = Aug 4–10, which holds Aug 5 (age 5) and
    // Aug 10 itself (age 0), but not Aug 3 (age 7, outside the window).
    expect(weeklyTrainingLoad(loads, '2026-08-10')).toBe(80);
  });

  // The core distinction this file's own doc comment draws against
  // `trendWeight`: a rest week is real information, not insufficient
  // evidence, PROVIDED it falls on or after the athlete's first-ever
  // session with a computed load.
  it('returns 0 — not null — for a real rest week after training has started', () => {
    // 2026-08-20: 7 days back (Aug 14–20) holds none of the three sessions
    // above, but it is well after the earliest one (Aug 3), so this is an
    // honest zero, not "not enough evidence".
    expect(weeklyTrainingLoad(loads, '2026-08-20')).toBe(0);
  });

  it('returns null for a date before the earliest known session', () => {
    // No evidence of any kind exists for 2026-07-01 — asserting 0 here
    // would claim a rest week the app has no basis for.
    expect(weeklyTrainingLoad(loads, '2026-07-01')).toBeNull();
  });

  it('returns null for an empty history', () => {
    expect(weeklyTrainingLoad([], '2026-08-10')).toBeNull();
  });

  it("does not include a day exactly TRAINING_LOAD_WINDOW_DAYS back (the window is half-open)", () => {
    // 2026-08-10 minus 7 days is 2026-08-03 — outside the [on-6, on] window
    // the function actually sums (age < TRAINING_LOAD_WINDOW_DAYS, not <=).
    const eightDayGap: DailyLoad[] = [{ on: '2026-08-03', trimp: 999 }];
    expect(weeklyTrainingLoad(eightDayGap, '2026-08-10')).toBe(0);
    expect(TRAINING_LOAD_WINDOW_DAYS).toBe(7);
  });
});
