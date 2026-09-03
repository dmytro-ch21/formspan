import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * The wire client for `/v1/biometric/*` (N476, backend-only until now — see
 * `backend/internal/modules/biometric/`). Deliberately platform-agnostic:
 * nothing here reads Health Connect or HealthKit, only plain data this app's
 * own health-store facade (`lib/healthConnect.ts` on Android today) has
 * already produced. That split is what N478's ticket asks to keep separate
 * "so a later consolidation is easy rather than a rewrite" — whichever
 * ticket adds the iOS side (N477) should be able to import this file
 * unchanged and never re-implement the request shapes below.
 *
 * Field names and enums mirror `backend/internal/modules/biometric/biometric.go`
 * and `contracts/public.openapi.yaml` exactly (snake_case on the wire, per
 * `docs/architecture/api-conventions.md`) — this file is the one place that
 * has to be kept in sync with them.
 */

/** Mirrors `biometric.MetricType` — only the values this ticket reads. */
export type BiometricMetricType = 'heart_rate' | 'vo2_max';

/** Mirrors `biometric.Source`. */
export type BiometricSource =
  | 'apple_watch'
  | 'oura'
  | 'whoop'
  | 'garmin'
  | 'manual'
  | 'android_wearable';

/** Mirrors `biometric.SourcePlatform`. */
export type BiometricSourcePlatform = 'healthkit' | 'health_connect' | 'manual';

/** Mirrors `biometric.HRSource` — the two values a client may ever CLAIM.
 *  `'none'` is never a legal claim (the backend derives it itself from an
 *  empty result — see `ComputeSessionMetrics`'s doc comment); this type
 *  intentionally excludes it so a caller cannot construct an illegal
 *  request. */
export type ClaimableHRSource = 'workout' | 'window';

/** One raw reading, ready to POST. Mirrors `biometric.Sample`'s JSON shape. */
export type BiometricSampleInput = {
  /** Client-generated — see `sampleID` in `lib/healthConnect.ts` for how
   *  this app derives a stable one from a Health Connect record. */
  id: string;
  metric_type: BiometricMetricType;
  source: BiometricSource;
  source_platform: BiometricSourcePlatform;
  value: number;
  unit: string;
  /** RFC3339 */
  measured_at: string;
  /** RFC3339, or omitted for an instantaneous reading (every reading this
   *  ticket produces). */
  period_end?: string;
};

export type SessionMetrics = {
  session_id: string;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  trimp: number | null;
  active_kcal: number | null;
  time_in_zones: Record<string, number>;
  hr_source: 'workout' | 'window' | 'none';
  sample_count: number;
  computed_at: string;
  rule_version: number;
};

/**
 * Upload a batch of raw readings, idempotently — a retry that re-sends the
 * same `id`s converges rather than duplicating (see `biometric.Sample`'s doc
 * comment). Throws `ApiError` on failure; a caller that wants "nothing to
 * upload" to be a no-op should check `samples.length` itself, since the
 * backend rejects an empty batch as `invalid_input`.
 */
export async function putBiometricSamples(
  getToken: TokenGetter,
  samples: BiometricSampleInput[],
): Promise<BiometricSampleInput[]> {
  const res = await apiRequest<{ samples: BiometricSampleInput[] }>(
    getToken,
    '/biometric/samples',
    { method: 'POST', body: JSON.stringify({ samples }) },
  );
  return res.samples;
}

/**
 * (Re)compute and store `session_metrics` for a session this account owns,
 * from whatever `heart_rate` samples already fall in its window — a caller
 * must `putBiometricSamples` first, or this simply finds none and the
 * backend downgrades to `hr_source: 'none'` on its own (never a client
 * claim — see `ClaimableHRSource`).
 */
export async function computeSessionMetrics(
  getToken: TokenGetter,
  sessionID: string,
  hrMaxBPM: number,
  hrSource: ClaimableHRSource,
): Promise<SessionMetrics> {
  const res = await apiRequest<{ metrics: SessionMetrics }>(
    getToken,
    `/biometric/sessions/${encodeURIComponent(sessionID)}/metrics`,
    { method: 'POST', body: JSON.stringify({ hr_max_bpm: hrMaxBPM, hr_source: hrSource }) },
  );
  return res.metrics;
}
