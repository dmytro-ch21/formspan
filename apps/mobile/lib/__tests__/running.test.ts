import {
  averagePaceSecPerKm,
  DEFAULT_SPLIT_METERS,
  elevationGainMeters,
  haversineMeters,
  splitsFromTrack,
  trackDistanceMeters,
  trackDurationSeconds,
  type RoutePoint,
} from '../running';

/**
 * N460 — pure distance/pace/split calculation from a fixture GPS track.
 *
 * Every fixture here walks due NORTH along one meridian (a fixed `lng`,
 * increasing `lat`). That is not a convenience shortcut — it is what makes
 * the expected numbers independently checkable: on a meridian, the haversine
 * formula's `cos(lat1) * cos(lat2) * sin(dLng/2)^2` term is exactly zero
 * (`dLng = 0`), which collapses it to `2 * R * asin(sin(dLat/2))` — and
 * `asin(sin(x)) === x` for any `x` in `[-90°, 90°]`, so the distance between
 * two such points is EXACTLY `R * dLat` in radians, not merely close to it.
 * `EXPECTED_STEP_M` below is that closed form, computed independently of
 * `haversineMeters`'s own implementation.
 */

const EARTH_RADIUS_M = 6371000;
const LNG = -122.4;
const START = Date.parse('2026-01-01T08:00:00Z');

/** One degree of latitude in metres, on a meridian — the exact closed form. */
function meridianMetersPerDegree(): number {
  return EARTH_RADIUS_M * (Math.PI / 180);
}

/** Builds a straight run north: `stepDeg` of latitude, `stepSeconds` apart. */
function meridianTrack(
  count: number,
  stepDeg: number,
  stepSeconds: number,
  startLat = 37.0,
  elevations?: (number | null)[],
): RoutePoint[] {
  const points: RoutePoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push({
      lat: startLat + i * stepDeg,
      lng: LNG,
      elevation_m: elevations ? elevations[i] : null,
      recorded_at: new Date(START + i * stepSeconds * 1000).toISOString(),
    });
  }
  return points;
}

describe('haversineMeters', () => {
  it('is zero for the same point twice', () => {
    const p = { lat: 37.0, lng: -122.4 };
    expect(haversineMeters(p, p)).toBe(0);
  });

  it('matches the exact closed form for one degree of latitude', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 1, lng: 0 };
    expect(haversineMeters(a, b)).toBeCloseTo(meridianMetersPerDegree(), 6);
  });
});

describe('trackDistanceMeters', () => {
  it('is 0 for an empty or single-point track', () => {
    expect(trackDistanceMeters([])).toBe(0);
    expect(trackDistanceMeters(meridianTrack(1, 0.0009, 60))).toBe(0);
  });

  it('sums consecutive great-circle segments along a meridian', () => {
    const stepDeg = 0.0009;
    const track = meridianTrack(11, stepDeg, 60);
    const expected = 10 * stepDeg * meridianMetersPerDegree();
    expect(trackDistanceMeters(track)).toBeCloseTo(expected, 3);
  });

  it('does not shortcut an out-and-back to its net displacement', () => {
    const stepDeg = 0.0009;
    const north = meridianTrack(6, stepDeg, 60); // 5 steps north
    const south = meridianTrack(6, -stepDeg, 60, north[5].lat).slice(1); // 5 steps back
    const outAndBack = [...north, ...south];
    // Net displacement is ~0 — the athlete is back where they started — but
    // ten full steps were actually run.
    const expected = 10 * stepDeg * meridianMetersPerDegree();
    expect(trackDistanceMeters(outAndBack)).toBeCloseTo(expected, 3);
  });
});

describe('trackDurationSeconds', () => {
  it('is 0 for an empty or single-point track', () => {
    expect(trackDurationSeconds([])).toBe(0);
    expect(trackDurationSeconds(meridianTrack(1, 0.0009, 60))).toBe(0);
  });

  it('is the span from the first point to the last, ignoring the middle', () => {
    const track = meridianTrack(11, 0.0009, 60); // 10 steps * 60s
    expect(trackDurationSeconds(track)).toBe(600);
  });
});

describe('averagePaceSecPerKm', () => {
  it('is null for zero or negative distance', () => {
    expect(averagePaceSecPerKm(0, 300)).toBeNull();
    expect(averagePaceSecPerKm(-5, 300)).toBeNull();
  });

  it('is null for negative duration', () => {
    expect(averagePaceSecPerKm(1000, -1)).toBeNull();
  });

  it('is seconds per kilometre for a plain 5k in 25 minutes', () => {
    expect(averagePaceSecPerKm(5000, 25 * 60)).toBeCloseTo(300, 6); // 5:00 /km
  });

  it('matches a fixture track end to end', () => {
    const stepDeg = 0.0009;
    const track = meridianTrack(11, stepDeg, 60);
    const distance = trackDistanceMeters(track);
    const duration = trackDurationSeconds(track);
    // Same track, computed by hand: ~1000.84m in 600s is a little under
    // 10:00 /km, not over it.
    const pace = averagePaceSecPerKm(distance, duration);
    expect(pace).not.toBeNull();
    expect(pace as number).toBeLessThan(600);
    expect(pace as number).toBeGreaterThan(590);
  });
});

describe('elevationGainMeters', () => {
  it('is 0 for a flat or empty track', () => {
    expect(elevationGainMeters([])).toBe(0);
    expect(elevationGainMeters(meridianTrack(3, 0.0009, 60, 37, [100, 100, 100]))).toBe(0);
  });

  it('sums only the positive deltas — descent is not subtracted', () => {
    const elevations = [100, 103, 106, 109, 112, 109, 106, 109, 112, 115, 118];
    const track = meridianTrack(11, 0.0009, 60, 37, elevations);
    // Climbs: +3 four times (100->112), then +3 four times (106->118) = 24m.
    // The two -3 descents (112->109->106) contribute nothing.
    expect(elevationGainMeters(track)).toBeCloseTo(24, 6);
  });

  it('a point with no elevation reading contributes no delta on either side', () => {
    const track = meridianTrack(4, 0.0009, 60, 37, [100, null, 110, 120]);
    // 100 -> null: skipped. null -> 110: skipped. 110 -> 120: +10.
    // A naive treatment of null-as-0 would instead read a 100m drop then a
    // 110m climb, or similar nonsense — this must not happen.
    expect(elevationGainMeters(track)).toBe(10);
  });
});

describe('splitsFromTrack', () => {
  it('is empty for a track shorter than two points, or a non-positive split size', () => {
    expect(splitsFromTrack([])).toEqual([]);
    expect(splitsFromTrack(meridianTrack(1, 0.0009, 60))).toEqual([]);
    expect(splitsFromTrack(meridianTrack(11, 0.0009, 60), 0)).toEqual([]);
  });

  it('reports one split when the track crosses exactly one km boundary', () => {
    // ~1000.84m over 10 steps of 60s: the 1000m boundary falls inside the
    // final (10th) segment.
    const track = meridianTrack(11, 0.0009, 60);
    const splits = splitsFromTrack(track, DEFAULT_SPLIT_METERS);
    expect(splits).toHaveLength(1);
    expect(splits[0].distance_m).toBeCloseTo(1000, 6);
    // The whole track covers 1000.84m in 600s; the interpolated time to
    // reach exactly 1000m must land just under 600s.
    expect(splits[0].duration_seconds).toBeGreaterThanOrEqual(595);
    expect(splits[0].duration_seconds).toBeLessThanOrEqual(600);
  });

  it('reports one split per km on a longer track, interpolated to the boundary', () => {
    // A step size chosen so 2km falls EXACTLY on a sample point (step *
    // count = 2000m) and a third boundary falls inside the final segment —
    // exercises both the "boundary lands on a sample" and the "boundary
    // needs interpolation" cases in one fixture.
    const stepDeg = 2000 / 20 / meridianMetersPerDegree(); // 20 steps of 100m
    const track = meridianTrack(23, stepDeg, 30, 37, undefined); // 22 steps, ~2200m
    const splits = splitsFromTrack(track, DEFAULT_SPLIT_METERS);
    expect(splits).toHaveLength(2);
    expect(splits[0].distance_m).toBeCloseTo(1000, 3);
    expect(splits[1].distance_m).toBeCloseTo(1000, 3);
    // Exactly 100m per 30s => 1000m takes exactly 300s, twice.
    expect(splits[0].duration_seconds).toBe(300);
    expect(splits[1].duration_seconds).toBe(300);
    // Splits partition the run — the second one picks up where the first
    // left off rather than double-counting distance already split off.
    const totalSplitDistance = splits.reduce((sum, s) => sum + s.distance_m, 0);
    expect(totalSplitDistance).toBeCloseTo(2000, 3);
  });

  it('crosses more than one boundary within a single sparse segment', () => {
    // Two points 2500m apart, 500s apart — sparse enough that 2 boundaries
    // (1000m and 2000m) fall inside the ONE segment between them.
    const stepDeg = 2500 / meridianMetersPerDegree();
    const track = meridianTrack(2, stepDeg, 500);
    const splits = splitsFromTrack(track, DEFAULT_SPLIT_METERS);
    expect(splits).toHaveLength(2);
    expect(splits[0].distance_m).toBeCloseTo(1000, 3);
    expect(splits[1].distance_m).toBeCloseTo(1000, 3);
    // Linear interpolation: 1000/2500 of the way through 500s = 200s for the
    // first split, then another 1000/2500 = 200s for the second.
    expect(splits[0].duration_seconds).toBe(200);
    expect(splits[1].duration_seconds).toBe(200);
  });

  it('reports nothing short of one full split', () => {
    const track = meridianTrack(3, 0.0001, 60); // a few metres, nowhere near 1km
    expect(splitsFromTrack(track, DEFAULT_SPLIT_METERS)).toEqual([]);
  });
});
