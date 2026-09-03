/**
 * N463 — the mobile running trend screen's data layer: distance over time,
 * built from the generic `/sessions` listing rather than a new endpoint.
 *
 * Two things this pins:
 *
 * 1. `runPointsFromSessions` reads the SETS, not a sport label — only a
 *    session carrying a completed `run`-exercise set with a distance becomes
 *    a point, and a session with none (still tracking, or a lift that
 *    slipped into an unfiltered list) contributes nothing rather than a
 *    zero-distance dot.
 * 2. `buildDistanceTrend` never draws a connecting line — matching
 *    `buildLoadTrend`'s reasoning exactly, runs are not daily so a gap
 *    between two of them is not a hole in anything — and its delta is
 *    always measured off the raw readings, never a smoothed line that does
 *    not exist here.
 */

import { runPointsFromSessions, buildDistanceTrend } from '../runningTrend';
import { RUN_EXERCISE_ID } from '../running';
import type { Session } from '../sessions';
import { emptySet } from '../sessions';

const TODAY = '2026-08-19';

function runSession(id: string, startedAt: string, distanceM: number | null): Session {
  return {
    id,
    user_id: 'u1',
    workout_id: null,
    sport: 'running',
    name: 'Run',
    intent: 'normal',
    started_at: startedAt,
    ended_at: startedAt,
    notes: '',
    sets: [{ ...emptySet(RUN_EXERCISE_ID, 0), distance_m: distanceM, completed: true }],
    created_at: startedAt,
    updated_at: startedAt,
  };
}

function emptySession(id: string, startedAt: string): Session {
  return {
    id,
    user_id: 'u1',
    workout_id: null,
    sport: 'running',
    name: 'Run',
    intent: 'normal',
    started_at: startedAt,
    ended_at: null,
    notes: '',
    sets: [],
    created_at: startedAt,
    updated_at: startedAt,
  };
}

describe('runPointsFromSessions', () => {
  test('a finished run with a distance becomes a point', () => {
    const points = runPointsFromSessions([runSession('r1', '2026-08-01T10:00:00Z', 5000)]);
    expect(points).toEqual([{ session_id: 'r1', started_at: '2026-08-01T10:00:00Z', distance_m: 5000 }]);
  });

  test('an in-progress run with no sets yet contributes nothing', () => {
    const points = runPointsFromSessions([emptySession('r2', '2026-08-01T10:00:00Z')]);
    expect(points).toEqual([]);
  });

  test('a run set with no distance recorded is dropped, not zeroed', () => {
    const points = runPointsFromSessions([runSession('r3', '2026-08-01T10:00:00Z', null)]);
    expect(points).toEqual([]);
  });

  test('a non-running set on the session is ignored — only the run exercise counts', () => {
    const s = runSession('r4', '2026-08-01T10:00:00Z', 3000);
    s.sets.push({ ...emptySet('back-squat', 1), weight_kg: 100, reps: 5, completed: true });
    const points = runPointsFromSessions([s]);
    expect(points).toEqual([{ session_id: 'r4', started_at: '2026-08-01T10:00:00Z', distance_m: 3000 }]);
  });

  test('two run sets in one session sum to the session total', () => {
    const s = runSession('r5', '2026-08-01T10:00:00Z', 2000);
    s.sets.push({ ...emptySet(RUN_EXERCISE_ID, 1), distance_m: 1500, completed: true });
    const points = runPointsFromSessions([s]);
    expect(points).toEqual([{ session_id: 'r5', started_at: '2026-08-01T10:00:00Z', distance_m: 3500 }]);
  });

  test('an uncompleted run set (still tracking, or planned but never performed) is not counted', () => {
    const s = runSession('r6', '2026-08-01T10:00:00Z', 4000);
    s.sets[0].completed = false;
    const points = runPointsFromSessions([s]);
    expect(points).toEqual([]);
  });

  test('one completed set and one uncompleted set in the same session count only the completed one', () => {
    const s = runSession('r7', '2026-08-01T10:00:00Z', 5000);
    s.sets.push({ ...emptySet(RUN_EXERCISE_ID, 1), distance_m: 9000, completed: false });
    const points = runPointsFromSessions([s]);
    expect(points).toEqual([{ session_id: 'r7', started_at: '2026-08-01T10:00:00Z', distance_m: 5000 }]);
  });
});

describe('buildDistanceTrend', () => {
  test('never having loaded the history is "unavailable", not "no data"', () => {
    const series = buildDistanceTrend(null, '3M', TODAY);
    expect(series.empty).toEqual({ kind: 'unavailable' });
  });

  test('a loaded history with no runs is "none"', () => {
    const series = buildDistanceTrend([], '3M', TODAY);
    expect(series.empty).toEqual({ kind: 'none' });
  });

  test('draws no connecting line — runs are not daily, so a calendar gap is not a real gap', () => {
    const points = [
      { session_id: 'a', started_at: '2026-06-01T10:00:00Z', distance_m: 4000 },
      { session_id: 'b', started_at: '2026-08-10T10:00:00Z', distance_m: 5000 },
    ];
    const series = buildDistanceTrend(points, '1Y', TODAY);
    expect(series.segments).toEqual([]);
    expect(series.readings).toHaveLength(2);
  });

  test('the delta is measured off the raw readings and says so', () => {
    const points = [
      { session_id: 'a', started_at: '2026-07-01T10:00:00Z', distance_m: 4000 },
      { session_id: 'b', started_at: '2026-08-10T10:00:00Z', distance_m: 6100 },
    ];
    const series = buildDistanceTrend(points, '1Y', TODAY);
    expect(series.delta).not.toBeNull();
    expect(series.delta?.basis).toBe('readings');
    expect(series.delta?.change).toBe(2100);
    expect(series.delta?.n).toBe(2);
  });

  test('a run dated outside the window is excluded from it', () => {
    const points = [
      { session_id: 'a', started_at: '2025-01-01T10:00:00Z', distance_m: 3000 },
      { session_id: 'b', started_at: '2026-08-10T10:00:00Z', distance_m: 5000 },
    ];
    const series = buildDistanceTrend(points, '1M', TODAY);
    expect(series.readings).toHaveLength(1);
    expect(series.readings[0].value).toBe(5000);
  });

  test('two runs the same day both draw — a rest day is what would be the gap, not a busy one', () => {
    const points = [
      { session_id: 'a', started_at: '2026-08-10T06:00:00Z', distance_m: 3000 },
      { session_id: 'b', started_at: '2026-08-10T18:00:00Z', distance_m: 8000 },
    ];
    const series = buildDistanceTrend(points, '1M', TODAY);
    expect(series.readings).toHaveLength(2);
  });
});
