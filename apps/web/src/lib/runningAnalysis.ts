import type { RunRoutePoint, RunSplit } from "@/lib/runningApi";

/**
 * The pure arithmetic behind the web running-analytics page
 * (`app/dashboard/running/`) — pace zones, run-to-run comparison, the route's
 * screen projection, and the elevation profile. Everything here takes plain
 * data and returns plain data, no React and no network, so it can be tested
 * with a fixture track and nothing else running — the same reason
 * `apps/mobile/lib/running.ts` keeps its own track arithmetic pure.
 *
 * This intentionally duplicates `haversineMeters`/`trackDistanceMeters` from
 * `apps/mobile/lib/running.ts` rather than importing them: the two apps are
 * separate bundles with no shared package between them (`nutritionSeries.ts`
 * and every other `lib/*.ts` pair in this codebase work the same way), and
 * the definitions are small enough that keeping them textually identical is
 * cheaper than introducing a shared package for two functions. If either
 * drifts, `apps/mobile/lib/__tests__` and this file's own tests both pin the
 * same worked distance, so a drift shows up as a failing number rather than
 * silently reading two different distances for the same track.
 */

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance between two points, in metres. See running.ts (mobile) for the derivation. */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ── Pace zones ──────────────────────────────────────────────────────────
 *
 * There is no stored threshold pace or heart-rate zone anywhere in this
 * codebase — `running.SessionDetail` carries a track and splits, nothing
 * about physiology — so a zone model built on "% of max HR" or "% of
 * threshold pace" would need a number this app does not have and cannot ask
 * the athlete for without turning a read-only analytics page into a settings
 * form. Instead, each split's pace is classified against THIS RUN'S OWN
 * average pace (computed from the same splits, not the stored
 * `avg_pace_sec_per_km`, so the breakdown is self-consistent even if that
 * field came from a coarser client-side number — see
 * `running.SessionDetail.AvgPaceSecPerKm`'s doc comment). A split within 5%
 * of the run's average is "Steady"; the bands widen from there in both
 * directions. This is a deliberately simple, fully deterministic and
 * explainable rule — in the spirit of this codebase's "evidence-based rules
 * before AI" principle — not a claim about physiological training zones.
 */

export type PaceZoneKey = "recovery" | "easy" | "steady" | "tempo" | "fast";

/**
 * Zone boundaries, as an upper bound on (split pace / run average pace).
 * Ordered slowest to fastest, matching how a runner reads zone 1 → zone 5.
 * The fastest zone's bound is `null` — "no split is too fast to count".
 */
type PaceZoneDef = { key: PaceZoneKey; label: string; maxOfAvg: number | null };

const ZONE_DEFS_SLOWEST_FIRST: PaceZoneDef[] = [
  { key: "recovery", label: "Recovery", maxOfAvg: null },
  { key: "easy", label: "Easy", maxOfAvg: 1.15 },
  { key: "steady", label: "Steady", maxOfAvg: 1.05 },
  { key: "tempo", label: "Tempo", maxOfAvg: 0.95 },
  { key: "fast", label: "Fast", maxOfAvg: 0.85 },
];

// Declared slowest-first above because that's the order a zone breakdown is
// read; sorted here fastest-first (ascending bound, `null` last) because
// that's the order `paceZoneFor` needs to test against.
export const PACE_ZONES: PaceZoneDef[] = ZONE_DEFS_SLOWEST_FIRST.slice().sort((a, b) => {
  if (a.maxOfAvg === null) return 1;
  if (b.maxOfAvg === null) return -1;
  return a.maxOfAvg - b.maxOfAvg;
});

/** Seconds per kilometre for one split, or `null` for a non-positive distance. */
export function splitPaceSecPerKm(split: RunSplit): number | null {
  if (!(split.distance_m > 0) || !(split.duration_seconds > 0)) return null;
  return split.duration_seconds / (split.distance_m / 1000);
}

/** Which zone a pace falls in, given the run's own average pace. */
export function paceZoneFor(
  paceSecPerKm: number,
  avgPaceSecPerKm: number,
): PaceZoneKey {
  if (!(avgPaceSecPerKm > 0)) return "steady";
  const ratio = paceSecPerKm / avgPaceSecPerKm;
  for (const z of PACE_ZONES) {
    if (z.maxOfAvg === null || ratio <= z.maxOfAvg) return z.key;
  }
  return "recovery";
}

export type PaceZoneBucket = {
  key: PaceZoneKey;
  label: string;
  seconds: number;
  meters: number;
  /** Share of the run's total (split) time and distance, 0–1. */
  pctTime: number;
  pctDistance: number;
};

export type PaceZoneBreakdown = {
  /** This run's own average pace, computed from the splits — see file doc. */
  avgPaceSecPerKm: number;
  totalSeconds: number;
  totalMeters: number;
  /** Slowest to fastest, matching `PACE_ZONES`'s declared reading order. */
  zones: PaceZoneBucket[];
};

/**
 * The pace-zone breakdown for a run, or `null` when there is nothing to
 * break down — no splits, or splits with no usable distance/duration (a
 * manual entry has neither).
 */
export function paceZoneBreakdown(splits: RunSplit[]): PaceZoneBreakdown | null {
  const usable = splits.filter((s) => s.distance_m > 0 && s.duration_seconds > 0);
  if (usable.length === 0) return null;

  const totalMeters = usable.reduce((n, s) => n + s.distance_m, 0);
  const totalSeconds = usable.reduce((n, s) => n + s.duration_seconds, 0);
  const avgPaceSecPerKm = totalSeconds / (totalMeters / 1000);

  const byKey = new Map<PaceZoneKey, { seconds: number; meters: number }>();
  for (const s of usable) {
    const pace = splitPaceSecPerKm(s);
    if (pace === null) continue;
    const key = paceZoneFor(pace, avgPaceSecPerKm);
    const cur = byKey.get(key) ?? { seconds: 0, meters: 0 };
    cur.seconds += s.duration_seconds;
    cur.meters += s.distance_m;
    byKey.set(key, cur);
  }

  // Slowest-to-fastest reading order — the declaration order in PACE_ZONES,
  // not the sorted-for-lookup order above.
  const readingOrder: PaceZoneKey[] = ["recovery", "easy", "steady", "tempo", "fast"];
  const labelFor = (k: PaceZoneKey) => PACE_ZONES.find((z) => z.key === k)!.label;

  const zones: PaceZoneBucket[] = readingOrder
    .map((key) => {
      const b = byKey.get(key) ?? { seconds: 0, meters: 0 };
      return {
        key,
        label: labelFor(key),
        seconds: b.seconds,
        meters: b.meters,
        pctTime: totalSeconds > 0 ? b.seconds / totalSeconds : 0,
        pctDistance: totalMeters > 0 ? b.meters / totalMeters : 0,
      };
    })
    // Zones with nothing in them are real information (this run never
    // dropped into Recovery) but clutter a bar chart with zero-width bars —
    // dropped from the returned list, kept computable from `byKey` above if
    // a future caller wants the full five.
    .filter((z) => z.seconds > 0);

  return { avgPaceSecPerKm, totalSeconds, totalMeters, zones };
}

/* ── Run-to-run comparison ─────────────────────────────────────────────── */

export type RunSummary = {
  sessionId: string;
  name: string;
  startedAt: string;
  distanceM: number | null;
  durationSeconds: number | null;
  avgPaceSecPerKm: number | null;
  elevationGainM: number | null;
};

export type RunComparison = {
  /** `b`'s value minus `a`'s. Positive means B covered/climbed/took more. */
  distanceDeltaM: number | null;
  durationDeltaSeconds: number | null;
  /** Positive means B was SLOWER (more seconds per km). */
  paceDeltaSecPerKm: number | null;
  elevationGainDeltaM: number | null;
};

function numDelta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return b - a;
}

/** The diff behind the side-by-side comparison view. Order matters: `b - a`. */
export function compareRuns(a: RunSummary, b: RunSummary): RunComparison {
  return {
    distanceDeltaM: numDelta(a.distanceM, b.distanceM),
    durationDeltaSeconds: numDelta(a.durationSeconds, b.durationSeconds),
    paceDeltaSecPerKm: numDelta(a.avgPaceSecPerKm, b.avgPaceSecPerKm),
    elevationGainDeltaM: numDelta(a.elevationGainM, b.elevationGainM),
  };
}

/* ── Elevation profile ──────────────────────────────────────────────────── */

export type ElevationPoint = { distanceM: number; elevationM: number };

/** Whether a track carries enough elevation to be worth charting at all. */
export function hasElevationData(points: RunRoutePoint[]): boolean {
  return points.some((p) => p.elevation_m != null);
}

/**
 * The elevation profile as (cumulative distance, elevation) pairs.
 *
 * A point missing `elevation_m` is dropped rather than interpolated — the
 * same "a gap is a hole, not a straight line" rule `LoadHistoryChart` follows
 * for a missed weigh-in — but the cumulative distance still walks through it,
 * so the point either side of a gap keeps its true distance along the route
 * rather than the gap silently compressing the x-axis.
 */
export function elevationProfile(points: RunRoutePoint[]): ElevationPoint[] {
  const out: ElevationPoint[] = [];
  let cumulative = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) cumulative += haversineMeters(points[i - 1], points[i]);
    const e = points[i].elevation_m;
    if (e != null) out.push({ distanceM: cumulative, elevationM: e });
  }
  return out;
}

/* ── Route projection (for the hand-rolled SVG map) ─────────────────────── */

export type ScreenPoint = { x: number; y: number };

/**
 * Project a GPS track onto a `width`×`height` box, equirectangular with a
 * longitude correction for the route's own latitude — flat enough to be
 * wrong at continental scale and exactly right at running scale, which is
 * all this ever draws. Longitude degrees are scaled by `cos(latitude)`
 * before fitting, so a route run near the equator and one run near the pole
 * both come out the correct SHAPE rather than lines stretched east-west by a
 * naive equirectangular plot — the same correction real map projections
 * apply locally.
 *
 * The result fills the box while preserving aspect ratio and is centred
 * within it — a route that's mostly north-south doesn't get stretched
 * sideways to fill a wide box. A single point, or a track with zero span in
 * both directions, is centred rather than dividing by zero.
 */
export function projectRoute(
  points: { lat: number; lng: number }[],
  width: number,
  height: number,
  padding = 16,
): ScreenPoint[] {
  if (points.length === 0) return [];

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const midLatRad = ((minLat + maxLat) / 2) * (Math.PI / 180);
  // Floored well above zero: at the poles cos(lat) -> 0 and longitude
  // degrees stop meaning anything, but no real run happens there.
  const cosLat = Math.max(0.01, Math.cos(midLatRad));

  const lngSpan = (maxLng - minLng) * cosLat;
  const latSpan = maxLat - minLat;
  const span = Math.max(lngSpan, latSpan) || 1; // a single point: nominal span

  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const scale = Math.min(innerW, innerH) / span;

  const usedW = lngSpan * scale;
  const usedH = latSpan * scale;
  const offsetX = padding + (innerW - usedW) / 2;
  const offsetY = padding + (innerH - usedH) / 2;

  return points.map((p) => ({
    x: offsetX + (p.lng - minLng) * cosLat * scale,
    // North is up: the maximum latitude maps to the smallest y.
    y: offsetY + (maxLat - p.lat) * scale,
  }));
}

/* ── CSV export (optional, N464's nice-to-have) ─────────────────────────── */

/**
 * A run's splits as CSV — `distance_m,duration_seconds,pace_sec_per_km`, one
 * row per split, header first. Deliberately the rawest numbers on the wire
 * rather than unit-formatted strings: a spreadsheet is where an athlete
 * converts and charts these themselves, and `formatPace`'s "5:12/km" is
 * unusable as a spreadsheet number the moment someone wants to average it.
 */
export function splitsToCSV(splits: RunSplit[]): string {
  const header = "distance_m,duration_seconds,pace_sec_per_km";
  const rows = splits.map((s) => {
    const pace = splitPaceSecPerKm(s);
    return [s.distance_m, s.duration_seconds, pace ?? ""].join(",");
  });
  return [header, ...rows].join("\n");
}
