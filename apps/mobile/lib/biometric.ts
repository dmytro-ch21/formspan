import { apiRequest } from './apiRequest';
import { isNotFound } from './apiError';
import type { TokenGetter } from './useAuthToken';

/**
 * The `biometric` module's wire shapes, and everything about reading a
 * session's heart-rate window and an athlete's VO₂max trend that does NOT
 * need a native call — N477/#822.
 *
 * ## Why this file is platform-agnostic and `lib/healthkit.ts` is not
 *
 * A sibling ticket (#823, N478) does the identical job for Android's Health
 * Connect. The two platforms disagree about almost everything upstream of a
 * sample existing — how you ask for one, what a denial looks like, whether a
 * background read needs a second permission (design doc §5.1–§5.2) — and
 * agree completely about what to DO with a sample once it is a plain
 * `{ value, measured_at, sourceName, sourceBundleId }` object: classify its
 * source, decide whether a session's window has anything worth uploading,
 * and call this API. Everything in this file operates on that plain shape,
 * never on a native type, so `lib/health/android.ts` (or whatever #823 ends
 * up naming its own native boundary) can hand this module the SAME inputs
 * `lib/healthkit.ts` does, and the window-join and upload-planning logic
 * below runs unmodified either way. `lib/healthkitSync.ts`'s own doc comment
 * makes the equivalent point about WHEN a pass runs; this file is the WHAT.
 */

// --- wire vocabulary, mirroring backend/internal/modules/biometric ---------

/**
 * Mirrors `biometric.MetricType` on the backend. Deliberately duplicated
 * rather than imported — the two live in different languages and different
 * repos-worth of build tooling, so this is a wire contract, not a shared
 * type. Keep in sync with `contracts/public.openapi.yaml`'s `BiometricSample`
 * schema, which is itself generated from nothing and hand-checked against
 * this same backend package.
 */
export type MetricType =
  | 'heart_rate'
  | 'active_energy'
  | 'resting_heart_rate'
  | 'hrv_sdnn'
  | 'hrv_rmssd'
  | 'sleep_duration'
  | 'body_mass'
  | 'vo2_max';

/** Mirrors `biometric.Source`. */
export type BiometricSource = 'apple_watch' | 'oura' | 'whoop' | 'garmin' | 'manual';

/** Mirrors `biometric.SourcePlatform`. */
export type SourcePlatform = 'healthkit' | 'health_connect' | 'manual';

/** Mirrors `biometric.HRSource`. Only `workout`/`window` are ever CLAIMED by
 *  a caller — `none` is the server's own derivation from an empty result
 *  (see `ComputeMetrics`'s doc comment on the backend), never something this
 *  app asks for. */
export type HRSource = 'workout' | 'window' | 'none';

/** One raw reading, on the wire — mirrors `biometric.Sample`'s JSON shape. */
export type BiometricSample = {
  id: string;
  metric_type: MetricType;
  source: BiometricSource;
  source_platform: SourcePlatform;
  value: number;
  unit: string;
  /** RFC3339. */
  measured_at: string;
  /** RFC3339, or omitted for an instantaneous reading (every sample this
   *  app writes today). */
  period_end?: string;
};

/** Mirrors `biometric.SessionMetrics`'s JSON shape. */
export type SessionMetrics = {
  session_id: string;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  trimp: number | null;
  active_kcal: number | null;
  time_in_zones: Record<string, number>;
  hr_source: HRSource;
  sample_count: number;
  computed_at: string;
  rule_version: number;
};

// --- source classification ---------------------------------------------

/**
 * Guess which `BiometricSource` a reading belongs to, from whatever the
 * writing device called itself.
 *
 * **A heuristic, not a lookup, and it is the honest state of the art.**
 * Neither HealthKit nor Health Connect exposes a vendor enum — a sample
 * carries only the free-text name/package a third-party app chose for
 * itself when it wrote the reading (design doc §5.3: "every stored sample
 * carries its source... which is also what makes the dedupe auditable
 * later"). Substring matching on that text is therefore not a shortcut
 * around a more precise API; it is the whole of what either platform gives
 * an app to work with.
 *
 * **Defaults to `apple_watch` for anything unrecognised, and that default is
 * a known, accepted approximation, not an oversight.** `biometric.Source` is
 * a closed enum with no `unknown`/`other` slot (deliberately — see its own
 * doc comment on `Source` being one of two independent axes alongside
 * `MetricType`), and the overwhelmingly common source of continuous
 * heart-rate and VO₂max samples reaching this app is the Watch: per design
 * doc §2, dense HR only exists at all when SOMETHING actively recorded a
 * workout, and Whoop/Garmin/Oura are exactly the vendors this function
 * checks for BEFORE falling back. A sample written by, say, a chest strap
 * this list has never heard of is misattributed rather than rejected — the
 * alternative (dropping it) would throw away real evidence to protect a
 * label nothing downstream currently keys behavior on (`source` is
 * informational today; design doc §6.3 reserves it for a future
 * per-`(metric_type, source)` trend split). Revisit if that changes.
 */
export function classifyHealthKitSource(sourceName: string, sourceBundleId: string): BiometricSource {
  const hay = `${sourceName} ${sourceBundleId}`.toLowerCase();
  if (hay.includes('whoop')) return 'whoop';
  if (hay.includes('oura')) return 'oura';
  if (hay.includes('garmin')) return 'garmin';
  return 'apple_watch';
}

// --- the window-join (design doc §2) -------------------------------------

/** A finished session's heart-rate read window — plain `Date`s, ready to
 *  hand a platform's own quantity-sample query. */
export type HRWindow = { start: Date; end: Date };

/**
 * The `[started_at, ended_at]` window to read heart rate for, or `null` when
 * there is none to compute — a session with no `ended_at` yet (still in
 * progress) or one whose recorded end somehow precedes its start (a clock
 * skew or a corrupted local row; better to read nothing than to hand a
 * native query an inverted range and get back whatever that happens to do).
 *
 * Pure and platform-free on purpose: this is THE join problem design doc §2
 * describes ("a session has started_at and ended_at, so query heart rate
 * samples in that window") reduced to the one piece of it that has nothing
 * to do with either health store — deciding whether a window exists at all.
 * Everything platform-specific (actually running the query) happens after
 * this returns non-null.
 */
export function sessionHRWindow(startedAt: string, endedAt: string | null | undefined): HRWindow | null {
  if (!endedAt) return null;
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end.getTime() < start.getTime()) return null;
  return { start, end };
}

// --- metric-type mapping --------------------------------------------------

/** The plain shape ANY platform's native boundary reduces a quantity sample
 *  to — `lib/healthkit.ts`'s `HealthKitQuantitySample` already matches this
 *  exactly; a Health Connect boundary would produce the same shape from a
 *  `HeartRateRecord`/`Vo2MaxRecord`. */
export type RawQuantitySample = {
  uuid: string;
  value: number;
  unit: string;
  /** RFC3339. */
  measuredAt: string;
  sourceName: string;
  sourceBundleId: string;
};

/**
 * One raw platform sample → one wire `BiometricSample`, for a given
 * `metric_type` and `source_platform`. Pure: no native call, no network —
 * the mapping this ticket's own text asks to be pure-logic tested.
 *
 * The sample's own `uuid` becomes the wire `id`. This is what makes a
 * repeated sync idempotent: the same HealthKit sample read on two foreground
 * passes (nothing marks it "already read" upstream of this — see
 * `lib/biometricSync.ts`) maps to the same `id` both times, and
 * `PutSamples`'s `ON CONFLICT DO NOTHING` (backend `postgres.go`) converges
 * rather than duplicating, exactly mirroring how `healthkit_uuid` already
 * makes a re-imported run a no-op.
 */
export function toBiometricSample(
  raw: RawQuantitySample,
  metricType: MetricType,
  sourcePlatform: SourcePlatform,
): BiometricSample {
  return {
    id: raw.uuid,
    metric_type: metricType,
    source: classifyHealthKitSource(raw.sourceName, raw.sourceBundleId),
    source_platform: sourcePlatform,
    value: raw.value,
    unit: raw.unit,
    measured_at: raw.measuredAt,
  };
}

// --- the hr_source decision (design doc §2) -------------------------------

/**
 * What a heart-rate sync pass should do, given whatever samples it read for
 * one session's window.
 *
 * - Zero samples → `compute-only`: nothing to PUT (the samples endpoint
 *   refuses an empty batch — see `handler.go`'s `PutSamples`), but the
 *   session's `ComputeMetrics` call still happens, so the server records an
 *   HONEST `hr_source: 'none'`, `sample_count: 0` row (design doc §6.4:
 *   absence is not itself the fact to record when we KNOW we looked and
 *   found nothing) rather than leaving `session_metrics` silently absent —
 *   which the acceptance criterion here is explicit could otherwise read as
 *   "not synced yet" rather than "no wearable evidence".
 * - One or more samples → `upload-and-compute`: PUT them, then compute.
 *
 * `hrSource` is ALWAYS the claim `'window'` in both branches — this ticket
 * builds no anchor refinement (design doc §2's second tier), so this app can
 * never honestly claim `'workout'`. The backend downgrades `'window'` to the
 * true `'none'` itself whenever `SampleCount` comes out zero regardless of
 * what is claimed (see `ComputeSessionMetrics`'s doc comment) — this
 * function's `hrSource` is a claim about EVIDENCE QUALITY conditional on
 * evidence existing, not a prediction of what the server will store.
 */
type ClaimableHRSource = Extract<HRSource, 'workout' | 'window'>;

export type HRSyncPlan =
  | { kind: 'compute-only'; hrSource: ClaimableHRSource }
  | { kind: 'upload-and-compute'; samples: BiometricSample[]; hrSource: ClaimableHRSource };

export function planHRSync(samples: BiometricSample[]): HRSyncPlan {
  if (samples.length === 0) return { kind: 'compute-only', hrSource: 'window' };
  return { kind: 'upload-and-compute', samples, hrSource: 'window' };
}

// --- HRmax (design doc §3) -------------------------------------------------

/** The same range the backend's `ComputeMetrics` enforces
 *  (`minHRMaxBPM`/`maxHRMaxBPM` in `handler.go`) — kept here too so a bad
 *  derivation is refused locally rather than spending a request to learn
 *  the same thing the server would have said. */
export const MIN_HR_MAX_BPM = 100;
export const MAX_HR_MAX_BPM = 250;

/**
 * Age in whole years on `on`, from a `YYYY-MM-DD` date of birth. Pure, and
 * exported for its own test — the one place a birthday's month/day matters
 * to a whole-years count, which a naive `on.getFullYear() - dob.getFullYear()`
 * gets wrong for anyone whose birthday this year hasn't happened yet.
 */
export function ageInYears(dateOfBirth: string, on: Date): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthdayThisYear =
    on.getUTCMonth() < dob.getUTCMonth() ||
    (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate());
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

/**
 * HRmax, seeded from `220 - age` — design doc §3's first of three steps
 * ("Seed from 220 − age... mark the session's zones as estimated"; the
 * other two — replacing this with the athlete's own observed maximum, and
 * never silently switching between the two — are explicitly future work,
 * not built by this ticket. Flagged as an open item in this ticket's
 * history entry.).
 *
 * Returns `null` when there is no date of birth to seed from, or when the
 * seeded value falls outside what `ComputeMetrics` will accept — an absent
 * HRmax means `lib/biometricSync.ts` leaves `session_metrics` uncomputed for
 * this pass rather than inventing a number, the same "absence is a normal
 * state, not an error" posture design doc §6.4 takes for enrichment
 * generally.
 */
export function hrMaxFromDateOfBirth(dateOfBirth: string | null | undefined, on: Date): number | null {
  if (!dateOfBirth) return null;
  const age = ageInYears(dateOfBirth, on);
  if (!Number.isFinite(age) || age <= 0) return null;
  const hrMax = 220 - age;
  if (hrMax < MIN_HR_MAX_BPM || hrMax > MAX_HR_MAX_BPM) return null;
  return hrMax;
}

// --- the API client ---------------------------------------------------

/**
 * Store a batch of raw readings — `POST /v1/biometric/samples`. Idempotent
 * on `id` (see `toBiometricSample`'s doc comment); never called with an
 * empty array, matching the endpoint's own refusal (`handler.go`).
 */
export function putBiometricSamples(
  getToken: TokenGetter,
  samples: BiometricSample[],
): Promise<{ samples: BiometricSample[] }> {
  return apiRequest(getToken, '/biometric/samples', {
    method: 'POST',
    body: JSON.stringify({ samples }),
  });
}

/**
 * List the caller's own samples of one metric type in `[from, to]`,
 * ascending — `GET /v1/biometric/samples`. What `lib/useVo2MaxTrend.ts`
 * fetches for the profile trend.
 */
export async function listBiometricSamples(
  getToken: TokenGetter,
  metricType: MetricType,
  from: string,
  to: string,
): Promise<BiometricSample[]> {
  const res = await apiRequest<{ samples: BiometricSample[] }>(
    getToken,
    `/biometric/samples?${new URLSearchParams({ metric_type: metricType, from, to }).toString()}`,
  );
  return res.samples;
}

/**
 * (Re)compute a session's heart-rate metrics —
 * `POST /v1/biometric/sessions/{id}/metrics`. `hrSource` is always the claim
 * `'workout'` or `'window'` — see `HRSyncPlan`'s doc comment; the server
 * derives the true `'none'` itself when there is no evidence.
 */
export function computeSessionMetrics(
  getToken: TokenGetter,
  sessionID: string,
  hrMaxBPM: number,
  hrSource: Extract<HRSource, 'workout' | 'window'>,
): Promise<{ metrics: SessionMetrics }> {
  return apiRequest(getToken, `/biometric/sessions/${sessionID}/metrics`, {
    method: 'POST',
    body: JSON.stringify({ hr_max_bpm: hrMaxBPM, hr_source: hrSource }),
  });
}

/**
 * Read a session's previously computed metrics — `GET
 * /v1/biometric/sessions/{id}/metrics`. `null` when none has been computed
 * yet (404) — design doc §6.4's "normal state, not an error" — rather than
 * throwing, so a caller can render "not yet enriched" without a try/catch of
 * its own.
 */
export async function getSessionMetrics(
  getToken: TokenGetter,
  sessionID: string,
): Promise<SessionMetrics | null> {
  try {
    const res = await apiRequest<{ metrics: SessionMetrics }>(
      getToken,
      `/biometric/sessions/${sessionID}/metrics`,
    );
    return res.metrics;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * One session's contribution to the cross-session training-load trend —
 * N489/#850. Mirrors `biometric.SessionLoad` on the backend. `trimp` is
 * never absent here: a session with no computed metrics, or with
 * `hr_source: 'none'`, is excluded from the list server-side rather than
 * reported as zero load — see `listSessionLoad`'s doc comment.
 */
export type SessionLoad = {
  session_id: string;
  sport: 'strength' | 'running' | 'bjj';
  /** RFC3339. */
  started_at: string;
  trimp: number;
};

/**
 * List the caller's own sessions with a computed TRIMP in `[from, to]`,
 * ascending — `GET /v1/biometric/sessions/load`. What
 * `lib/useTrainingLoadTrend.ts` fetches for the Progress-tab trend.
 *
 * **One call, not N** — the reasoning that made this a real endpoint rather
 * than a per-session loop over `getSessionMetrics` lives on the backend
 * (`biometric.Repository.ListSessionLoad`'s doc comment) and in this
 * ticket's history entry: a "last year" window can legitimately hold
 * hundreds of sessions, and one query beats hundreds of round trips.
 *
 * A session with no computed metrics yet, or with `hr_source: 'none'` (no
 * HR evidence at all — no wearable, or it never synced), is excluded from
 * the result by the server, never reported as zero load. Cross-sport by
 * construction: BJJ, strength and running sessions all appear in one list,
 * since TRIMP is computed identically regardless of sport.
 */
export async function listSessionLoad(
  getToken: TokenGetter,
  from: string,
  to: string,
): Promise<SessionLoad[]> {
  const res = await apiRequest<{ sessions: SessionLoad[] }>(
    getToken,
    `/biometric/sessions/load?${new URLSearchParams({ from, to }).toString()}`,
  );
  return res.sessions;
}
