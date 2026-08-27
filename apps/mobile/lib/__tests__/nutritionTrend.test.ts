/**
 * N84 — "am I hitting my target lately", the reduced phone form of
 * `/dashboard/nutrition`. What this pins:
 *
 * 1. An unlogged day is a gap in the mean, never a zero — the same rule
 *    `apps/web`'s `nutritionSeries.ts` states as its rule 1, carried to the
 *    phone's own smoother rather than re-derived and possibly disagreeing.
 * 2. The goal line is TODAY's live target, not whatever target happened to be
 *    on the most recently logged day (which can be stale if today itself
 *    hasn't been logged yet).
 * 3. Adherence is scoped to the window on screen, not to everything fetched
 *    (the fetch reaches further back for the mean's own lookback).
 */

import { buildNutritionTrend, MEAN_WINDOW_DAYS } from '../nutritionTrend';
import type { DayTotals, StoredTarget } from '../nutritionApi';

const TODAY = '2026-08-19';

function day(eaten_on: string, kcal: number, target_kcal: number | null = null): DayTotals {
  return {
    eaten_on,
    kcal,
    protein_g: 150,
    carb_g: 200,
    fat_g: 70,
    fibre_g: 25,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    entries: 1,
    target_kcal,
    target_protein_g: null,
  };
}

function target(effective_on: string, kcal: number): StoredTarget {
  return { effective_on, kcal, protein_g: 180, carb_g: 250, fat_g: 70, fibre_g: 30 };
}

test('an unlogged day does not drag the mean toward zero', () => {
  // One very high day, then five days of nothing logged, all inside the
  // 7-day mean window ending on the high day. If absence were treated as
  // zero, the SMOOTHED value at that point would be roughly 1/7th of the
  // real intake (2800 / 7 = 400) rather than 2800 itself.
  const days = [day(TODAY, 2800)];
  const { series } = buildNutritionTrend(days, [], '1W', TODAY);
  const smoothed = series.segments.flat().find((p) => p.on === TODAY);
  expect(smoothed?.value).toBe(2800);

  // The raw reading is unaffected either way — asserted too so a future
  // change cannot "fix" this test by reading the wrong series.
  const last = series.readings[series.readings.length - 1];
  expect(last.value).toBe(2800);
});

test('the mean is null on a day with nothing in its trailing window', () => {
  const days = [day('2026-07-01', 2000)]; // long before the window
  const { series } = buildNutritionTrend(days, [], '1W', TODAY);
  // Nothing in the 1W window at all -> readings within the window is empty,
  // and the series reports that rather than a fabricated mean.
  expect(series.readings).toHaveLength(0);
  expect(series.empty).not.toBeNull();
});

test('the mean at a logged day averages only the logged days behind it', () => {
  const days = [
    day(TODAY, 2000),
    day('2026-08-18', 2400), // yesterday, also logged
    // the five days before that: nothing logged
  ];
  const { series } = buildNutritionTrend(days, [], '1W', TODAY);
  // Segment through both logged days should average them: (2000+2400)/2 = 2200.
  const seg = series.segments.flat();
  const todayPoint = seg.find((p) => p.on === TODAY);
  expect(todayPoint?.value).toBe(2200);
});

test('the goal line is the target live TODAY, not a stale one off the last logged day', () => {
  const days = [day('2026-08-10', 2100, 2000)]; // stale target frozen on an old day
  const targets = [target('2026-01-01', 2000), target('2026-08-15', 2500)]; // a newer target since
  const { goalKcal } = buildNutritionTrend(days, targets, '1M', TODAY);
  expect(goalKcal).toBe(2500);
});

test('no target set at all is a null goal, not a fabricated one', () => {
  const { goalKcal } = buildNutritionTrend([day(TODAY, 2000)], [], '1M', TODAY);
  expect(goalKcal).toBeNull();
});

test('adherence counts only days inside the window on screen, not the lookback slack', () => {
  // A day well before the 1W window — present because the caller over-fetches
  // for the mean's lookback, and must not inflate adherence for a 1W read.
  const days = [day('2026-07-01', 2000), day(TODAY, 2200)];
  const { adherence } = buildNutritionTrend(days, [], '1W', TODAY);
  expect(adherence.logged).toBe(1);
  expect(adherence.considered).toBe(7);
});

test('adherence over a month with every day logged reads full', () => {
  const days: DayTotals[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
    days.push(day(d, 2200));
  }
  const { adherence } = buildNutritionTrend(days, [], '1M', TODAY);
  expect(adherence.logged).toBe(30);
  expect(adherence.considered).toBe(30);
});

test(`MEAN_WINDOW_DAYS matches the documented 7-day window`, () => {
  expect(MEAN_WINDOW_DAYS).toBe(7);
});
