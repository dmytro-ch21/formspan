import { apiRequest } from './apiRequest';
import { isNotFound } from './apiError';
import type { TokenGetter } from './useAuthToken';

/**
 * The `biometric` module's wire shapes, and every platform-agnostic decision
 * around a session's heart-rate window and an athlete's VO₂max trend — N477
 * (iOS), N478 (Android), consolidated by N485/#837.
 *
 * ## Why this is the ONE module, not two
 *
 * N477 and N478 were built concurrently against the same backend (N476)
 * targeting the same conceptual problem — read HR/VO₂max from a platform
 * health store, window-join it against a finished session, upload to
 * `/v1/biometric/*` — on two different platforms. Neither had merged before
 * the other started, so each ended up with its own parallel implementation of
 * the platform-agnostic half: N477 shipped this file (`biometric.ts`) already
 * combining the pure decisions and the wire client in one place; N478 shipped
 * the same logic split across `biometricEnrichment.ts` (pure) and
 * `biometricApi.ts` (wire), explicitly designed with zero platform imports
 * "so a later consolidation is easy rather than a rewrite."
 *
 * That reasoning was sound, but it did not actually distinguish the two
 * candidates — THIS file has zero platform imports too (see the imports
 * above: `apiRequest`, `isNotFound`, a token type, nothing from `healthkit.ts`
 * or `healthConnect.ts`). Both were equally shareable; the tie-break was
 * everything else: this file already matched the wire contract more closely
 * (the full `MetricType` enum; `listBiometricSamples`/`getSessionMetrics`,
 * which N478 never needed and never built), and it already had three
 * downstream consumers beyond its own orchestrator
 * (`useVo2MaxTrend.ts`, `hrSessionReport.ts`, `bjjSession.ts`) against
 * N478's one. Consolidating onto the Android pair would have meant adding
 * those two functions back rather than deleting anything. So this file
 * stays, absorbing N478's genuinely additional pieces — the Health Connect
 * window-overlap clip, the history-wall check, and the retry-ledger pure
 * decisions — and `biometricEnrichment.ts`/`biometricApi.ts` are deleted.
 * `lib/healthkit.ts` (iOS-specific) and `lib/healthConnect.ts`
 * (Android-specific) are untouched — this ticket moves nothing across that
 * boundary, only removes the duplicate on this side of it.
 *
 * ## Two real bugs this consolidation fixes, not just moves
 *
 * 1. **`BiometricSource` was missing `android_wearable`.** N478's own copy of
 *    this type had it (added there because `healthConnect.ts`'s
 *    `sourceFromDataOrigin` needs it — a Health Connect sample from an
 *    unrecognised vendor). This file's copy did not, because iOS never
 *    produces that value. A single shared type has to carry the union of
 *    both platforms' legal values, matching `contracts/public.openapi.yaml`'s
 *    `BiometricSample.source` enum exactly.
 * 2. **`computeSessionMetrics` never sent `hr_max_source`.** N483/#833
 *    (merged 2026-09-04, after both N477 and N478) added a REQUIRED
 *    `hr_max_source` field to `POST /biometric/sessions/{id}/metrics` —
 *    backend-only, no mobile client ever updated. Since then, EVERY call
 *    this app makes to that endpoint (either platform) has been rejected
 *    with `invalid_input`, silently — the pass swallows the error and the
 *    next foreground return tries again, forever, with the same missing
 *    field. Both the iOS and Android sync passes were broken, unnoticed,
 *    because nothing here calls the live endpoint in a test. Fixed by
 *    threading an `HRMaxSource` argument through — see `computeSessionMetrics`
 *    below. Every caller today only ever produces the `220 − age` estimate
 *    (`hrMaxFromDateOfBirth`), so both orchestrators pass `'estimated'`;
 *    `'observed'` has no producer yet anywhere in this app (future work, not
 *    this ticket's scope).
 *
 * ## One real behavior reconciliation
 *
 * N477's `hrMaxFromDateOfBirth` and N478's `estimateHRMaxBPM` disagreed for
 * an implausible date of birth that seeds an HRmax outside
 * [`MIN_HR_MAX_BPM`, `MAX_HR_MAX_BPM`] (in practice: an athlete recorded as
 * roughly 120+ years old) — N477 returned `null` ("leave `session_metrics`
 * uncomputed this pass rather than inventing a number", this file's own
 * design stance, stated below on `hrMaxFromDateOfBirth`); N478 CLAMPED to
 * the nearest bound instead. This merge keeps N477's null-rather-than-invent
 * behavior for both platforms — clamping is itself a fabricated number, just
 * one sitting exactly on the boundary, and the "don't invent" stance is the
 * one already written down as this app's design intent. This is the only
 * behavioral difference found between the two implementations; the edge case
 * it touches (a profile date of birth implying an age past ~120) has never
 * been observed in practice on either platform.
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

/** Mirrors `biometric.Source`. `android_wearable` (N478) is a Health Connect
 *  sample whose writing app isn't one of the named vendors — Samsung Health
 *  chief among them, since Health Connect exposes no stable per-vendor
 *  identifier this API could otherwise match against; see
 *  `lib/healthConnect.ts`'s `sourceFromDataOrigin`. */
export type BiometricSource = 'apple_watch' | 'oura' | 'whoop' | 'garmin' | 'manual' | 'android_wearable';

/** Mirrors `biometric.SourcePlatform`. */
export type SourcePlatform = 'healthkit' | 'health_connect' | 'manual';

/** Mirrors `biometric.HRSource`. Only `workout`/`window` are ever CLAIMED by
 *  a caller — `none` is the server's own derivation from an empty result
 *  (see `ComputeMetrics`'s doc comment on the backend), never something this
 *  app asks for. */
export type HRSource = 'workout' | 'window' | 'none';

/** Mirrors `biometric.HRMaxSource` (N483/#833) — whether `hr_max_bpm` is the
 *  `220 − age` estimate or an observed maximum from the athlete's own
 *  history. This app currently only ever produces `'estimated'`;
 *  `'observed'` has no producer yet (design doc §3's second/third steps —
 *  future work). */
export type HRMaxSource = 'estimated' | 'observed';

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
  /** The HRmax value that actually produced this row's trimp/time_in_zones
   *  (N483/#833) — null together with them on the same "couldn't classify"
   *  gate, and on any row computed before this field existed. */
  hr_max_bpm: number | null;
  /** Null under the identical conditions as hr_max_bpm. */
  hr_max_source: HRMaxSource | null;
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
 *
 * iOS-specific in what it classifies (HealthKit's `sourceName`/
 * `sourceBundleId`) — `lib/healthConnect.ts`'s `sourceFromDataOrigin` is the
 * Android equivalent, classifying a different platform's own provenance
 * data with a genuinely different rule (package-name lookup, defaulting to
 * `android_wearable` rather than `apple_watch`). The two are not the same
 * function wearing different names; each stays with the platform whose
 * provenance shape it reads, both living here only because neither imports
 * anything platform-specific to do it.
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

/** One heart-rate reading, reduced to plain data — what a Health Connect
 *  `HeartRateRecord`'s `samples` array becomes after `lib/healthConnect.ts`
 *  maps it (N478). */
export type RawHeartRateSample = {
  /** RFC3339 */
  time: string;
  beatsPerMinute: number;
};

/**
 * Individual samples actually inside `[windowStart, windowEnd]`, inclusive.
 *
 * Needed because Health Connect's own `timeRangeFilter` on `readRecords`
 * filters at the RECORD level, not the sample level — a `HeartRateRecord`
 * whose interval merely OVERLAPS the query window is returned in full, and
 * its `samples` array can carry points from a few seconds either side of the
 * record's queried boundary. Clipping here is what makes the window join
 * exact rather than approximately-the-window, the same edge case the design
 * doc's `enrich.ts` sketch calls out ("a session that spans midnight, a
 * watch workout that starts before ours").
 *
 * Android-specific in why it exists (Health Connect's record-level
 * filtering), but pure over plain data, so it lives here rather than in
 * `lib/healthConnect.ts` — `queryHeartRateSamples` there applies it before
 * this app ever sees a raw sample. Harmless, and unused, on the iOS side
 * today, since `lib/healthkit.ts`'s own query already returns samples
 * exactly bounded by its predicate.
 */
export function heartRateSamplesInWindow(
  samples: readonly RawHeartRateSample[],
  windowStart: string,
  windowEnd: string,
): RawHeartRateSample[] {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  return samples.filter((s) => {
    const t = new Date(s.time).getTime();
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });
}

/**
 * Health Connect's own read wall (design doc §5.2, N478): by default a read
 * permission only ever surfaces the previous 30 days of another app's
 * history — reading further back needs a SEPARATE, Play-review-gated
 * permission (`PERMISSION_READ_HEALTH_DATA_HISTORY`) this app does not
 * request. Attempting to read past the wall without it is a native ERROR,
 * not an empty result (§5.2 again) — so the fix is not to attempt it: a
 * session whose window starts before the wall is skipped before any native
 * call is made, which is what turns an inevitable failure into a documented,
 * predictable gap instead of a confusing one. HealthKit has no equivalent
 * wall, so this check is only ever applied on the Android path.
 */
export const HEALTH_CONNECT_HISTORY_WALL_DAYS = 30;

export function isWithinHealthConnectHistoryWall(
  sessionStartedAt: string,
  now: Date,
  wallDays: number = HEALTH_CONNECT_HISTORY_WALL_DAYS,
): boolean {
  const startedMs = new Date(sessionStartedAt).getTime();
  if (!Number.isFinite(startedMs)) return false;
  const wallStartMs = now.getTime() - wallDays * 24 * 60 * 60 * 1000;
  return startedMs >= wallStartMs;
}

// --- metric-type mapping --------------------------------------------------

/** The plain shape ANY platform's native boundary reduces a quantity sample
 *  to — `lib/healthkit.ts`'s `HealthKitQuantitySample` already matches this
 *  exactly; `lib/healthConnect.ts`'s Health Connect boundary produces the
 *  same shape from a `HeartRateRecord`/`Vo2MaxRecord`. */
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
 * `hrSource` is ALWAYS the claim `'window'` in both branches — neither
 * platform builds any anchor refinement (design doc §2's second tier), so
 * this app can never honestly claim `'workout'`. The backend downgrades
 * `'window'` to the true `'none'` itself whenever `SampleCount` comes out
 * zero regardless of what is claimed (see `ComputeSessionMetrics`'s doc
 * comment) — this function's `hrSource` is a claim about EVIDENCE QUALITY
 * conditional on evidence existing, not a prediction of what the server
 * will store.
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
 *
 * UTC throughout, deliberately — a whole-years count must not depend on the
 * device's own timezone, which would make the same profile report a
 * different age depending on where the phone happens to be.
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
 * never silently switching between the two — are explicitly future work).
 * The sole producer of `hr_max_source: 'estimated'` in this app today; see
 * `HRMaxSource`'s doc comment.
 *
 * Returns `null` when there is no date of birth to seed from, or when the
 * seeded value falls outside what `ComputeMetrics` will accept — an absent
 * HRmax means the calling sync module leaves `session_metrics` uncomputed
 * for this pass rather than inventing a number, the same "absence is a
 * normal state, not an error" posture design doc §6.4 takes for enrichment
 * generally. Deliberately does NOT clamp an out-of-range estimate to the
 * nearest bound — see this file's own doc comment on why that would just be
 * a different fabricated number.
 */
export function hrMaxFromDateOfBirth(dateOfBirth: string | null | undefined, on: Date): number | null {
  if (!dateOfBirth) return null;
  const age = ageInYears(dateOfBirth, on);
  if (!Number.isFinite(age) || age <= 0) return null;
  const hrMax = 220 - age;
  if (hrMax < MIN_HR_MAX_BPM || hrMax > MAX_HR_MAX_BPM) return null;
  return hrMax;
}

// --- retry ledger (pure decisions, N478 + N511) -----------------------

/** What this device already knows about one session's enrichment attempt —
 *  the local ledger row (`lib/db.ts`'s `health_connect_enrichment` table on
 *  Android, `biometric_hr_synced` on iOS as of N511/#893 — both the same
 *  shape now, read by each platform's own orchestrator). This type, and
 *  `needsEnrichmentAttempt` below, are the shared decision both platforms
 *  make from it; only the SQL reading/writing the row differs. */
export type EnrichmentLedgerEntry = {
  /** `'window'` once real evidence has been found and stored — a session
   *  never needs retrying past that point. `'none'` means the last attempt
   *  found zero samples; see `needsEnrichmentAttempt` for the retry
   *  window. */
  hrSource: 'window' | 'none';
  /** RFC3339, when the last attempt ran. */
  attemptedAt: string;
};

/**
 * How long a `'none'` result stays worth re-checking, and how long between
 * re-checks.
 *
 * The watch may not have synced its samples to the phone yet at the moment
 * the athlete closes the app (design doc §6.4: "enrichment is not
 * blocking… possibly much later") — so a fresh `'none'` deserves a few more
 * tries. Past `RETRY_WINDOW_DAYS`, a session that still has no samples
 * almost certainly never will (no watch, or the watch was never worn for
 * this one), and asking Health Connect again on every single foreground
 * return forever, for every session an athlete without a wearable has ever
 * logged, is real ongoing cost with no plausible upside.
 */
export const RETRY_WINDOW_DAYS = 3;
export const RETRY_COOLDOWN_HOURS = 12;

/** A finished session, reduced to what enrichment needs to know about it. */
export type EnrichmentCandidate = {
  id: string;
  /** RFC3339 */
  startedAt: string;
  /** RFC3339, or `null` for a session still in progress — never a
   *  candidate. */
  endedAt: string | null;
};

/**
 * Whether THIS session is worth asking Health Connect about right now —
 * everything except the history-wall check, which
 * `selectEnrichmentCandidates` applies separately since it needs no ledger
 * state at all.
 */
export function needsEnrichmentAttempt(
  session: Pick<EnrichmentCandidate, 'endedAt'>,
  ledgerEntry: EnrichmentLedgerEntry | undefined,
  now: Date,
): boolean {
  if (!session.endedAt) return false;
  if (!ledgerEntry) return true;
  if (ledgerEntry.hrSource === 'window') return false;

  const endedMs = new Date(session.endedAt).getTime();
  if (!Number.isFinite(endedMs)) return false;
  const stillWorthRetrying = now.getTime() - endedMs <= RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (!stillWorthRetrying) return false;

  const attemptedMs = new Date(ledgerEntry.attemptedAt).getTime();
  if (!Number.isFinite(attemptedMs)) return true;
  return now.getTime() - attemptedMs >= RETRY_COOLDOWN_HOURS * 60 * 60 * 1000;
}

/**
 * Every locally-known finished session actually worth an enrichment pass
 * right now — combines `needsEnrichmentAttempt` (the ledger/retry decision)
 * with the history-wall skip (§5.2), so a caller need not remember to apply
 * both. Order is preserved from `sessions`.
 */
export function selectEnrichmentCandidates<S extends EnrichmentCandidate>(
  sessions: readonly S[],
  ledger: ReadonlyMap<string, EnrichmentLedgerEntry>,
  now: Date,
): S[] {
  return sessions.filter((s) => {
    if (!needsEnrichmentAttempt(s, ledger.get(s.id), now)) return false;
    return isWithinHealthConnectHistoryWall(s.startedAt, now);
  });
}

// --- chunking large sync batches (N502/#873) -------------------------------

/**
 * How many samples one `PutSamples` request carries at most.
 *
 * Comfortably under both backend ceilings on `/v1/biometric/samples`
 * (`MaxSamplesPerRequest` = 10,000 rows; `maxSamplesBody` = 4 MiB, at the
 * backend's own ~200-bytes/row estimate — `handler.go`), with margin rather
 * than a tight fit against either: a dense Apple Watch session (continuous
 * per-second HR over a long or backfilled workout — `queryHeartRateSamples`'s
 * own native-query ceiling, `QUANTITY_QUERY_LIMIT` in `healthkit.ts`, is
 * 20,000, double the backend's row cap) or a first-run VO₂max backfill can
 * otherwise land a single request right at the size wall. That used to come
 * back as an indistinguishable "invalid JSON body" (fixed server-side above,
 * N502/#873) with nothing for the client to do about it — chunking here is
 * the actual fix: a batch this large now goes out as several requests that
 * each stay well clear of either cap, rather than one that can fail outright.
 * 2,000 keeps a 5x margin under the row cap and roughly a 10x margin under
 * the body-size cap even if real samples run well over the ~200-byte
 * estimate.
 */
export const SAMPLES_PER_SYNC_REQUEST = 2000;

/**
 * Split `items` into chunks of at most `size`, preserving order. Pure — the
 * piece of the chunking this ticket's own text asks to be pure-logic tested,
 * same posture as every other decision in this file. An empty `items` yields
 * zero chunks, matching `putBiometricSamples` never actually being called
 * with one (see its own doc comment) rather than sending an empty request.
 */
export function chunkSamples<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(size, 1);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    chunks.push(items.slice(i, i + step));
  }
  return chunks;
}

// --- the API client ---------------------------------------------------

/**
 * Store a batch of raw readings — `POST /v1/biometric/samples`, one request
 * per `SAMPLES_PER_SYNC_REQUEST`-sized chunk (N502/#873; see that constant's
 * doc comment for why). Idempotent on `id` (see `toBiometricSample`'s doc
 * comment) both within and across chunks, so a chunk that partially lands and
 * then fails costs nothing on retry; never called with an empty array,
 * matching the endpoint's own refusal (`handler.go`) — an empty `samples`
 * produces zero chunks and this makes no network call at all.
 *
 * Sequential, not parallel, deliberately: this is a background enrichment
 * pass with no latency budget (`biometricSync.ts`'s own doc comment), so
 * there is nothing to gain from concurrency and something to lose — a burst
 * of parallel requests would be needless simultaneous load on exactly the
 * kind of pass this module goes out of its way to keep gentle (no retry
 * ladder, foreground-triggered only).
 */
export async function putBiometricSamples(
  getToken: TokenGetter,
  samples: BiometricSample[],
): Promise<{ samples: BiometricSample[] }> {
  const saved: BiometricSample[] = [];
  for (const chunk of chunkSamples(samples, SAMPLES_PER_SYNC_REQUEST)) {
    const res = await apiRequest<{ samples: BiometricSample[] }>(getToken, '/biometric/samples', {
      method: 'POST',
      body: JSON.stringify({ samples: chunk }),
    });
    saved.push(...res.samples);
  }
  return { samples: saved };
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
 *
 * `hrMaxSource` has been REQUIRED by the backend since N483/#833 — see this
 * file's own doc comment on the bug that went unnoticed until this
 * consolidation. Every caller today passes `'estimated'`, since
 * `hrMaxFromDateOfBirth` is the only HRmax producer in this app.
 */
export async function computeSessionMetrics(
  getToken: TokenGetter,
  sessionID: string,
  hrMaxBPM: number,
  hrMaxSource: HRMaxSource,
  hrSource: Extract<HRSource, 'workout' | 'window'>,
): Promise<SessionMetrics> {
  const res = await apiRequest<{ metrics: SessionMetrics }>(
    getToken,
    `/biometric/sessions/${sessionID}/metrics`,
    {
      method: 'POST',
      body: JSON.stringify({ hr_max_bpm: hrMaxBPM, hr_max_source: hrMaxSource, hr_source: hrSource }),
    },
  );
  return res.metrics;
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
