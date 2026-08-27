/**
 * N84 — per-exercise load as a mobile trend. Two things this pins:
 *
 * 1. Only `top_weight_kg` feeds the series — a session with no top weight
 *    (a plank, a run) contributes nothing, and `carriesLoad` says so rather
 *    than the chart silently drawing dots for other sessions and going quiet
 *    on this one with no explanation.
 * 2. `unavailable` (never loaded) and `none` (loaded, genuinely nothing yet)
 *    stay distinguishable — `null` is not `{ points: [] }`.
 */

import { buildLoadTrend } from '../loadTrend';
import type { LoadHistory } from '../records';

const TODAY = '2026-08-19';

function history(points: LoadHistory['points'], loadType = 'weight_reps'): LoadHistory {
  return { exercise_id: 'back-squat', load_type: loadType, points };
}

function point(startedAt: string, topKg: number | null): LoadHistory['points'][number] {
  return {
    session_id: startedAt,
    started_at: startedAt,
    top_weight_kg: topKg,
    best_1rm_kg: null,
    best_1rm_reps: null,
    best_1rm_weight_kg: null,
    best_1rm_assisted_reps: null,
    best_1rm_rir: null,
    best_1rm_rpe: null,
    tonnage_kg: 0,
    sets: 3,
    reps: 15,
  };
}

test('never having loaded the history is "unavailable", not "no data"', () => {
  const { series } = buildLoadTrend(null, '3M', TODAY);
  expect(series.empty).toEqual({ kind: 'unavailable' });
});

test('a loaded history with no sessions is "none"', () => {
  const { series } = buildLoadTrend(history([]), '3M', TODAY);
  expect(series.empty).toEqual({ kind: 'none' });
});

test('only sessions with a top weight become readings', () => {
  const h = history([
    point('2026-08-01T10:00:00Z', 100),
    // A session that happened but carries no top weight for this metric —
    // e.g. an AMRAP set logged for reps only. Must not appear as a reading.
    point('2026-08-05T10:00:00Z', null),
    point('2026-08-10T10:00:00Z', 105),
  ]);
  const { series } = buildLoadTrend(h, '3M', TODAY);
  expect(series.readings).toHaveLength(2);
  expect(series.readings.map((r) => r.value)).toEqual([100, 105]);
});

test('an exercise that cannot carry a weight is flagged via carriesLoad, not silently emptied', () => {
  const h = history([], 'time');
  const { carriesLoad } = buildLoadTrend(h, '3M', TODAY);
  expect(carriesLoad).toBe(false);
});

test('a strength exercise carries load', () => {
  const { carriesLoad } = buildLoadTrend(history([point('2026-08-01T10:00:00Z', 100)]), '3M', TODAY);
  expect(carriesLoad).toBe(true);
});

test('draws no connecting line — sessions are not daily, so a calendar gap is not a real gap', () => {
  const h = history([
    point('2026-06-01T10:00:00Z', 90),
    point('2026-08-10T10:00:00Z', 100),
  ]);
  const { series } = buildLoadTrend(h, '1Y', TODAY);
  // No `smooth` is passed to `buildTrend`, so segments (the connecting line)
  // stay empty by construction — see lib/loadTrend.ts's own note on why.
  expect(series.segments).toEqual([]);
  expect(series.readings).toHaveLength(2);
});

test('the delta is measured off the raw readings and says so', () => {
  const h = history([point('2026-07-01T10:00:00Z', 90), point('2026-08-10T10:00:00Z', 100)]);
  const { series } = buildLoadTrend(h, '1Y', TODAY);
  expect(series.delta).not.toBeNull();
  expect(series.delta?.basis).toBe('readings');
  expect(series.delta?.change).toBe(10);
});

test('a reading dated outside the window is excluded from it', () => {
  const h = history([point('2025-01-01T10:00:00Z', 80), point('2026-08-10T10:00:00Z', 100)]);
  const { series } = buildLoadTrend(h, '1M', TODAY);
  expect(series.readings).toHaveLength(1);
  expect(series.readings[0].value).toBe(100);
});
