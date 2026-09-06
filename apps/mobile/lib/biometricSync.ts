import { AppState, type AppStateStatus } from 'react-native';

import {
  computeSessionMetrics,
  hrMaxFromDateOfBirth,
  needsEnrichmentAttempt,
  planHRSync,
  putBiometricSamples,
  sessionHRWindow,
  toBiometricSample,
  type EnrichmentLedgerEntry,
} from './biometric';
import { getDb } from './db';
import { isHealthKitSupported, queryHeartRateSamples, queryVO2MaxSamples } from './healthkit';
import { readHealthKitImportEnabled } from './healthkitSync';
import { getProfile } from './profile';
import {
  PREF_BIOMETRIC_SYNC_FAILURE_COUNT,
  PREF_VO2MAX_LAST_SYNCED_AT,
  readPref,
  writePref,
} from './prefs';
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
 * upload plan, the HRmax seed, the API client, and — since N511/#893 — the
 * retry-with-cooldown ledger decision) is platform-agnostic — see that
 * file's own doc comment. The only iOS-specific calls in this whole module
 * are `queryHeartRateSamples`/`queryVO2MaxSamples`/`isHealthKitSupported`
 * from `./healthkit`. The Android sibling (`lib/healthConnectSync.ts`, N478)
 * turned out different enough in orchestration shape — an extra N479
 * activity-detection pass riding the same trigger, a different local table
 * for the ledger row (`health_connect_enrichment` vs. this file's
 * `biometric_hr_synced`, same shape as of N511) — that it stayed its own
 * module rather than becoming this file with `./healthkit` swapped for
 * `./healthConnect`; N485/#837 consolidated the two orchestrators' SHARED
 * dependency (`./biometric`, this file's import above) rather than the
 * orchestrators themselves, which is the boundary that ticket found
 * duplicated — N511 is what finished that consolidation for the ledger
 * decision specifically, which N485 had left iOS without.
 *
 * ## N502/#873 — the size wall, and the VO₂max-toggle question it raised
 *
 * A user report of "12 failed due to invalid JSON" traced to a real bug: a
 * dense session's HR upload, or a first-run VO₂max backfill, could land a
 * single `putBiometricSamples` request right at the backend's 4 MiB/10,000-row
 * ceiling, which came back as an error indistinguishable from a genuinely
 * malformed body (fixed in `biometric/handler.go`). The actual client-side
 * fix is `putBiometricSamples` itself now chunking every call into
 * `SAMPLES_PER_SYNC_REQUEST`-sized requests (see that constant's doc
 * comment in `./biometric`) — which covers session HR and VO₂max identically,
 * since both go through the same function, without either caller here
 * needing its own chunking logic.
 *
 * **Decision: VO₂max sync keeps the ONE shared HealthKit toggle, not a
 * second one of its own.** Considered and rejected, for two reasons:
 *
 * 1. The permission grant is already shared and already all-or-nothing —
 *    the Settings toggle's own hint text is explicit that turning it on
 *    "asks for Health access" to workouts, heart rate AND VO₂max in the
 *    SAME consent screen (N477/#822's reasoning, still true). A second
 *    app-level toggle would not narrow what HealthKit itself hands over; it
 *    would only gate whether this app's own code reads a category it
 *    already has permission to read, which is a real difference in behavior
 *    (an athlete who wants session HR without a VO₂max trend) but a fairly
 *    narrow, mostly-hypothetical control to add UI for.
 * 2. The actual complaint traced to a bug, not a preference: nothing in the
 *    issue's evidence suggests an athlete objecting to VO₂max being synced
 *    AT ALL — the evidence is a sync that failed outright with an unhelpful
 *    error. Chunking removes the failure mode; adding a toggle would not
 *    have, since the request was failing on size, not on the athlete's
 *    consent.
 *
 * This is revisitable if a future report is actually about VO₂max's
 * always-on nature rather than about a sync that fails — at which point a
 * second toggle sharing the one permission grant (rather than a second
 * HealthKit consent prompt) is the shape it should take, exactly as this
 * reasoning describes.
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

/**
 * How far back the session backfill walks on an account with a long history
 * — N502/#873.
 *
 * Before this, `sessionsNeedingBiometricSync` had a per-pass count floor
 * (`MAX_SESSIONS_PER_PASS`) but no floor in TIME: turning the HealthKit
 * toggle on for the first time on an account with years of logged sessions
 * walked every one of them, oldest first, twenty per foreground return,
 * with no way to ever reach the recent ones sooner. A session from a year
 * before the athlete owned a wearable can never gain real HR evidence no
 * matter how many passes run, so spending passes on it delays the sessions
 * that actually CAN be enriched.
 *
 * 180 days (roughly six months), not `VO2MAX_BACKFILL_DAYS`'s 90 — a
 * deliberately different number for a deliberately different reason. VO₂max
 * is a trend metric where "the last 90 days" is itself the intended answer
 * (design doc §3). A session is a specific, already-logged fact whose value
 * doesn't diminish with age the same way — the cost being bounded here is
 * purely "how much pre-wearable history is worth walking through", not "how
 * far back is this data still meaningful". Six months gives a full backlog
 * from a recently-adopted watch room to catch up without the pass ever
 * reaching back through years of sessions that predate one.
 */
const SESSION_BACKFILL_FLOOR_DAYS = 180;

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

  // Reset at the start of every pass, not decremented on success — this is
  // "how many things failed in the pass currently running/most recently
  // run", not a lifetime tally. A pass that completes clean clears whatever
  // a prior pass left behind; one that fails again leaves the count from
  // THIS pass standing for Settings to show. See `recordBiometricSyncFailure`
  // and PREF_BIOMETRIC_SYNC_FAILURE_COUNT's doc comment (N502/#873) — this
  // is the "some visible signal" this ticket's acceptance criteria ask for:
  // before this, every failure here was fully invisible (per-session
  // `catch { continue }` below, and this whole pass swallowed by `runPass`).
  await writePref(userID, PREF_BIOMETRIC_SYNC_FAILURE_COUNT, '0');

  // Independent chains, same reasoning as `app/(tabs)/you.tsx`'s focus
  // effect: a slow or failing VO₂max read must not block session
  // enrichment, and vice versa.
  await Promise.allSettled([syncSessionWindows(userID, getToken), syncVO2Max(userID, getToken)]);
}

/**
 * Bumps the debug-accessible failure counter Settings reads
 * (`readBiometricSyncFailureCount`) — N502/#873's minimal visible signal.
 * Called from both chains below on any failure that would otherwise be
 * fully silent (a rejected upload/compute call, a rejected VO₂max pass).
 * Best-effort: a failure to record a failure is not itself worth failing
 * the pass over, so this never throws.
 *
 * Read-then-write, not atomic — the two chains this is called from run
 * concurrently via `Promise.allSettled`, so a failure in each at the exact
 * same moment could theoretically interleave and lose one increment. Left
 * as-is deliberately: this counter is a "did last pass have zero problems or
 * not" debug signal, not a precise metric anything depends on, and the two
 * chains failing in the same instant is itself a rare double-failure. Worth
 * revisiting only if this ever needs to be an exact count.
 */
async function recordBiometricSyncFailure(userID: string): Promise<void> {
  try {
    const current = await readBiometricSyncFailureCount(userID);
    await writePref(userID, PREF_BIOMETRIC_SYNC_FAILURE_COUNT, String(current + 1));
  } catch {
    // A SQLite write failing here is not this pass's problem to surface.
  }
}

/** How many biometric-sync failures the most recent pass (or the one
 *  currently running) hit — 0 once a pass completes with none. Read by
 *  `app/settings.tsx` to show a minimal, debug-accessible signal where
 *  previously a failing pass produced nothing visible at all. */
export async function readBiometricSyncFailureCount(userID: string): Promise<number> {
  const raw = await readPref(userID, PREF_BIOMETRIC_SYNC_FAILURE_COUNT);
  const n = raw == null ? 0 : parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

// --- session heart-rate windows (design doc §2) ---------------------------

type LedgerRow = { session_id: string; hr_source: string; attempted_at: string };

/**
 * The local retry ledger, keyed by session — N511/#893. Same shape and same
 * reader pattern as `lib/healthConnectSync.ts`'s own `readLedger`, over
 * `biometric_hr_synced` instead of `health_connect_enrichment`.
 */
async function readBiometricHRLedger(userID: string): Promise<Map<string, EnrichmentLedgerEntry>> {
  const db = await getDb();
  const rows = await db.getAllAsync<LedgerRow>(
    `SELECT session_id, hr_source, attempted_at FROM biometric_hr_synced WHERE user_id = ?`,
    userID,
  );
  const out = new Map<string, EnrichmentLedgerEntry>();
  for (const r of rows) {
    // Defensive fallback rather than trusting a column that could in
    // principle hold anything — same posture as the Android reader.
    out.set(r.session_id, {
      hrSource: r.hr_source === 'window' ? 'window' : 'none',
      attemptedAt: r.attempted_at,
    });
  }
  return out;
}

async function syncSessionWindows(userID: string, getToken: TokenGetter): Promise<void> {
  const now = new Date();
  const floor = new Date(now.getTime() - SESSION_BACKFILL_FLOOR_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [pending, ledger] = await Promise.all([
    sessionsNeedingBiometricSync(userID, MAX_SESSIONS_PER_PASS, floor),
    readBiometricHRLedger(userID),
  ]);
  if (pending.length === 0) return;

  // N511/#893: `sessionsNeedingBiometricSync` already excludes a TERMINAL
  // ('window') session at the SQL layer (see its own doc comment on why
  // that has to happen there, not here, to keep MAX_SESSIONS_PER_PASS's
  // budget meaningful). What this filter adds is the finer, TIME-sensitive
  // half SQL can't express: a 'none' result's cooldown/retry-window, via
  // `lib/biometric.ts`'s shared `needsEnrichmentAttempt` — the same
  // decision N478's Android sibling already made. Deliberately NOT
  // `selectEnrichmentCandidates` itself: that helper also enforces
  // Android's own `isWithinHealthConnectHistoryWall` (30 days), which has
  // no iOS equivalent — iOS already applied its own, more generous backfill
  // floor (`SESSION_BACKFILL_FLOOR_DAYS`, 180 days) in the SQL query above.
  const toEnrich = pending.filter((s) =>
    needsEnrichmentAttempt({ endedAt: s.ended_at }, ledger.get(s.id), now),
  );
  if (toEnrich.length === 0) return;

  // Fetched once per pass, not once per session — a session's own HRmax
  // seed (design doc §3) is a fact about the ATHLETE, not about any one
  // session. `null` — no date of birth, or a seed outside the range
  // ComputeMetrics accepts — means this pass computes NOTHING: see
  // `hrMaxFromDateOfBirth`'s doc comment for why leaving `session_metrics`
  // uncomputed is the honest answer rather than guessing an HRmax. Left
  // exactly as it was pre-N511 (bail the whole pass, write no ledger rows
  // at all) rather than matched to Android's per-session "'none' but still
  // upload samples" branch — out of this ticket's scope, and every session
  // this skips is already correctly retryable next pass with no ledger row
  // written for it either way.
  let hrMaxBPM: number | null = null;
  try {
    const profile = await getProfile(getToken);
    hrMaxBPM = hrMaxFromDateOfBirth(profile.date_of_birth, now);
  } catch {
    // Offline, or no profile yet — same "nothing here is computable this
    // pass" outcome as a missing date of birth.
  }
  if (hrMaxBPM == null) return;

  for (const session of toEnrich) {
    const window = sessionHRWindow(session.started_at, session.ended_at);
    if (!window) continue; // should not happen — the query already filters on ended_at set.

    const raw = await queryHeartRateSamples(window.start, window.end);
    const samples = raw.map((s) => toBiometricSample(s, 'heart_rate', 'healthkit'));
    const plan = planHRSync(samples);

    try {
      if (plan.kind === 'upload-and-compute') {
        await putBiometricSamples(getToken, plan.samples);
      }
      // 'estimated' — hrMaxBPM above only ever comes from
      // hrMaxFromDateOfBirth (the 220 - age seed); see biometric.ts's
      // HRMaxSource doc comment for why nothing in this app produces
      // 'observed' yet. `plan.hrSource` is always the CLAIM 'window' (see
      // `planHRSync`'s own doc comment) — the backend is authoritative on
      // the actual RESULT, downgrading to `hr_source: 'none'` itself once
      // it sees zero heart_rate samples for the window. N511/#893's fix is
      // reading THAT back (`metrics.hr_source` below) rather than — as the
      // pre-N511 code did — ignoring the response and marking the ledger
      // "done" unconditionally.
      const metrics = await computeSessionMetrics(getToken, session.id, hrMaxBPM, 'estimated', plan.hrSource);
      await recordBiometricHRAttempt(
        userID,
        session.id,
        metrics.hr_source === 'window' ? 'window' : 'none',
        now,
      );
    } catch {
      // Leave this session's ledger row exactly as it was (absent, or its
      // previous attempt) — the next pass's `needsEnrichmentAttempt` decides
      // fresh whether to retry it. One session's network failure must not
      // abort every other candidate in this pass.
      await recordBiometricSyncFailure(userID);
      continue;
    }
  }
}

/**
 * Upserts this session's enrichment ATTEMPT — not merely "done" the way the
 * pre-N511 `INSERT OR IGNORE` did. `ON CONFLICT ... DO UPDATE` because a
 * retried session (its previous attempt was `'none'`) must overwrite that
 * row with the new attempt's outcome and timestamp, not silently no-op the
 * way `OR IGNORE` would have.
 */
async function recordBiometricHRAttempt(
  userID: string,
  sessionID: string,
  hrSource: 'window' | 'none',
  now: Date,
): Promise<void> {
  const db = await getDb();
  const nowISO = now.toISOString();
  await db.runAsync(
    `INSERT INTO biometric_hr_synced (user_id, session_id, synced_at, hr_source, attempted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, session_id) DO UPDATE SET
       synced_at = excluded.synced_at,
       hr_source = excluded.hr_source,
       attempted_at = excluded.attempted_at`,
    userID,
    sessionID,
    nowISO,
    hrSource,
    nowISO,
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
  try {
    // putBiometricSamples chunks internally (N502/#873) — a 90-day
    // first-run backfill can no longer land as one oversized request; see
    // that function's own doc comment in `./biometric`.
    await putBiometricSamples(getToken, samples);
  } catch {
    // Same "leave state exactly as it was, the next pass retries from the
    // same high-water mark" posture as syncSessionWindows's per-session
    // catch — the mark below is only ever advanced past what was actually
    // confirmed uploaded.
    await recordBiometricSyncFailure(userID);
    return;
  }

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
