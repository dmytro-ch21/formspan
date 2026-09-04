/**
 * The pure half of HealthKit import (N465): dedup filtering and the mapping
 * from a HealthKit workout to `running.SessionDetail`. Deliberately not
 * testing `queryRunningWorkouts` or `requestHealthKitReadAuthorization` —
 * those touch the native module and are the one part of this feature no test
 * run from this environment can reach (see `lib/healthkit.ts`'s own doc
 * comment on why the native surface is kept this thin, and the ticket's
 * NEEDS HUMAN EVIDENCE criterion).
 *
 * No mocking of `@kingstinct/react-native-healthkit` is needed here — it IS
 * installed (a real dependency, in `node_modules`), but the package is built
 * on `react-native-nitro-modules`, whose native binding is registered only
 * inside a real React Native runtime. Requiring it under Jest throws
 * "Failed to get NitroModules: The native ... Turbo/Native-Module could not
 * be found" (verified directly: `require('@kingstinct/react-native-healthkit')`
 * under this suite), which `lib/healthkit.ts`'s `load()` catches — the SAME
 * blast shield, and the SAME failure shape, a build with a genuinely
 * mismatched native half hits on a real device. This is a property of every
 * Jest run on every machine, not a gap in this environment's install, which
 * is itself a small proof the shield's `try`/`catch` actually does its job
 * rather than merely existing.
 */

import {
  filterNewWorkouts,
  mapWorkoutToRunningDetail,
  metersFromQuantity,
  queryHeartRateSamples,
  queryOtherWorkouts,
  queryVO2MaxSamples,
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

describe('metersFromQuantity', () => {
  it("reads the REAL unit string this package's WorkoutProxy.totalDistance reports", () => {
    // Pinned against `@kingstinct/react-native-healthkit@14.1.0`'s own
    // installed Swift source (`ios/WorkoutProxy.swift`'s `totalDistance`
    // getter: `Quantity(unit: "meters", quantity: ...)`) — NOT against a
    // guess. `'m'` was the original (wrong) assumption this function
    // shipped with; every downstream test used the already-converted
    // `HealthKitRunningWorkout` shape and stayed green while this exact bug
    // silently zeroed every imported run's distance. This is the test that
    // would have caught it.
    expect(metersFromQuantity({ unit: 'meters', quantity: 5000 })).toBe(5000);
  });

  it('still accepts a bare "m", defensively', () => {
    expect(metersFromQuantity({ unit: 'm', quantity: 5000 })).toBe(5000);
  });

  it('converts km and mi, defensively — not exercised by the real package today', () => {
    expect(metersFromQuantity({ unit: 'km', quantity: 5 })).toBe(5000);
    expect(metersFromQuantity({ unit: 'mi', quantity: 1 })).toBeCloseTo(1609.344, 3);
  });

  it('returns null for an unrecognised unit rather than guessing', () => {
    expect(metersFromQuantity({ unit: 'furlongs', quantity: 1 })).toBeNull();
  });

  it('returns null for undefined or a non-finite quantity', () => {
    expect(metersFromQuantity(undefined)).toBeNull();
    expect(metersFromQuantity({ unit: 'meters', quantity: NaN })).toBeNull();
    expect(metersFromQuantity({ unit: 'meters', quantity: Infinity })).toBeNull();
  });
});

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

/**
 * N477/#822 — `queryHeartRateSamples`/`queryVO2MaxSamples` are the ONLY
 * native call surface this feature adds, matching the file's existing
 * `queryRunningWorkouts`. Under Jest `hk` is null for the reason this
 * file's own doc comment gives, so both resolve to `[]` — the same "no
 * module linked" outcome a real Android build or a native-mismatch Release
 * build hits, and the one this suite CAN exercise without a device.
 */
describe('queryHeartRateSamples / queryVO2MaxSamples', () => {
  it('resolve to an empty array when no HealthKit module is linked', async () => {
    await expect(
      queryHeartRateSamples(new Date('2026-09-01T07:00:00Z'), new Date('2026-09-01T07:30:00Z')),
    ).resolves.toEqual([]);
    await expect(queryVO2MaxSamples(new Date('2026-06-01T00:00:00Z'))).resolves.toEqual([]);
  });
});

/**
 * N479/#824 — `queryOtherWorkouts` is the third (and, so far, last) native
 * call surface in this file, same reasoning as the describe block above.
 */
describe('queryOtherWorkouts', () => {
  it('resolves to an empty array when no HealthKit module is linked', async () => {
    await expect(queryOtherWorkouts(new Date('2026-08-29T00:00:00Z'))).resolves.toEqual([]);
  });
});
