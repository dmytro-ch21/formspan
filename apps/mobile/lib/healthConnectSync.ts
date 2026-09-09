import { AppState, type AppStateStatus } from 'react-native';

import {
  computeSessionMetrics,
  coverageFromLedger,
  hrMaxFromDateOfBirth,
  hrSampleCoverage,
  putBiometricSamples,
  selectEnrichmentCandidates,
  type BiometricSample,
  type EnrichmentCandidate,
  type EnrichmentLedgerEntry,
  type HRCoverage,
} from './biometric';
import { getDb } from './db';
import { upsertDetectedActivities, DETECTED_ACTIVITY_WINDOW_DAYS } from './detectedActivity';
import {
  isHealthConnectSupported,
  HealthConnectPermissionError,
  type HealthConnectRecordType,
  queryExerciseSessionWindows,
  queryHeartRateSamples,
  queryOtherExerciseSessions,
  queryVo2MaxReadings,
  requestHealthConnectReadAuthorization,
  sourceFromDataOrigin,
  type HeartRateReading,
} from './healthConnect';
import type { EnrichableSession, SyncNowOutcome } from './hrAbsence';
import { fitHRWindow } from './hrWindowFit';
import { paddedHRSearchWindow, selectWorkoutWindow, workoutSearchWindow } from './hrWorkoutWindow';
import { PREF_HEALTH_CONNECT_IMPORT, readPref, writePref } from './prefs';
import { getProfile } from './profile';
import type { TokenGetter } from './useAuthToken';

/**
 * Orchestrates Health Connect biometric enrichment (N478) — the settings
 * toggle, the retry ledger, and WHEN a pass runs. `lib/healthConnect.ts` is
 * the native boundary and `lib/biometric.ts` the pure decisions (formerly
 * `lib/biometricEnrichment.ts` + `lib/biometricApi.ts`, consolidated with
 * the iOS side's own copy of the same logic by N485/#837); this file is what
 * decides to call them and what to do with what they return. Mirrors
 * `lib/healthkitSync.ts`'s orchestration shape deliberately
 * (module-level identity set once from `app/_layout.tsx`, an `AppState`
 * listener registered once for the process, a mutex-guarded trigger run on
 * sign-in and every foreground return) — see that file's doc comment for why
 * this is its own separate orchestrator rather than folding into
 * `lib/sync.ts`.
 *
 * **Unlike `healthkitSync.ts`, this orchestrator needs a `TokenGetter`.**
 * A HealthKit import pass never talks to the network — it only writes local
 * SQLite sessions, and the ordinary outbox pushes them later. This one
 * PUSHES DIRECTLY: heart-rate samples and computed session metrics go
 * straight to `/v1/biometric/*` (design doc §6.4, "pull-then-push") rather
 * than through the offline outbox, because there is no local biometric
 * table to enqueue from — the raw samples live only in Health Connect and
 * on the server, never in this app's own SQLite. An offline pass therefore
 * genuinely fails rather than "succeeding locally" the way a HealthKit
 * import does; the next foreground return with connectivity tries again,
 * same as any other network call in this app.
 *
 * **N479/#824 rides the same pass**, and unlike the heart-rate half above IS
 * local-only — `detectOtherHealthConnectActivity` below writes to the
 * `detected_activities` ledger, never the network, so it "succeeds locally"
 * offline exactly the way `healthkitSync.ts`'s running import does. Added to
 * this existing trigger rather than a new orchestrator, per the ticket's own
 * instruction to respect the pattern already established here.
 */

/** Whether this device has Health Connect biometric reading turned on. Off
 *  by default. */
export async function readHealthConnectImportEnabled(userID: string): Promise<boolean> {
  return (await readPref(userID, PREF_HEALTH_CONNECT_IMPORT)) === '1';
}

/**
 * Turn reading on or off for this device. Turning it OFF does not delete
 * anything already uploaded — same "a setting must not make data disappear"
 * stance `healthkitSync.ts`'s equivalent takes — it only stops the next
 * foreground/launch pass from asking Health Connect for more.
 */
export function writeHealthConnectImportEnabled(userID: string, on: boolean): Promise<void> {
  return writePref(userID, PREF_HEALTH_CONNECT_IMPORT, on ? '1' : '0');
}

// --- candidates and the local retry ledger ------------------------------

/** How far back a session may start and still be worth asking about at
 *  all — the Health Connect history wall (§5.2) plus no buffer, because
 *  `isWithinHealthConnectHistoryWall` re-checks this exactly at query time
 *  and a session that only just crossed the wall between this query and
 *  that check is correctly dropped there instead. Bounding the SQL query
 *  itself is purely so a years-old account doesn't pull its entire session
 *  history into memory on every foreground return. */
const CANDIDATE_LOOKBACK_DAYS = 30;

type SessionRow = { id: string; started_at: string; ended_at: string | null };

async function candidateSessions(userID: string, now: Date): Promise<EnrichmentCandidate[]> {
  const db = await getDb();
  const sinceISO = new Date(now.getTime() - CANDIDATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.getAllAsync<SessionRow>(
    `SELECT id, started_at, ended_at FROM local_sessions
     WHERE user_id = ? AND remote = 1 AND ended_at IS NOT NULL
       AND deleted_at IS NULL AND started_at >= ?
     ORDER BY started_at DESC`,
    userID,
    sinceISO,
  );
  return rows.map((r) => ({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at }));
}

type LedgerRow = { session_id: string; hr_source: string; attempted_at: string; coverage: string | null };

async function readLedger(userID: string): Promise<Map<string, EnrichmentLedgerEntry>> {
  const db = await getDb();
  const rows = await db.getAllAsync<LedgerRow>(
    `SELECT session_id, hr_source, attempted_at, coverage FROM health_connect_enrichment WHERE user_id = ?`,
    userID,
  );
  const out = new Map<string, EnrichmentLedgerEntry>();
  for (const r of rows) {
    // `hr_source` is only ever written as 'window' or 'none' by
    // `recordAttempt` below — a defensive fallback rather than trusting a
    // column that could in principle hold anything.
    out.set(r.session_id, {
      hrSource: r.hr_source === 'window' ? 'window' : 'none',
      // W19/#985 — 'unknown' for a pre-W19 row, which retries rather than
      // reading as final. See `lib/biometric.ts`'s `hrSampleCoverage`.
      coverage: coverageFromLedger(r.coverage),
      attemptedAt: r.attempted_at,
    });
  }
  return out;
}

async function recordAttempt(
  userID: string,
  sessionID: string,
  hrSource: 'window' | 'none',
  sampleCount: number,
  coverage: Exclude<HRCoverage, 'unknown'>,
  now: Date,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO health_connect_enrichment (user_id, session_id, hr_source, sample_count, attempted_at, coverage)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, session_id) DO UPDATE SET
       hr_source = excluded.hr_source,
       sample_count = excluded.sample_count,
       attempted_at = excluded.attempted_at,
       coverage = excluded.coverage`,
    userID,
    sessionID,
    hrSource,
    sampleCount,
    now.toISOString(),
    coverage,
  );
}

// --- one enrichment pass -------------------------------------------------

function toHeartRateSample(
  reading: { id: string; time: string; beatsPerMinute: number; dataOrigin: string | null },
): BiometricSample {
  return {
    id: reading.id,
    metric_type: 'heart_rate',
    source: sourceFromDataOrigin(reading.dataOrigin),
    source_platform: 'health_connect',
    value: reading.beatsPerMinute,
    unit: 'bpm',
    measured_at: reading.time,
  };
}

/** VO2max is a profile-level trend (design doc §3), never attached to a
 *  session — read once per pass over a fixed recent window rather than
 *  per-session, capped at the same history wall a session-window read is.
 *  Re-uploads the same window's readings every pass rather than tracking an
 *  incremental anchor: deliberately simple for this ticket's scope, and
 *  harmless because `vo2MaxSampleID` is deterministic and the backend's
 *  `PutSamples` is idempotent on it — see that function's doc comment. */
async function importVo2Max(getToken: TokenGetter, now: Date): Promise<void> {
  const sinceISO = new Date(now.getTime() - CANDIDATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const readings = await queryVo2MaxReadings(sinceISO, now.toISOString());
  if (readings.length === 0) return;
  const samples: BiometricSample[] = readings.map((r) => ({
    id: r.id,
    metric_type: 'vo2_max',
    source: sourceFromDataOrigin(r.dataOrigin),
    source_platform: 'health_connect',
    value: r.vo2MillilitersPerMinuteKilogram,
    unit: 'ml/kg/min',
    measured_at: r.time,
  }));
  await putBiometricSamples(getToken, samples);
}

/**
 * N479/#824: record other Health Connect-noticed activity (a walk, a hike)
 * with no matching VOLA session, for Today's own "detected but not logged"
 * card — the Android counterpart to `healthkitSync.ts`'s
 * `detectOtherHealthKitActivity`. Never creates a session itself; see that
 * function's own doc comment for why. Uses the SAME toggle as heart-rate
 * enrichment (`ExerciseSession` joined `READ_RECORD_TYPES` in
 * `lib/healthConnect.ts`) rather than a new one, for the identical
 * one-consent-screen reasoning.
 */
async function detectOtherHealthConnectActivity(userID: string, now: Date): Promise<void> {
  const sinceISO = new Date(
    now.getTime() - DETECTED_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const sessions = await queryOtherExerciseSessions(sinceISO, now.toISOString());
  if (sessions.length === 0) return;
  await upsertDetectedActivities(
    userID,
    'health_connect',
    sessions.map((s) => ({
      id: s.id,
      type: s.type,
      startDate: s.startDate,
      endDate: s.endDate,
      durationSeconds: s.durationSeconds,
      // Health Connect distance is a separate record this ticket's scope
      // does not join — see `queryOtherExerciseSessions`'s own doc comment.
      distanceMeters: null,
    })),
  );
}

/**
 * One enrichment pass: for every locally-known finished session worth
 * asking about (`selectEnrichmentCandidates` — never one past the 30-day
 * history wall, and never one already holding real evidence), read heart
 * rate in its exact window, upload whatever was found, and (re)compute the
 * session's metrics. Also imports recent VO2max readings as a profile trend.
 *
 * Returns the count of sessions this pass attempted (not the count that
 * found data — see `docs/testing/functional-scenarios.md`'s "permission
 * granted but no data" scenario for why a session enriched to `hr_source:
 * 'none'` is a success, not a failure, of this function), and
 * `notPermitted`: every record type Health Connect REFUSED to read this
 * pass (W15/#944). Never throws: a per-session failure is caught and
 * simply leaves that session's ledger row as it was, so the next pass
 * retries it rather than the whole pass dying over one bad session.
 *
 * `notPermitted` exists because the alternative was the bug. A refused read
 * used to come back as `[]` from `lib/healthConnect.ts`, and this function
 * then correctly did nothing with nothing — so a permission missing from
 * the manifest was a feature that silently never ran, behind a Settings
 * toggle that said it did. A refusal is still not allowed to fail the pass
 * (heart-rate enrichment must survive a refused VO2max, and vice versa) —
 * it is CAUGHT, but it is caught into this list rather than into silence,
 * so the answer to "is walk detection actually working on this phone" is
 * one value rather than a debugger session. Nothing in the UI reads it yet;
 * that is a separate ticket, and a value that exists is what makes that
 * ticket small.
 */
export async function syncHealthConnectBiometrics(
  userID: string,
  getToken: TokenGetter,
  options: {
    /**
     * Whether `userID`/`getToken` are still the CURRENT identity, checked
     * after every await in the loop below. Defaults to always-true, which
     * is what every direct call in this file's own test suite gets — this
     * function has no orchestration state of its own to check identity
     * against, so a caller with none (a test, most concretely) is not
     * penalised for not supplying one.
     *
     * The real check comes from `runSyncPass` below, which passes a closure
     * comparing against the module-level `creds` this function otherwise
     * knows nothing about. See its own doc comment for why this exists:
     * unlike a finished session's `session_id`-scoped writes (which the
     * backend's own ownership check on `ComputeSessionMetrics` backstops —
     * see biometric.go), a raw `putBiometricSamples` call carries no such
     * check. If the athlete signs out mid-pass and a DIFFERENT athlete
     * signs in on the same device before an in-flight `await` resolves,
     * this app's own `getToken` wrapper (see `useAuthToken.ts`) would
     * authenticate the REST call as the NEW athlete while this loop is
     * still reasoning about the OLD one's local ledger — writing samples
     * that are really the old athlete's Health Connect history under the
     * new athlete's account. Rare (both events have to land inside one
     * await), but real, since PutSamples has no resource to check ownership
     * against the way ComputeSessionMetrics does.
     */
    stillCurrent?: () => boolean;
  } = {},
): Promise<{ attempted: number; notPermitted: HealthConnectRecordType[] }> {
  const stillCurrent = options.stillCurrent ?? (() => true);

  if (!(await readHealthConnectImportEnabled(userID))) return { attempted: 0, notPermitted: [] };
  if (!(await isHealthConnectSupported())) return { attempted: 0, notPermitted: [] };

  // Result deliberately discarded — see this function's own doc comment in
  // `lib/healthConnect.ts` (W15/#944): the read site is where a refused
  // grant is actually detected, and `notPermitted` below is how it reports.
  await requestHealthConnectReadAuthorization();

  const notPermitted: HealthConnectRecordType[] = [];
  /** Records a refusal and says whether `err` was one. Everything else
   *  stays the silent, retry-next-pass failure every catch below already was. */
  const noteIfRefused = (err: unknown): boolean => {
    if (!(err instanceof HealthConnectPermissionError)) return false;
    if (!notPermitted.includes(err.recordType)) notPermitted.push(err.recordType);
    if (__DEV__) {
      console.warn(
        `healthConnectSync: ${err.recordType} read refused — permission missing from app.config.js, or revoked in Health Connect?`,
        err,
      );
    }
    return true;
  };

  const now = new Date();

  // N479/#824: best-effort, never allowed to fail the heart-rate enrichment
  // this function exists for — same posture as every other catch in this
  // file's loop below.
  try {
    await detectOtherHealthConnectActivity(userID, now);
  } catch (err) {
    // A refused grant is recorded; anything else, the next foreground pass
    // tries again.
    noteIfRefused(err);
  }

  const [candidates, ledger] = await Promise.all([candidateSessions(userID, now), readLedger(userID)]);
  const toEnrich = selectEnrichmentCandidates(candidates, ledger, now);

  let dateOfBirth: string | null = null;
  try {
    dateOfBirth = (await getProfile(getToken)).date_of_birth;
  } catch {
    // Offline, or any other transient failure reading the profile — HRmax
    // stays unavailable for THIS pass only; nothing here remembers a
    // negative result, so the next foreground return tries again.
  }
  const hrMaxBPM = hrMaxFromDateOfBirth(dateOfBirth, now);

  let attempted = 0;
  for (const session of toEnrich) {
    // Checked at the TOP of every iteration, before this session's own
    // Health Connect read or network call — see `stillCurrent`'s own doc
    // comment. A `break` rather than `continue`: once the identity has
    // moved on, nothing later in `toEnrich` should run under it either.
    if (!stillCurrent()) break;
    try {
      await enrichHealthConnectSession(userID, getToken, session, hrMaxBPM, now);
      attempted++;
    } catch (err) {
      // Leave this session's ledger row exactly as it was (absent, or its
      // previous attempt) — the next pass's `needsEnrichmentAttempt` will
      // decide fresh whether to retry it. One session's network failure
      // must not abort every other candidate in this pass.
      //
      // A refused HeartRate grant is the one failure that IS the same for
      // every remaining session, so it ends the loop rather than repeating
      // the refusal once per candidate; the ledger is left untouched for all
      // of them exactly as above, so a later grant picks them all up.
      if (noteIfRefused(err)) break;
    }
  }

  // Same identity re-check as the loop above, immediately before the one
  // remaining network call this pass makes — VO2max is uploaded under
  // `getToken`, which would otherwise authenticate as whoever is signed in
  // NOW rather than whoever this pass started as.
  if (stillCurrent()) {
    try {
      await importVo2Max(getToken, now);
    } catch (err) {
      // Best-effort, same reasoning as the per-session catch above — VO2max
      // failing must never block heart-rate enrichment, and there is no
      // ledger for it to leave inconsistent. A refused grant is recorded.
      noteIfRefused(err);
    }
  }

  return { attempted, notPermitted };
}

/**
 * ONE session's enrichment attempt, Health Connect read to ledger row — the
 * body `syncHealthConnectBiometrics` runs per candidate, carved out
 * (W18/#957) so the session screen's "Sync heart rate"
 * (`enrichHealthConnectSessionNow` below) runs exactly the same attempt for
 * exactly one session, cooldown or not. Throws when the read, upload or
 * compute fails — nothing is recorded then. `hrMaxBPM` may be null (no date
 * of birth yet): samples are still uploaded and the attempt recorded as
 * `'none'`, exactly as the pass always did, so the retry window keeps
 * trying rather than treating a missing profile field as permanent.
 */
async function enrichHealthConnectSession(
  userID: string,
  getToken: TokenGetter,
  session: EnrichmentCandidate,
  hrMaxBPM: number | null,
  now: Date,
): Promise<{ hrSource: 'window' | 'none'; sampleCount: number }> {
  // `endedAt` is guaranteed non-null here — `selectEnrichmentCandidates`
  // only keeps sessions `needsEnrichmentAttempt` already confirmed are
  // finished, and `enrichHealthConnectSessionNow` guards for it itself.
  const { readings, windowOverride, coverage } = await readSessionHR(
    session.startedAt,
    session.endedAt as string,
  );
  if (readings.length > 0) {
    await putBiometricSamples(getToken, readings.map(toHeartRateSample));
  }

  if (hrMaxBPM == null) {
    // No HRmax to compute with (no date of birth on file yet) — samples
    // are still uploaded above for whenever that changes, but there is
    // no server-confirmed 'window' result to record.
    await recordAttempt(userID, session.id, 'none', readings.length, coverage, now);
    return { hrSource: 'none', sampleCount: readings.length };
  }

  // Always claimed as 'window' — this app does no anchor refinement
  // (design doc §2's second tier), so 'workout' is never a truthful
  // claim to make. The backend is authoritative on the RESULT: it
  // downgrades to `hr_source: 'none'` itself when it finds zero
  // heart_rate samples in the window, regardless of this claim (see
  // `ComputeSessionMetrics`'s own doc comment) — so the ledger below
  // records what the server actually decided, not what was claimed.
  // 'estimated' — hrMaxBPM above only ever comes from
  // hrMaxFromDateOfBirth (the 220 - age seed); see biometric.ts's
  // HRMaxSource doc comment for why nothing in this app produces
  // 'observed' yet.
  const metrics = await computeSessionMetrics(
    getToken,
    session.id,
    hrMaxBPM,
    'estimated',
    'window',
    windowOverride,
  );
  const hrSource = metrics.hr_source === 'window' ? 'window' : 'none';
  await recordAttempt(userID, session.id, hrSource, metrics.sample_count, coverage, now);
  return { hrSource, sampleCount: metrics.sample_count };
}

/**
 * W19/#985 — the Android twin of `lib/biometricSync.ts`'s `readSessionHR`,
 * and deliberately the same three steps in the same order: the athlete's
 * data should not be read from a different window depending on which phone
 * they own. Read that function's doc comment for the reasoning; this one
 * records only what differs.
 *
 * **What differs is one step, and it is a pre-existing asymmetry rather
 * than a new one**: N522/#934's dated-day search never shipped on Android,
 * so this has the workout window (step 1), the session's own window
 * (step 2) and the ±20-minute padded fit (step 3), but not the fourth
 * dated-day fallback. Health Connect's own 30-day history wall
 * (`isWithinHealthConnectHistoryWall`) already bounds what Android can look
 * at more tightly than iOS, and widening the fallback further is a separate
 * decision with its own cost, not something to fold into this one silently.
 *
 * The workout read is `ExerciseSession`, already granted since N479/#824.
 * A REFUSED grant throws out of `queryExerciseSessionWindows` rather than
 * reading as "no workout" (W15/#944) — deliberately not caught here, so it
 * reaches `syncHealthConnectBiometrics`'s `noteIfRefused` and is reported,
 * exactly like a refused HeartRate read.
 */
async function readSessionHR(
  startedAt: string,
  endedAt: string,
): Promise<{
  readings: HeartRateReading[];
  windowOverride: { start: string; end: string } | null;
  coverage: Exclude<HRCoverage, 'unknown'>;
}> {
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  const durationMs = endMs - startMs;
  const coverageOf = (w: { start: string; end: string }, samples: readonly HeartRateReading[]) =>
    hrSampleCoverage(w.start, w.end, samples.map((r) => r.time));

  // 1. the watch's own exercise session
  const search = workoutSearchWindow(startedAt, endedAt);
  const workout = selectWorkoutWindow(
    startedAt,
    endedAt,
    await queryExerciseSessionWindows(search.start.toISOString(), search.end.toISOString()),
  );
  if (workout) {
    const workoutReadings = await queryHeartRateSamples(workout.start, workout.end);
    if (workoutReadings.length > 0) {
      return {
        readings: workoutReadings,
        windowOverride: workout,
        coverage: coverageOf(workout, workoutReadings),
      };
    }
  }

  // 2. the session's own logged window
  const anchor = { start: startedAt, end: endedAt };
  const exact = await queryHeartRateSamples(startedAt, endedAt);
  const exactCoverage = coverageOf(anchor, exact);
  if (exact.length > 0 && exactCoverage === 'plausible') {
    return { readings: exact, windowOverride: null, coverage: exactCoverage };
  }

  // 3. a ±20-minute padded search, FIT — never averaged
  if (durationMs > 0) {
    const padded = paddedHRSearchWindow(startedAt, endedAt);
    const searched = await queryHeartRateSamples(padded.start.toISOString(), padded.end.toISOString());
    const fit = fitHRWindow(
      searched.map((r) => ({ measuredAt: r.time, bpm: r.beatsPerMinute })),
      durationMs,
      anchor,
    );
    if (fit) {
      const fitStartMs = new Date(fit.start).getTime();
      const fitEndMs = new Date(fit.end).getTime();
      const fitted = searched.filter((r) => {
        const t = new Date(r.time).getTime();
        return t >= fitStartMs && t <= fitEndMs;
      });
      const fitCoverage = fitted.length > 0 ? coverageOf(fit, fitted) : 'thin';
      if (fitted.length > 0 && fitCoverage === 'plausible') {
        return {
          readings: fitted,
          windowOverride: { start: fit.start, end: fit.end },
          coverage: fitCoverage,
        };
      }
    }
  }

  return { readings: exact, windowOverride: null, coverage: exactCoverage };
}

/**
 * W18/#957 — Health Connect twin of `lib/biometricSync.ts`'s
 * `enrichSessionNow`, same contract: one attempt for this session, now,
 * cadence and window ignored, never throws. The session comes from the
 * caller in the screen's own `started_at`/`ended_at` shape.
 */
export async function enrichHealthConnectSessionNow(
  userID: string,
  getToken: TokenGetter,
  session: EnrichableSession,
): Promise<SyncNowOutcome> {
  if (!(await isHealthConnectSupported())) return { status: 'sync_off' };
  if (!(await readHealthConnectImportEnabled(userID))) return { status: 'sync_off' };
  if (!session.ended_at) return { status: 'error' };

  const now = new Date();
  let dateOfBirth: string | null = null;
  try {
    dateOfBirth = (await getProfile(getToken)).date_of_birth;
  } catch {
    return { status: 'error' };
  }
  const hrMaxBPM = hrMaxFromDateOfBirth(dateOfBirth, now);

  try {
    const result = await enrichHealthConnectSession(
      userID,
      getToken,
      { id: session.id, startedAt: session.started_at, endedAt: session.ended_at },
      hrMaxBPM,
      now,
    );
    // Samples (if any) are uploaded either way; the honest sentence when
    // there is no HRmax is about the profile, not about the watch.
    if (hrMaxBPM == null) return { status: 'no_hrmax' };
    return result.hrSource === 'window'
      ? { status: 'found', sampleCount: result.sampleCount }
      : { status: 'none' };
  } catch {
    return { status: 'error' };
  }
}

// --- orchestration: when a pass runs -------------------------------------

let creds: { userID: string; getToken: TokenGetter } | null = null;
let running = false;

/**
 * Who to sync as, and how to authenticate. Cleared on sign-out for the
 * identical reason `lib/sync.ts`'s `setSyncIdentity` is: a queued
 * foreground trigger firing after sign-out must not enrich sessions, or
 * spend the PREVIOUS athlete's API calls, under the NEXT athlete's identity
 * on a shared device.
 */
export function setHealthConnectSyncIdentity(userID: string | null, getToken: TokenGetter | null): void {
  creds = userID && getToken ? { userID, getToken } : null;
  if (creds) runSyncPass('sign-in');
}

/**
 * Trigger a pass right now, respecting the SAME `running` mutex the
 * foreground/launch orchestrator uses — the Settings toggle calls this,
 * never `syncHealthConnectBiometrics` directly, for the identical reason
 * `healthkitSync.ts`'s `triggerHealthKitImportNow` gives: bypassing the
 * mutex risks two concurrent passes both deciding to enrich the same
 * session before either has recorded its ledger row.
 */
export function triggerHealthConnectSyncNow(userID: string, getToken: TokenGetter): void {
  creds = { userID, getToken };
  runSyncPass('settings-toggle');
}

function runSyncPass(reason: string): void {
  if (!creds || running) return;
  const { userID, getToken } = creds;
  running = true;
  // See `syncHealthConnectBiometrics`'s `stillCurrent` doc comment — this is
  // the real check, comparing against `creds` as it stands at the moment
  // each await resolves, not as it stood when this pass started.
  void syncHealthConnectBiometrics(userID, getToken, { stillCurrent: () => creds?.userID === userID })
    .catch(() => {
      // See syncHealthConnectBiometrics's own doc comment: nothing here is
      // the athlete's to fix, and nothing here should interrupt anything
      // else — the next foreground/launch tries again on its own.
    })
    .finally(() => {
      running = false;
    });
  void reason; // kept for parity with lib/sync.ts/healthkitSync.ts call sites; not logged.
}

let appStateSub: { remove: () => void } | null = null;

/**
 * Runs a pass on every return to the foreground, mirroring
 * `lib/healthkitSync.ts`'s `startHealthKitImportOrchestrator`. Registered
 * once for the process, in `app/_layout.tsx`, not per screen.
 */
export function startHealthConnectSyncOrchestrator(): () => void {
  appStateSub?.remove();
  let previous: AppStateStatus = AppState.currentState;
  appStateSub = AppState.addEventListener('change', (next) => {
    const wasAway = previous === 'background' || previous === 'inactive';
    const returned = wasAway && next === 'active';
    previous = next;
    if (!returned) return;
    runSyncPass('foreground');
  });
  return () => {
    appStateSub?.remove();
    appStateSub = null;
  };
}
