/**
 * The pure half of HealthKit import (N465): dedup filtering and the mapping
 * from a HealthKit workout to `running.SessionDetail`. Deliberately not
 * testing `queryRunningWorkouts` or `requestHealthKitReadAuthorization` —
 * those touch the native module and are the one part of this feature no test
 * run from this environment can reach (see `lib/healthkit.ts`'s own doc
 * comment on why the native surface is kept this thin, and the ticket's
 * NEEDS HUMAN EVIDENCE criterion).
 *
 * No mocking of `@kingstinct/react-native-healthkit` is needed here: it is
 * not installed in this test environment, so `lib/healthkit.ts`'s own
 * `require()` throws and is caught by its blast shield exactly as it would
 * on a build missing the native half — which is itself a small proof the
 * shield works, not just an artifact of the test setup.
 */

import {
  filterNewWorkouts,
  mapWorkoutToRunningDetail,
  type HealthKitRunningWorkout,
} from '../healthkit';

function workout(overrides: Partial<HealthKitRunningWorkout> = {}): HealthKitRunningWorkout {
  return {
    uuid: '11111111-1111-1111-1111-111111111111',
    startDate: '2026-09-01T07:00:00.000Z',
    endDate: '2026-09-01T07:30:00.000Z',
    durationSeconds: 1800,
    distanceMeters: 5000,
    route: [],
    ...overrides,
  };
}

describe('filterNewWorkouts', () => {
  it('drops workouts whose uuid is already imported', () => {
    const a = workout({ uuid: 'a' });
    const b = workout({ uuid: 'b' });
    const c = workout({ uuid: 'c' });
    expect(filterNewWorkouts([a, b, c], new Set(['b']))).toEqual([a, c]);
  });

  it('accepts a plain array of already-imported uuids, not only a Set', () => {
    const a = workout({ uuid: 'a' });
    const b = workout({ uuid: 'b' });
    expect(filterNewWorkouts([a, b], ['a'])).toEqual([b]);
  });

  it('keeps everything when nothing has been imported yet', () => {
    const all = [workout({ uuid: 'a' }), workout({ uuid: 'b' })];
    expect(filterNewWorkouts(all, [])).toEqual(all);
  });

  it('drops everything when every uuid is already imported', () => {
    const a = workout({ uuid: 'a' });
    const b = workout({ uuid: 'b' });
    expect(filterNewWorkouts([a, b], new Set(['a', 'b']))).toEqual([]);
  });

  it('does not mutate its input array', () => {
    const all = [workout({ uuid: 'a' }), workout({ uuid: 'b' })];
    const copy = [...all];
    filterNewWorkouts(all, ['a']);
    expect(all).toEqual(copy);
  });
});

describe('mapWorkoutToRunningDetail', () => {
  it('tags the source as healthkit and carries the uuid through', () => {
    const detail = mapWorkoutToRunningDetail(workout({ uuid: 'abc-123' }), 'ses-1');
    expect(detail.source).toBe('healthkit');
    expect(detail.healthkit_uuid).toBe('abc-123');
    expect(detail.session_id).toBe('ses-1');
  });

  it('carries distance and duration straight through', () => {
    const detail = mapWorkoutToRunningDetail(
      workout({ distanceMeters: 8200, durationSeconds: 2400 }),
      'ses-1',
    );
    expect(detail.distance_m).toBe(8200);
    expect(detail.duration_seconds).toBe(2400);
    expect(detail.avg_pace_sec_per_km).toBeCloseTo(2400 / 8.2, 5);
  });

  it('reports no pace when HealthKit gave no distance', () => {
    const detail = mapWorkoutToRunningDetail(
      workout({ distanceMeters: null, durationSeconds: 1200 }),
      'ses-1',
    );
    expect(detail.avg_pace_sec_per_km).toBeNull();
  });

  it('derives splits and elevation gain from a real route', () => {
    const route: HealthKitRunningWorkout['route'] = [
      { lat: 40.0, lng: -74.0, elevation_m: 10, recorded_at: '2026-09-01T07:00:00.000Z' },
      { lat: 40.01, lng: -74.0, elevation_m: 20, recorded_at: '2026-09-01T07:05:00.000Z' },
      { lat: 40.02, lng: -74.0, elevation_m: 15, recorded_at: '2026-09-01T07:10:00.000Z' },
    ];
    const detail = mapWorkoutToRunningDetail(workout({ route }), 'ses-1');
    expect(detail.route_points).toEqual(route);
    // Two points climb (10->20, +10) and one descends (20->15) — GAIN only
    // counts the climbs, same as running.ts's elevationGainMeters contract.
    expect(detail.elevation_gain_m).toBe(10);
    expect(detail.splits.length).toBeGreaterThan(0);
  });

  it('reports no elevation gain and no splits for a route-less workout', () => {
    const detail = mapWorkoutToRunningDetail(workout({ route: [] }), 'ses-1');
    expect(detail.elevation_gain_m).toBeNull();
    expect(detail.splits).toEqual([]);
  });

  it('treats a single-point route the same as no route', () => {
    // A track needs at least two points to derive anything from — one point
    // is a location, not a path.
    const route: HealthKitRunningWorkout['route'] = [
      { lat: 40.0, lng: -74.0, elevation_m: 10, recorded_at: '2026-09-01T07:00:00.000Z' },
    ];
    const detail = mapWorkoutToRunningDetail(workout({ route }), 'ses-1');
    expect(detail.elevation_gain_m).toBeNull();
    expect(detail.splits).toEqual([]);
  });
});
