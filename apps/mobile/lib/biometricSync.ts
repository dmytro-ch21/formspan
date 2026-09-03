import { AppState, type AppStateStatus } from 'react-native';

import {
  computeSessionMetrics,
  hrMaxFromDateOfBirth,
  planHRSync,
  putBiometricSamples,
  sessionHRWindow,
  toBiometricSample,
} from './biometric';
import { getDb } from './db';
import { isHealthKitSupported, queryHeartRateSamples, queryVO2MaxSamples } from './healthkit';
import { readHealthKitImportEnabled } from './healthkitSync';
import { getProfile } from './profile';
import { PREF_VO2MAX_LAST_SYNCED_AT, readPref, writePref } from './prefs';
import { sessionsNeedingBiometricSync } from './sessionStore';
import type { TokenGetter } from './useAuthToken';

/**
 * Orchestrates the biometric enrichment pass (N477/#822) — reading a
 * finished session's heart-rate window and the athlete's VO₂max trend from
 * HealthKit and handing both to `backend/internal/modules/biometric`
 * (N476/#821).
 *
 * ## Why this is its own module, and its own orchestrator, and not a third
 * copy of either sibling's shape
 *
 * `lib/healthkitSync.ts`'s doc comment argues for keeping the running-import
 * orchestrator separate from `lib/sync.ts`'s outbox: "none of that applies
 * here — a HealthKit import pass never fails on a bad connection... until
 * the very end, where it merely calls requestSync". THIS module is the
 * mirror image of that argument, which is why it is not folded into
 * `healthkitSync.ts` either: every write here (`putBiometricSamples`,
 * `computeSessionMetrics`) is a live network call from the very first step,
 * with no local staging table upstream of it — there is nothing analogous
 * to `startLocalSession`'s durable local row for this feature to write
 * first. So it takes `lib/sync.ts`'s shape instead (a module-level identity
 * carrying a `TokenGetter`, same as `creds` there) while keeping
 * `lib/healthkitSync.ts`'s TRIGGER shape (foreground/launch, no
 * retry/backoff ladder — see below for why none is needed). Three
 * orchestrators, three different failure modes, each module owning exactly
 * the machinery its own failure mode needs.
 *
 * ## Why no retry/backoff ladder
 *
 * Design doc §6.4: "Enrichment is not blocking. A session syncs when it
 * syncs; its metrics arrive later, possibly much later." A failed pass
 * (offline, a transient 5xx) simply leaves the session's ledger row unwritten
 * — see `syncSessionWindows` below — so the NEXT foreground return tries again from
 * scratch. That is a correct, sufficient retry policy for something with no
 * user-visible latency budget, and building `lib/sync.ts`'s exponential
 * ladder for it would be teaching this module a failure mode (a mutation the
 * athlete is waiting to see confirmed) it does not have.
 *
 * ## Platform-agnostic core, iOS-specific glue
 *
 * Everything this file imports from `./biometric` (the window join, the
 * upload plan, the HRmax seed, the API client) is platform-agnostic — see
 * that file's own doc comment. The only iOS-specific calls in this whole
 * module are `queryHeartRateSamples`/`queryVO2MaxSamples`/`isHealthKitSupported`
 * from `./healthkit`, which the Android sibling ticket (#823) would swap for
 * its own Health Connect equivalents without touching anything below this
 * comment.
 */

// --- identity, mirroring lib/sync.ts's `creds` shape ----------------------

let creds: { userID: string; getToken: TokenGetter } | null = null;
let running = false;

/**
 * Who to sync as, and how to authenticate. Set from `app/_layout.tsx`
 * alongside `setSyncIdentity`/`setHealthKitSyncIdentity`, cleared on
 * sign-out for the identical reason those are: a queued foreground trigger
 * firing after sign-out must not push HealthKit data under the NEXT
 * athlete's token on a shared device.
 */
export function setBiometricSyncIdentity(userID: string | null, getToken: TokenGetter | null): void {
  if (!userID || !getToken) {
    creds = null;
    return;
  }
  creds = { userID, getToken };
  runPass('sign-in');
}

/**
 * Trigger a pass right now, respecting the SAME `running` mutex the
 * foreground/launch orchestrator uses — the identical reasoning as
 * `lib/healthkitSync.ts`'s `triggerHealthKitImportNow`: calling the raw pass
 * function directly would let the Settings toggle race a pass already
 * mid-flight from sign-in or a foreground return. The Settings screen calls
 * this, never a raw internal function, when the athlete turns the shared
 * HealthKit toggle on.
 */
export function triggerBiometricSyncNow(userID: string, getToken: TokenGetter): void {
  creds = { userID, getToken };
  runPass('settings-toggle');
}

/** Bounds one pass's session backfill — see `sessionsNeedingBiometricSync`.
 *  Generous rather than tight: a device catching up on a long backlog costs
 *  one extra foreground pass per multiple of this, never a stall, since a
 *  partial pass still advances the ledger for whatever it did process. */
const MAX_SESSIONS_PER_PASS = 20;

/** First-run VO₂max backfill window, when this device has never synced one
 *  before. Bounded rather than the full 400-day list-endpoint ceiling
 *  (`contracts/public.openapi.yaml`'s `maxListRangeDays`) — VO₂max is a
 *  daily-ish device estimate (design doc §3), so ninety days is already a
 *  generous first trend to show, and every later pass advances the
 *  high-water mark from wherever this one left off rather than re-asking
 *  every time. */
const VO2MAX_BACKFILL_DAYS = 90;

function runPass(reason: string): void {
  if (!creds || running) return;
  const { userID, getToken } = creds;
  running = true;
  void syncBiometricEnrichment(userID, getToken)
    .catch(() => {
      // Nothing here is the athlete's to fix, and nothing here should
      // interrupt anything else — see this file's doc comment on why no
      // retry ladder is needed: the next foreground pass tries again.
    })
    .finally(() => {
      running = false;
    });
  void reason; // kept for parity with the sibling orchestrators' call sites; not logged.
}

/**
 * One full pass: session heart-rate windows, then the VO₂max trend.
 * Exported (unlike `runPass`) for the same reason `importHealthKitRuns` is
 * in `lib/healthkitSync.ts` — a test drives this directly, bypassing the
 * mutex, so it can assert on a single awaitable pass rather than polling for
 * a fire-and-forget one. `runPass` above is the only sanctioned way to
 * trigger this from app code — see `triggerBiometricSyncNow`'s doc comment.
 */
export async function syncBiometricEnrichment(userID: string, getToken: TokenGetter): Promise<void> {
  if (!isHealthKitSupported()) return;
  if (!(await readHealthKitImportEnabled(userID))) return;

  // Independent chains, same reasoning as `app/(tabs)/you.tsx`'s focus
  // effect: a slow or failing VO₂max read must not block session
  // enrichment, and vice versa.
  await Promise.allSettled([syncSessionWindows(userID, getToken), syncVO2Max(userID, getToken)]);
}

// --- session heart-rate windows (design doc §2) ---------------------------

async function syncSessionWindows(userID: string, getToken: TokenGetter): Promise<void> {
  const pending = await sessionsNeedingBiometricSync(userID, MAX_SESSIONS_PER_PASS);
  if (pending.length === 0) return;

  // Fetched once per pass, not once per session — a session's own HRmax
  // seed (design doc §3) is a fact about the ATHLETE, not about any one
  // session. `null` — no date of birth, or a seed outside the range
  // ComputeMetrics accepts — means this pass computes NOTHING: see
  // `hrMaxFromDateOfBirth`'s doc comment for why leaving `session_metrics`
  // uncomputed is the honest answer rather than guessing an HRmax.
  let hrMaxBPM: number | null = null;
  try {
    const profile = await getProfile(getToken);
    hrMaxBPM = hrMaxFromDateOfBirth(profile.date_of_birth, new Date());
  } catch {
    // Offline, or no profile yet — same "nothing here is computable this
    // pass" outcome as a missing date of birth.
  }
  if (hrMaxBPM == null) return;

  for (const session of pending) {
    const window = sessionHRWindow(session.started_at, session.ended_at);
    if (!window) continue; // should not happen — the query already filters on ended_at set.

    const raw = await queryHeartRateSamples(window.start, window.end);
    const samples = raw.map((s) => toBiometricSample(s, 'heart_rate', 'healthkit'));
    const plan = planHRSync(samples);

    try {
      if (plan.kind === 'upload-and-compute') {
        await putBiometricSamples(getToken, plan.samples);
      }
      await computeSessionMetrics(getToken, session.id, hrMaxBPM, plan.hrSource);
    } catch {
      // Leave this session's ledger row unwritten so the next pass retries
      // it — see this file's doc comment on why no backoff ladder is
      // needed. Continue to the next session rather than aborting the
      // whole batch on one failure.
      continue;
    }
    await recordBiometricHRSync(userID, session.id);
  }
}

async function recordBiometricHRSync(userID: string, sessionID: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO biometric_hr_synced (user_id, session_id, synced_at) VALUES (?, ?, ?)`,
    userID,
    sessionID,
    new Date().toISOString(),
  );
}

// --- VO2max profile trend (design doc §3) ---------------------------------

async function syncVO2Max(userID: string, getToken: TokenGetter): Promise<void> {
  const lastSyncedAt = await readPref(userID, PREF_VO2MAX_LAST_SYNCED_AT);
  const since = lastSyncedAt
    ? new Date(lastSyncedAt)
    : new Date(Date.now() - VO2MAX_BACKFILL_DAYS * 24 * 60 * 60 * 1000);

  const raw = await queryVO2MaxSamples(since);
  if (raw.length === 0) return;

  const samples = raw.map((s) => toBiometricSample(s, 'vo2_max', 'healthkit'));
  await putBiometricSamples(getToken, samples);

  // The high-water mark advances to the NEWEST sample actually offered —
  // reading `measured_at` back off what was just uploaded (rather than
  // `new Date()`) means a device clock running ahead of HealthKit's own
  // timestamps can never skip a genuine reading that landed between "now"
  // and the query's true cutoff.
  const latest = samples.reduce((max, s) => (s.measured_at > max ? s.measured_at : max), samples[0].measured_at);
  await writePref(userID, PREF_VO2MAX_LAST_SYNCED_AT, latest);
}

// --- foreground/launch trigger, mirroring lib/healthkitSync.ts's shape ---

let appStateSub: { remove: () => void } | null = null;

/**
 * Runs a pass on every return to the foreground — the identical trigger
 * shape as `lib/healthkitSync.ts`'s `startHealthKitImportOrchestrator` (see
 * that file's own doc comment for why foreground/launch rather than
 * background delivery). Registered once for the process, in
 * `app/_layout.tsx`.
 */
export function startBiometricSyncOrchestrator(): () => void {
  appStateSub?.remove();
  let previous: AppStateStatus = AppState.currentState;
  appStateSub = AppState.addEventListener('change', (next) => {
    const wasAway = previous === 'background' || previous === 'inactive';
    const returned = wasAway && next === 'active';
    previous = next;
    if (!returned) return;
    runPass('foreground');
  });
  return () => {
    appStateSub?.remove();
    appStateSub = null;
  };
}
