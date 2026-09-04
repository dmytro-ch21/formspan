import { AppState, type AppStateStatus } from 'react-native';

import { getDb, withTransaction } from './db';
import { upsertDetectedActivities, DETECTED_ACTIVITY_WINDOW_DAYS } from './detectedActivity';
import {
  filterNewWorkouts,
  isHealthKitSupported,
  mapWorkoutToRunningDetail,
  queryOtherWorkouts,
  queryRunningWorkouts,
  requestHealthKitReadAuthorization,
} from './healthkit';
import { PREF_HEALTHKIT_IMPORT, readPref, writePref } from './prefs';
import { RUN_EXERCISE_ID } from './running';
import { emptySet } from './sessions';
import { saveLocalRunningDetail, saveLocalSets, startLocalSession } from './sessionStore';
import { request as requestSync } from './sync';

/**
 * Orchestrates HealthKit import (N465) — the settings toggle, the local
 * dedup ledger, and WHEN a pass runs. `lib/healthkit.ts` is the native
 * boundary and the pure mapping; this file is what decides to call it and
 * what to do with what it returns.
 *
 * **N479/#824 rides the same pass.** `detectOtherHealthKitActivity` below
 * runs alongside the running import on every trigger this file already has
 * (sign-in, foreground, the settings toggle) rather than getting its own
 * `AppState` listener and mutex — the ticket's own instruction is to respect
 * this existing pattern, not add a second copy of it for one more kind of
 * activity.
 *
 * ## Foreground/launch, not a true background task — and why
 *
 * iOS background execution for a non-critical periodic sync is both
 * unreliable (the OS decides if and when a background task actually runs,
 * budgeted against battery and usage patterns) and a real complexity step up
 * (a background task entitlement, a scheduler, a time budget to respect).
 * This ticket's own scope is already the entitlement, the permission UX, the
 * settings toggle, the dedup ledger and the mapping — adding a background
 * task on top risks all of it for a feature that is, honestly, fine to
 * import a run a few minutes after the athlete opens the app rather than
 * seconds after the watch syncs it to the phone. `app.json`'s plugin config
 * passes `background: false` for the same reason: this feature does not use
 * (and should not silently declare) `com.apple.developer.healthkit.background-delivery`.
 *
 * Mirrors `lib/sync.ts`'s own orchestrator shape deliberately — module-level
 * identity set once from `app/_layout.tsx`, an `AppState` listener registered
 * once for the process, a run triggered on sign-in and on every foreground
 * return. Two SEPARATE orchestrators rather than folding this into
 * `lib/sync.ts` itself: that file's `request()`/backoff/retry machinery
 * exists to push OWED local rows to the server under real network
 * conditions, and none of that applies here — a HealthKit import pass never
 * fails on a bad connection (it is a local SQLite operation until the very
 * end, where it merely calls `requestSync` to hand the *results* to the
 * ordinary outbox). Sharing the mechanism would mean teaching that retry
 * ladder about a failure mode it does not have.
 */

/** Whether this device has HealthKit import turned on. Off by default. */
export async function readHealthKitImportEnabled(userID: string): Promise<boolean> {
  return (await readPref(userID, PREF_HEALTHKIT_IMPORT)) === '1';
}

/**
 * Turn import on or off for this device.
 *
 * Turning it OFF does not un-import anything already brought in — those runs
 * are real training history now, same as a phone-GPS run, and toggling a
 * setting must not make data disappear. It only stops the next
 * foreground/launch pass from asking HealthKit for more.
 */
export function writeHealthKitImportEnabled(userID: string, on: boolean): Promise<void> {
  return writePref(userID, PREF_HEALTHKIT_IMPORT, on ? '1' : '0');
}

/** HealthKit UUIDs this device has already imported. */
export async function importedHealthKitUUIDs(userID: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ healthkit_uuid: string }>(
    `SELECT healthkit_uuid FROM healthkit_imports WHERE user_id = ?`,
    userID,
  );
  return new Set(rows.map((r) => r.healthkit_uuid));
}

/**
 * `INSERT OR IGNORE`, not a plain insert: the per-user unique index this
 * table is built on (its primary key) means a uuid already recorded here is
 * a no-op rather than a thrown error — safe to call even if, somehow, this
 * function ran twice for the same workout in one pass.
 */
async function recordHealthKitImport(userID: string, uuid: string, sessionID: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO healthkit_imports (user_id, healthkit_uuid, session_id, imported_at)
     VALUES (?, ?, ?, ?)`,
    userID,
    uuid,
    sessionID,
    new Date().toISOString(),
  );
}

/**
 * N479/#824: record other HealthKit-noticed activity (a walk, a hike) that
 * has no matching VOLA session, for Today's own "detected but not logged"
 * card. Unlike the running import below, this never creates a session on
 * its own — it only writes to the `detected_activities` ledger, so tapping
 * "Log it" on the resulting card (`lib/detectedActivity.ts`'s
 * `logDetectionAsSession`) is what actually commits it. Bounded to the same
 * trailing window the card is willing to display
 * (`DETECTED_ACTIVITY_WINDOW_DAYS`) — there is no reason to fetch, store or
 * dedup a workout old enough to never be shown.
 */
async function detectOtherHealthKitActivity(userID: string): Promise<void> {
  const since = new Date(Date.now() - DETECTED_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const workouts = await queryOtherWorkouts(since);
  if (workouts.length === 0) return;
  await upsertDetectedActivities(
    userID,
    'healthkit',
    workouts.map((w) => ({
      id: w.uuid,
      type: w.type,
      startDate: w.startDate,
      endDate: w.endDate,
      durationSeconds: w.durationSeconds,
      distanceMeters: w.distanceMeters,
    })),
  );
}

/**
 * One import pass: ask HealthKit for running workouts, skip the ones this
 * device already has, create a local session for each new one, and hand the
 * result to the ordinary sync outbox.
 *
 * Every write here is local SQLite — `startLocalSession` and friends, the
 * same functions a live-tracked run uses at Finish (`app/running/[id].tsx`)
 * — so this function needs no network and no auth token to do its job; the
 * PUSH to the server is the ordinary outbox's concern from here on, kicked
 * off by the `requestSync` call at the end. That is also why an offline
 * import pass still "succeeds": the runs land in training history
 * immediately, on this device, and reach the server whenever connectivity
 * allows — exactly the posture every other logging flow in this app takes.
 *
 * Returns `{ imported: 0 }` — never throws — when the toggle is off, this
 * binary has no HealthKit module, or HealthKit itself has nothing new to
 * offer. A caller that wants to react to failure has nothing to catch: there
 * is no failure mode here that is the athlete's to fix.
 */
export async function importHealthKitRuns(userID: string): Promise<{ imported: number }> {
  if (!(await readHealthKitImportEnabled(userID))) return { imported: 0 };
  if (!isHealthKitSupported()) return { imported: 0 };

  // Safe on every pass, not only the first — see requestHealthKitReadAuthorization's
  // own doc comment for why this never re-prompts once answered.
  await requestHealthKitReadAuthorization();

  // N479/#824: notice other activity (a walk, a hike) for Today's own card —
  // best-effort and never allowed to fail the running import this function
  // exists for. Uses the SAME toggle as running import rather than a new
  // one: `HKWorkoutTypeIdentifier` is already in `READ_TYPES`, so there is
  // no new permission to ask for, and a second toggle would ask for consent
  // to a grant the athlete already gave. See `app/settings.tsx`'s "Sync with
  // Apple Health" hint, which N477 already widened once for the identical
  // reason.
  try {
    await detectOtherHealthKitActivity(userID);
  } catch {
    // Nothing here is the athlete's to fix — the next foreground pass tries
    // again, same posture as every other catch in this file.
  }

  // The ledger is read BEFORE the HealthKit query and passed straight into
  // it, so `queryRunningWorkouts` can skip the per-workout route fetch
  // entirely for anything already imported — the route call is the
  // expensive half (a second native round trip per workout), and an
  // athlete with years of watch history re-paying it every foreground
  // return for runs already sitting in Training History is real,
  // avoidable cost.
  const already = await importedHealthKitUUIDs(userID);
  const workouts = await queryRunningWorkouts(already);
  // Filtered again here even though `queryRunningWorkouts` already skipped
  // fetching routes for these — belt and braces against a native query ever
  // returning something already in the ledger, and it is what keeps
  // `filterNewWorkouts` itself exercised by the real pipeline rather than
  // only by its own unit test.
  const fresh = filterNewWorkouts(workouts, already);
  if (fresh.length === 0) return { imported: 0 };

  // Oldest first, so training history fills in chronological order and an
  // import interrupted partway (the app backgrounded again mid-pass) leaves
  // a ledger consistent with "everything before the newest recorded row has
  // been handled" — the next pass simply picks up where this one stopped.
  const ordered = [...fresh].sort((a, b) => a.startDate.localeCompare(b.startDate));

  const db = await getDb();
  let imported = 0;
  for (const workout of ordered) {
    // All four writes for one workout, atomically. Without this, a failure
    // between them (saveLocalRunningDetail throwing after startLocalSession
    // succeeds, say) leaves a session on disk with no ledger entry — which
    // reads to the NEXT import pass as "never imported" and creates a
    // SECOND session for the identical workout, compounding the exact
    // duplication this feature exists to prevent rather than merely failing
    // to prevent it once.
    await withTransaction(db, async () => {
      // ended_at supplied at creation, not via a separate finishLocalSession
      // call: this is a reflection log of something already over, the same
      // shape startLocalSession's own doc comment describes, not a live
      // session that finishes later.
      const session = await startLocalSession(userID, {
        sport: 'running',
        name: 'Run',
        started_at: workout.startDate,
        ended_at: workout.endDate,
      });
      await saveLocalRunningDetail(userID, session.id, mapWorkoutToRunningDetail(workout, session.id));
      // A session_sets row against the seeded `run` exercise, so the
      // generic personal-record pipeline sees this run — the exact reason
      // app/running/[id].tsx's Finish handler writes the same row for a
      // phone-GPS run. Mirrored here rather than reused because that
      // handler is UI code (state, error handling for a live screen) and
      // this is a background pass with none of that.
      await saveLocalSets(userID, session.id, [
        {
          ...emptySet(RUN_EXERCISE_ID, 0),
          distance_m: workout.distanceMeters,
          seconds: workout.durationSeconds || null,
          completed: true,
        },
      ]);
      await recordHealthKitImport(userID, workout.uuid, session.id);
    });
    imported++;
  }

  requestSync('healthkit-import');
  return { imported };
}

// --- orchestration: when a pass runs -----------------------------------

let currentUserID: string | null = null;
let running = false;

/**
 * Who to import as. Set from `app/_layout.tsx` alongside `setSyncIdentity`,
 * cleared on sign-out for the identical reason that one is: a queued
 * foreground trigger firing after sign-out must not import HealthKit runs
 * under the NEXT athlete's identity on a shared device.
 */
export function setHealthKitSyncIdentity(userID: string | null): void {
  currentUserID = userID;
  if (userID) runImportPass('sign-in');
}

/**
 * Trigger an import pass right now, respecting the SAME `running` mutex the
 * foreground/launch orchestrator uses.
 *
 * This is the only sanctioned way to kick off an out-of-band pass — the
 * Settings toggle calls this, never `importHealthKitRuns` directly. Calling
 * the raw function bypasses the mutex: flipping the toggle on at the exact
 * moment a foreground-triggered pass is already mid-flight would run TWO
 * concurrent passes, and two passes racing to import the same new workout
 * both pass the SAME "not yet in the ledger" check before either has
 * written its own row, creating two local sessions for one workout — the
 * bug this feature's own dedup exists to prevent, reintroduced by the
 * trigger meant to make it happen sooner.
 */
export function triggerHealthKitImportNow(userID: string): void {
  // Keeps the module's own identity in step with whoever is calling this —
  // there is no reason a caller that already knows the current athlete's id
  // should have to trust a second, independently-tracked copy of it.
  currentUserID = userID;
  runImportPass('settings-toggle');
}

function runImportPass(reason: string): void {
  if (!currentUserID || running) return;
  const userID = currentUserID;
  running = true;
  void importHealthKitRuns(userID)
    .catch(() => {
      // See importHealthKitRuns's own doc comment: nothing here is the
      // athlete's to fix, and nothing here should interrupt anything else —
      // the next foreground/launch tries again on its own.
    })
    .finally(() => {
      running = false;
    });
  void reason; // kept for parity with lib/sync.ts's call sites; not logged.
}

let appStateSub: { remove: () => void } | null = null;

/**
 * Runs a pass on every return to the foreground, mirroring
 * `lib/sync.ts`'s `startSyncOrchestrator` — see this file's doc comment for
 * why the two stay separate. Registered once for the process, in
 * `app/_layout.tsx`, not per screen.
 */
export function startHealthKitImportOrchestrator(): () => void {
  appStateSub?.remove();
  let previous: AppStateStatus = AppState.currentState;
  appStateSub = AppState.addEventListener('change', (next) => {
    const wasAway = previous === 'background' || previous === 'inactive';
    const returned = wasAway && next === 'active';
    previous = next;
    if (!returned) return;
    runImportPass('foreground');
  });
  return () => {
    appStateSub?.remove();
    appStateSub = null;
  };
}
