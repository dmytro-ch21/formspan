import { AppState, type AppStateStatus } from 'react-native';

import {
  estimateHRMaxBPM,
  selectEnrichmentCandidates,
  type EnrichmentCandidate,
  type EnrichmentLedgerEntry,
} from './biometricEnrichment';
import {
  computeSessionMetrics,
  putBiometricSamples,
  type BiometricSampleInput,
} from './biometricApi';
import { getDb } from './db';
import {
  isHealthConnectSupported,
  queryHeartRateSamples,
  queryVo2MaxReadings,
  requestHealthConnectReadAuthorization,
  sourceFromDataOrigin,
} from './healthConnect';
import { PREF_HEALTH_CONNECT_IMPORT, readPref, writePref } from './prefs';
import { getProfile } from './profile';
import type { TokenGetter } from './useAuthToken';

/**
 * Orchestrates Health Connect biometric enrichment (N478) — the settings
 * toggle, the retry ledger, and WHEN a pass runs. `lib/healthConnect.ts` is
 * the native boundary and `lib/biometricEnrichment.ts` the pure decisions;
 * this file is what decides to call them and what to do with what they
 * return. Mirrors `lib/healthkitSync.ts`'s orchestration shape deliberately
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

type LedgerRow = { session_id: string; hr_source: string; attempted_at: string };

async function readLedger(userID: string): Promise<Map<string, EnrichmentLedgerEntry>> {
  const db = await getDb();
  const rows = await db.getAllAsync<LedgerRow>(
    `SELECT session_id, hr_source, attempted_at FROM health_connect_enrichment WHERE user_id = ?`,
    userID,
  );
  const out = new Map<string, EnrichmentLedgerEntry>();
  for (const r of rows) {
    // `hr_source` is only ever written as 'window' or 'none' by
    // `recordAttempt` below — a defensive fallback rather than trusting a
    // column that could in principle hold anything.
    out.set(r.session_id, {
      hrSource: r.hr_source === 'window' ? 'window' : 'none',
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
  now: Date,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO health_connect_enrichment (user_id, session_id, hr_source, sample_count, attempted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, session_id) DO UPDATE SET
       hr_source = excluded.hr_source,
       sample_count = excluded.sample_count,
       attempted_at = excluded.attempted_at`,
    userID,
    sessionID,
    hrSource,
    sampleCount,
    now.toISOString(),
  );
}

// --- one enrichment pass -------------------------------------------------

function toHeartRateSample(
  reading: { id: string; time: string; beatsPerMinute: number; dataOrigin: string | null },
): BiometricSampleInput {
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
  const samples: BiometricSampleInput[] = readings.map((r) => ({
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
 * One enrichment pass: for every locally-known finished session worth
 * asking about (`selectEnrichmentCandidates` — never one past the 30-day
 * history wall, and never one already holding real evidence), read heart
 * rate in its exact window, upload whatever was found, and (re)compute the
 * session's metrics. Also imports recent VO2max readings as a profile trend.
 *
 * Returns the count of sessions this pass attempted (not the count that
 * found data — see `docs/testing/functional-scenarios.md`'s "permission
 * granted but no data" scenario for why a session enriched to `hr_source:
 * 'none'` is a success, not a failure, of this function). Never throws: a
 * per-session failure is caught and simply leaves that session's ledger row
 * as it was, so the next pass retries it rather than the whole pass dying
 * over one bad session.
 */
export async function syncHealthConnectBiometrics(
  userID: string,
  getToken: TokenGetter,
): Promise<{ attempted: number }> {
  if (!(await readHealthConnectImportEnabled(userID))) return { attempted: 0 };
  if (!(await isHealthConnectSupported())) return { attempted: 0 };

  await requestHealthConnectReadAuthorization();

  const now = new Date();
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
  const hrMaxBPM = estimateHRMaxBPM(dateOfBirth, now);

  let attempted = 0;
  for (const session of toEnrich) {
    try {
      // `endedAt` is guaranteed non-null here — `selectEnrichmentCandidates`
      // only keeps sessions `needsEnrichmentAttempt` already confirmed are
      // finished.
      const readings = await queryHeartRateSamples(session.startedAt, session.endedAt as string);
      if (readings.length > 0) {
        await putBiometricSamples(getToken, readings.map(toHeartRateSample));
      }

      if (hrMaxBPM != null) {
        // Always claimed as 'window' — this app does no anchor refinement
        // (design doc §2's second tier), so 'workout' is never a truthful
        // claim to make. The backend is authoritative on the RESULT: it
        // downgrades to `hr_source: 'none'` itself when it finds zero
        // heart_rate samples in the window, regardless of this claim (see
        // `ComputeSessionMetrics`'s own doc comment) — so the ledger below
        // records what the server actually decided, not what was claimed.
        const metrics = await computeSessionMetrics(getToken, session.id, hrMaxBPM, 'window');
        await recordAttempt(
          userID,
          session.id,
          metrics.hr_source === 'window' ? 'window' : 'none',
          metrics.sample_count,
          now,
        );
      } else {
        // No HRmax to compute with (no date of birth on file yet) — samples
        // are still uploaded above for whenever that changes, but there is
        // no server-confirmed 'window' result to record. Left as 'none' so
        // `needsEnrichmentAttempt`'s retry window keeps trying for a few
        // more days rather than treating a missing profile field as
        // permanent.
        await recordAttempt(userID, session.id, 'none', readings.length, now);
      }
      attempted++;
    } catch {
      // Leave this session's ledger row exactly as it was (absent, or its
      // previous attempt) — the next pass's `needsEnrichmentAttempt` will
      // decide fresh whether to retry it. One session's network failure
      // must not abort every other candidate in this pass.
    }
  }

  try {
    await importVo2Max(getToken, now);
  } catch {
    // Best-effort, same reasoning as the per-session catch above — VO2max
    // failing must never block heart-rate enrichment, and there is no
    // ledger for it to leave inconsistent.
  }

  return { attempted };
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
  void syncHealthConnectBiometrics(userID, getToken)
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
