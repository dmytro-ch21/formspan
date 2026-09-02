import { describe, expect, it } from "vitest";

import {
  compareRuns,
  elevationProfile,
  hasElevationData,
  paceZoneBreakdown,
  paceZoneFor,
  projectRoute,
  splitPaceSecPerKm,
  splitsToCSV,
  type RunSummary,
} from "../runningAnalysis";
import type { RunRoutePoint, RunSplit } from "../runningApi";

/**
 * The web running-analytics page's pure arithmetic — pace zones, run-to-run
 * comparison, the route's screen projection, and the elevation profile.
 * Every assertion here should fail if the guard it covers is deleted, per
 * this codebase's testing discipline.
 */

const split = (distanceM: number, durationSeconds: number): RunSplit => ({
  distance_m: distanceM,
  duration_seconds: durationSeconds,
});

const point = (
  lat: number,
  lng: number,
  elevationM: number | null = null,
  recordedAt = "2026-08-01T07:00:00Z",
): RunRoutePoint => ({ lat, lng, elevation_m: elevationM, recorded_at: recordedAt });

describe("splitPaceSecPerKm", () => {
  it("is seconds per kilometre", () => {
    // 1000m in 300s is exactly 5:00/km.
    expect(splitPaceSecPerKm(split(1000, 300))).toBe(300);
  });

  it("is null for a non-positive distance or duration", () => {
    expect(splitPaceSecPerKm(split(0, 300))).toBeNull();
    expect(splitPaceSecPerKm(split(1000, 0))).toBeNull();
    expect(splitPaceSecPerKm(split(-5, 300))).toBeNull();
  });
});

describe("paceZoneFor", () => {
  const avg = 300; // 5:00/km

  it("classifies a split at the average pace as steady", () => {
    expect(paceZoneFor(300, avg)).toBe("steady");
  });

  it("classifies a much faster split as fast", () => {
    // 250/300 ≈ 0.83, under the 0.85 fast bound.
    expect(paceZoneFor(250, avg)).toBe("fast");
  });

  it("classifies a moderately faster split as tempo", () => {
    // 285/300 = 0.95 exactly — the tempo bound is inclusive.
    expect(paceZoneFor(285, avg)).toBe("tempo");
  });

  it("classifies a much slower split as recovery", () => {
    // 400/300 ≈ 1.33, past every bound.
    expect(paceZoneFor(400, avg)).toBe("recovery");
  });

  it("is exactly boundary-inclusive at the zone edges", () => {
    // 1.05 * 300 = 315: the steady bound is inclusive, so 315 is steady, not easy.
    expect(paceZoneFor(315, avg)).toBe("steady");
    // Just past it tips into easy.
    expect(paceZoneFor(316, avg)).toBe("easy");
  });
});

describe("paceZoneBreakdown", () => {
  it("returns null with no usable splits", () => {
    expect(paceZoneBreakdown([])).toBeNull();
    expect(paceZoneBreakdown([split(0, 300)])).toBeNull();
  });

  it("buckets every split's time and distance into its zone", () => {
    // Two splits at exactly the run's own average pace (both 5:00/km,
    // 1000m each) — both land in "steady", and the whole run's time/distance
    // is accounted for.
    const b = paceZoneBreakdown([split(1000, 300), split(1000, 300)]);
    expect(b).not.toBeNull();
    expect(b!.avgPaceSecPerKm).toBe(300);
    expect(b!.zones).toHaveLength(1);
    expect(b!.zones[0].key).toBe("steady");
    expect(b!.zones[0].seconds).toBe(600);
    expect(b!.zones[0].meters).toBe(2000);
    expect(b!.zones[0].pctTime).toBe(1);
    expect(b!.zones[0].pctDistance).toBe(1);
  });

  it("splits a mixed run across multiple zones in slowest-to-fastest order", () => {
    // avg = (1000+1000)/(200+400) km-seconds -> total 2000m / 600s = 300 s/km.
    // Split A: 1000m/200s = 200 s/km -> ratio 0.667 -> fast.
    // Split B: 1000m/400s = 400 s/km -> ratio 1.333 -> recovery.
    const b = paceZoneBreakdown([split(1000, 200), split(1000, 400)]);
    expect(b!.zones.map((z) => z.key)).toEqual(["recovery", "fast"]);
    const recovery = b!.zones.find((z) => z.key === "recovery")!;
    const fast = b!.zones.find((z) => z.key === "fast")!;
    expect(recovery.seconds).toBe(400);
    expect(fast.seconds).toBe(200);
  });

  it("ignores a split with no usable numbers rather than crashing on it", () => {
    const b = paceZoneBreakdown([split(1000, 300), split(0, 300)]);
    expect(b!.totalMeters).toBe(1000);
    expect(b!.totalSeconds).toBe(300);
  });
});

describe("compareRuns", () => {
  const base: RunSummary = {
    sessionId: "a",
    name: "Run A",
    startedAt: "2026-08-01T07:00:00Z",
    distanceM: 5000,
    durationSeconds: 1500,
    avgPaceSecPerKm: 300,
    elevationGainM: 50,
  };

  it("is b minus a on every field", () => {
    const b: RunSummary = {
      ...base,
      sessionId: "b",
      name: "Run B",
      distanceM: 6000,
      durationSeconds: 1400,
      avgPaceSecPerKm: 280,
      elevationGainM: 30,
    };
    expect(compareRuns(base, b)).toEqual({
      distanceDeltaM: 1000,
      durationDeltaSeconds: -100,
      paceDeltaSecPerKm: -20,
      elevationGainDeltaM: -20,
    });
  });

  it("is null on a field wherever either side is missing it", () => {
    const b: RunSummary = { ...base, sessionId: "b", elevationGainM: null };
    expect(compareRuns(base, b).elevationGainDeltaM).toBeNull();
  });
});

describe("hasElevationData / elevationProfile", () => {
  it("says no when every point lacks elevation", () => {
    const pts = [point(40, -74, null), point(40.001, -74, null)];
    expect(hasElevationData(pts)).toBe(false);
    expect(elevationProfile(pts)).toEqual([]);
  });

  it("walks cumulative distance through a track, dropping only the gaps", () => {
    const pts = [
      point(40, -74, 10),
      point(40, -73.999, null), // a dropped reading — must not become a cliff
      point(40, -73.998, 20),
    ];
    expect(hasElevationData(pts)).toBe(true);
    const profile = elevationProfile(pts);
    expect(profile).toHaveLength(2);
    expect(profile[0]).toEqual({ distanceM: 0, elevationM: 10 });
    // The second present point's distance is measured along the WHOLE track,
    // including the leg through the dropped point — not from the first
    // present point, and not zero.
    expect(profile[1].elevationM).toBe(20);
    expect(profile[1].distanceM).toBeGreaterThan(0);
  });
});

describe("projectRoute", () => {
  it("returns nothing for an empty track", () => {
    expect(projectRoute([], 400, 300)).toEqual([]);
  });

  it("centres a single point rather than dividing by zero", () => {
    const [p] = projectRoute([{ lat: 40, lng: -74 }], 400, 300, 20);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it("keeps every projected point inside the box", () => {
    const track = [
      { lat: 40.0, lng: -74.0 },
      { lat: 40.01, lng: -74.02 },
      { lat: 39.995, lng: -73.99 },
      { lat: 40.005, lng: -74.005 },
    ];
    const projected = projectRoute(track, 400, 300, 16);
    for (const p of projected) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(400);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(300);
    }
  });

  it("maps north to a smaller y than south", () => {
    const [north, south] = projectRoute(
      [
        { lat: 40.01, lng: -74 },
        { lat: 40.0, lng: -74 },
      ],
      400,
      300,
    );
    expect(north.y).toBeLessThan(south.y);
  });
});

describe("splitsToCSV", () => {
  it("is a header plus one row per split, raw numbers", () => {
    const csv = splitsToCSV([split(1000, 300), split(1000, 330)]);
    expect(csv).toBe(
      "distance_m,duration_seconds,pace_sec_per_km\n1000,300,300\n1000,330,330",
    );
  });

  it("survives a split with no computable pace", () => {
    const csv = splitsToCSV([split(0, 300)]);
    expect(csv).toBe("distance_m,duration_seconds,pace_sec_per_km\n0,300,");
  });
});
