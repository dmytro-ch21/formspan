"use client";

import { apiRequest, type LoggedSet, type Token } from "@/lib/api";

/**
 * The running module's own endpoints, as the web app sees them.
 *
 * A wire layer and nothing else — no caching, no merging, no local state.
 * Mirrors `apps/mobile/lib/running.ts`'s wire types field for field
 * (`RunRoutePoint`/`RunSplit`/`RunningDetail` here are that file's
 * `RoutePoint`/`Split`/`SessionDetail`, renamed only to avoid colliding with
 * this app's own generic `Session`/session-detail vocabulary): the two apps
 * read the same `backend/internal/modules/running` contract, and a type that
 * drifts on one side is a bug that only shows up on the other. Split into its
 * own file for the same reason `nutritionApi.ts` is: `lib/api.ts` is already
 * thousands of lines, and this endpoint has nothing to do with the strength
 * session vocabulary that fills most of it.
 *
 * This file does not duplicate the pace/distance/elevation ARITHMETIC —
 * `lib/runningAnalysis.ts` owns that, taking these wire types as input, the
 * same split `apps/mobile/lib/running.ts` (wire + arithmetic in one file, for
 * a phone that also records tracks live) does not need but this app does: web
 * never records a track, it only reads and analyses one.
 */

/** Where a run's track and numbers came from. Matches `running.Source`. */
export type RunSource = "phone_gps" | "healthkit" | "manual";

/**
 * One recorded point along the run.
 *
 * `elevation_m` is nullable — common indoors, on an older phone, or on a
 * thinned-out imported track — and `null` is deliberately not defaulted to 0,
 * which would assert sea level for a run that simply didn't say.
 */
export type RunRoutePoint = {
  lat: number;
  lng: number;
  elevation_m: number | null;
  /** RFC3339. */
  recorded_at: string;
};

/** One distance-based split — "this kilometre took 5:12". */
export type RunSplit = {
  distance_m: number;
  duration_seconds: number;
};

/** The running half of a session — `GET/PUT /v1/running/sessions/{id}`. */
export type RunningDetail = {
  session_id: string;
  route_points: RunRoutePoint[];
  splits: RunSplit[];
  elevation_gain_m: number | null;
  avg_pace_sec_per_km: number | null;
  distance_m: number | null;
  duration_seconds: number | null;
  source: RunSource;
  created_at: string;
  updated_at: string;
};

/**
 * The exercise id the generic personal-record pipeline reads for a run.
 *
 * Matches `apps/mobile/lib/running.ts`'s constant of the same name and the
 * same reasoning: a running session writes a `session_sets` row against this
 * id, which is what lets the sessions list show a run's distance and duration
 * without a second fetch per row — see `runSetFrom` below.
 */
export const RUN_EXERCISE_ID = "run";

/**
 * The `run` set carrying a session's distance/duration, if it has logged one.
 *
 * Lets the sessions list show every run's headline numbers from the page it
 * already fetches (`Session.sets`), rather than one `GET
 * /v1/running/sessions/{id}` per row — the same shortcut the mobile app takes
 * nowhere near this list because it only ever shows one run's own detail.
 */
export function runSetFrom(sets: LoggedSet[]): LoggedSet | undefined {
  return sets.find((s) => s.exercise_id === RUN_EXERCISE_ID);
}

/**
 * Read a running session's stored detail.
 *
 * 404 is a real, expected case — a run logged with no detail yet, or a
 * session of another sport — so this is a plain wire call and every caller is
 * expected to catch `isNotFound` itself (`@/lib/api`), matching how
 * `ProgressSection` on the Records page treats an absent history rather than
 * this file deciding for every caller that absence means null.
 */
export function getRunningDetail(
  getToken: Token,
  sessionID: string,
  signal?: AbortSignal,
): Promise<RunningDetail> {
  return apiRequest<{ detail: RunningDetail }>(
    getToken,
    `/running/sessions/${encodeURIComponent(sessionID)}`,
    {},
    signal,
  ).then((b) => b.detail);
}
