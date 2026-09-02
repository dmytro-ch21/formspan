import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * The running half of a session — client half of `internal/modules/running`'s
 * session files.
 *
 * A running session is an ordinary session (`sport: 'running'`) plus this,
 * mirroring `lib/bjjSession.ts`'s relationship to `internal/modules/bjj`
 * exactly, for the same reason: keeping the session row where every other
 * sport's lives is what makes a run show up in training history, the
 * consistency grid and the cross-sport load picture, instead of in a corner
 * of the app labelled Running. This module owns only what a run has and a
 * lift or a mat session do not: the GPS track, splits, elevation and pace.
 */

/** Where the track and numbers came from. Matches `running.Source` exactly. */
export type Source = 'phone_gps' | 'healthkit' | 'manual';

/**
 * One recorded point along the run.
 *
 * `elevation_m` is nullable — common indoors, on an older phone, or on a
 * thinned-out imported track — and `null` is deliberately not defaulted to 0,
 * which would assert sea level for a run that simply didn't say.
 */
export type RoutePoint = {
  lat: number;
  lng: number;
  elevation_m: number | null;
  /** ISO 8601 / RFC3339 — what lets a client re-derive pace-over-time. */
  recorded_at: string;
};

/** One distance-based split — "this kilometre took 5:12". */
export type Split = {
  distance_m: number;
  duration_seconds: number;
};

export type SessionDetail = {
  session_id: string;
  route_points: RoutePoint[];
  splits: Split[];
  elevation_gain_m: number | null;
  avg_pace_sec_per_km: number | null;
  distance_m: number | null;
  duration_seconds: number | null;
  source: Source;
  created_at?: string;
  updated_at?: string;
};

/** A blank detail for a freshly-started run, tracked live by this phone. */
export function emptyDetail(sessionID: string): SessionDetail {
  return {
    session_id: sessionID,
    route_points: [],
    splits: [],
    elevation_gain_m: null,
    avg_pace_sec_per_km: null,
    distance_m: null,
    duration_seconds: null,
    source: 'phone_gps',
  };
}

/**
 * The exercise id the generic personal-record pipeline reads for a run.
 *
 * Matches `backend/internal/modules/exercise/exercises.json`'s `"run"` entry
 * (`load_type: distance_time`, `sport: running`) — a running session writes a
 * `session_sets` row against this id so `longest_time`/`furthest_distance`
 * already work for it through `session.Records`, exactly as
 * `internal/modules/running/running.go`'s package doc describes. Duplicated
 * as a constant rather than derived, the same call `running.go` itself makes
 * for `sportKey`: this is a storage-level fact about the seeded catalog, and
 * a client-side registry lookup would run the dependency backwards.
 */
export const RUN_EXERCISE_ID = 'run';

/* ---------------------------------------------------------------------------
 * Pure calculation from a GPS track.
 *
 * Everything below takes only plain data (points, splits, numbers) and
 * returns plain data — no SQLite, no network, no React. That is what makes it
 * testable with a fixture track and nothing else running.
 * ------------------------------------------------------------------------- */

const EARTH_RADIUS_M = 6371000;

/**
 * Great-circle distance between two points, in metres.
 *
 * The haversine formula — accurate enough for a run-length track (it starts
 * to matter at hundreds of kilometres, not kilometres) and cheap enough to
 * call once per consecutive point pair on a phone.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  // Clamped: floating-point drift can push `h` fractionally past 1, which
  // makes `Math.sqrt` produce a value `asin` cannot accept and returns NaN
  // for two points that are, for any practical purpose, identical.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Total distance covered by a track, in metres.
 *
 * The sum of consecutive great-circle segments — not a straight line from
 * start to finish, which would silently shrink every out-and-back and every
 * loop to a fraction of what was actually run.
 */
export function trackDistanceMeters(points: RoutePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

/**
 * Wall-clock span of a track, from its first recorded point to its last, in
 * seconds.
 *
 * **This is span, not ACTIVE time, and the two differ the moment a run is
 * paused.** A pause stops the live screen recording new points for the
 * paused interval, but a track's first and last points still bound the
 * WHOLE run including that gap — this function has no way to know a gap in
 * the middle was a pause rather than a dead GPS patch, and must not guess.
 * So the live screen does NOT use this to compute the `duration_seconds` it
 * sends to the server: it keeps its own active-time accumulator (ticking
 * only between Resume and the next Pause/Finish) for that, and reserves this
 * function for a track known to have no pauses in it — the common shape a
 * fixture test exercises, and a manual/imported track with no live pausing
 * at all.
 */
export function trackDurationSeconds(points: RoutePoint[]): number {
  if (points.length < 2) return 0;
  const first = new Date(points[0].recorded_at).getTime();
  const last = new Date(points[points.length - 1].recorded_at).getTime();
  return Math.max(0, (last - first) / 1000);
}

/**
 * Seconds per kilometre, averaged over a distance and a duration.
 *
 * `null` for a non-positive distance rather than `Infinity` or a divide-by-
 * zero `NaN` — "no pace yet" is a state every caller (the live readout, the
 * finished-run summary) has to render as a dash, and a numeric sentinel would
 * make each one re-derive that check independently.
 */
export function averagePaceSecPerKm(distanceM: number, durationSeconds: number): number | null {
  if (!(distanceM > 0) || !(durationSeconds >= 0)) return null;
  return durationSeconds / (distanceM / 1000);
}

/**
 * Total climb, in metres — the sum of positive elevation deltas between
 * consecutive points.
 *
 * Descent is not subtracted (this is GAIN, not net elevation change), and a
 * point missing `elevation_m` contributes no delta on either side of it
 * rather than being treated as a drop to/from zero — a single dropped
 * reading must not register as a cliff.
 */
export function elevationGainMeters(points: RoutePoint[]): number {
  let gain = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].elevation_m;
    const b = points[i].elevation_m;
    if (a == null || b == null) continue;
    if (b > a) gain += b - a;
  }
  return gain;
}

/** The split distance every running app and every runner already thinks in. */
export const DEFAULT_SPLIT_METERS = 1000;

/**
 * Distance-based splits derived from a timestamped track.
 *
 * Walks the track's cumulative distance and, each time it crosses a split
 * boundary, LINEARLY INTERPOLATES the crossing time between the two points
 * that straddle it — both on distance and on time — rather than rounding to
 * the nearest recorded point. A GPS fix lands wherever the phone's sample
 * interval happens to put it, essentially never exactly on a kilometre; a
 * split reported as "whichever point was closest" would be off by however
 * long that interval is, every single split.
 *
 * A track with two or more boundaries inside one segment (a very sparse
 * track, or a `splitMeters` smaller than the sample spacing) still gets one
 * split per boundary crossed — the inner `while` keeps interpolating from the
 * same segment until it runs out of boundaries to cross.
 *
 * **Known, narrow, and out of scope**: if a split boundary happens to fall
 * inside the segment spanning a pause (no points are recorded while paused,
 * so that segment's two endpoints straddle the whole gap), that ONE split's
 * `duration_seconds` is inflated by however long the pause lasted — the same
 * limitation `trackDurationSeconds` documents for the run as a whole, here at
 * the scale of a single split rather than the total. Rare in practice (it
 * requires pausing within the last stretch of a kilometre) and not corrected
 * here, the same way `trackDurationSeconds` is not.
 */
export function splitsFromTrack(points: RoutePoint[], splitMeters = DEFAULT_SPLIT_METERS): Split[] {
  if (points.length < 2 || !(splitMeters > 0)) return [];

  const splits: Split[] = [];
  let cumulativeDistance = 0;
  let splitStartDistance = 0;
  let splitStartTime = new Date(points[0].recorded_at).getTime();
  let nextBoundary = splitMeters;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const segDist = haversineMeters(prev, cur);
    if (segDist <= 0) continue;

    const segStartDist = cumulativeDistance;
    const prevTime = new Date(prev.recorded_at).getTime();
    const curTime = new Date(cur.recorded_at).getTime();
    cumulativeDistance += segDist;

    while (cumulativeDistance >= nextBoundary) {
      const fraction = (nextBoundary - segStartDist) / segDist;
      const boundaryTime = prevTime + fraction * (curTime - prevTime);
      splits.push({
        distance_m: nextBoundary - splitStartDistance,
        duration_seconds: Math.max(0, Math.round((boundaryTime - splitStartTime) / 1000)),
      });
      splitStartDistance = nextBoundary;
      splitStartTime = boundaryTime;
      nextBoundary += splitMeters;
    }
  }
  return splits;
}

export function putDetail(
  getToken: TokenGetter,
  sessionID: string,
  detail: SessionDetail,
): Promise<{ detail: SessionDetail }> {
  return apiRequest<{ detail: SessionDetail }>(
    getToken,
    `/running/sessions/${encodeURIComponent(sessionID)}`,
    { method: 'PUT', body: JSON.stringify(detail) },
  );
}

export function getDetail(
  getToken: TokenGetter,
  sessionID: string,
): Promise<{ detail: SessionDetail }> {
  return apiRequest<{ detail: SessionDetail }>(
    getToken,
    `/running/sessions/${encodeURIComponent(sessionID)}`,
  );
}
