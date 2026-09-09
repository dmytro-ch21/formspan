import * as Location from 'expo-location';
import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';

import { getDb } from './db';

/**
 * W21/#992 — GPS capture that survives a locked screen.
 *
 * **Why this file exists at all, since the answer is not obvious from the
 * Expo docs.** `Location.watchPositionAsync` can NEVER deliver in the
 * background on iOS, whatever `UIBackgroundModes` says: expo-location's
 * `BaseLocationProvider.swift` hard-codes
 * `manager.allowsBackgroundLocationUpdates = false`, and the only place it
 * is set true is `EXLocationTaskConsumer.m` — the TaskManager path. So a run
 * tracked with `watchPositionAsync` stops the moment the phone locks, which
 * is how the athlete found this: distance, pace and route all ended
 * mid-run, silently.
 *
 * **What this task deliberately does NOT do.** It makes no decisions. It
 * appends fixes to `running_fix_queue` and nothing else — no accuracy
 * filter, no auto-pause, no distance. All of that stays in
 * `app/running/[id].tsx`, which drains the queue and feeds each fix through
 * the same logic it always used. That logic (the hysteresis in
 * `runningAutoPause.ts`, the accuracy floor, the generation guard) took
 * several tickets to get right, and a headless copy of it would be a second
 * implementation free to diverge from the first without anything noticing.
 *
 * The consequence to keep in mind: while backgrounded, fixes ACCUMULATE and
 * are interpreted later. That is why the drain must use each fix's own
 * `recorded_at` rather than the wall clock — see `drainRunFixQueue`.
 */

export const RUN_LOCATION_TASK = 'vola-run-location';

/** Who the queued fixes belong to. Set when a run starts, cleared when it
 *  ends; the task itself has no React context to read it from. */
let taskIdentity: { userID: string; sessionID: string } | null = null;

export function setRunTrackingIdentity(identity: { userID: string; sessionID: string } | null): void {
  taskIdentity = identity;
}

/** Exported for the drain path and tests: the row shape the queue holds. */
export type QueuedFix = {
  id: number;
  lat: number;
  lng: number;
  elevation_m: number | null;
  accuracy_m: number | null;
  speed_mps: number | null;
  recorded_at: string;
};

export async function appendRunFixes(
  userID: string,
  sessionID: string,
  locations: { coords: { latitude: number; longitude: number; altitude: number | null; accuracy: number | null; speed: number | null }; timestamp: number }[],
): Promise<void> {
  if (locations.length === 0) return;
  const db = await getDb();
  for (const loc of locations) {
    await db.runAsync(
      `INSERT INTO running_fix_queue (user_id, session_id, lat, lng, elevation_m, accuracy_m, speed_mps, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userID,
      sessionID,
      loc.coords.latitude,
      loc.coords.longitude,
      loc.coords.altitude,
      loc.coords.accuracy,
      loc.coords.speed,
      new Date(loc.timestamp).toISOString(),
    );
  }
}

/** Everything queued after `afterID`, oldest first. The caller records the
 *  last id it consumed, so a fix is processed exactly once even if the app
 *  is killed and relaunched mid-run. */
export async function readRunFixQueue(
  userID: string,
  sessionID: string,
  afterID: number,
  limit = 2000,
): Promise<QueuedFix[]> {
  const db = await getDb();
  return db.getAllAsync<QueuedFix>(
    `SELECT id, lat, lng, elevation_m, accuracy_m, speed_mps, recorded_at
     FROM running_fix_queue
     WHERE user_id = ? AND session_id = ? AND id > ?
     -- Explicit, and deliberately kept even though removing it does not
     -- change the result: both plans SQLite can choose here (a table scan,
     -- or the (user_id, session_id, id) index) already yield id order, so a
     -- mutation that deletes it survives the suite. It states the contract
     -- the drain depends on — distance is a sum of consecutive segments, so
     -- an out-of-order drain would draw a zig-zag and inflate the total —
     -- rather than leaving it to a query plan that is free to change.
     ORDER BY id LIMIT ?`,
    userID,
    sessionID,
    afterID,
    limit,
  );
}

/** Called when a run finishes: the queue has served its purpose and the
 *  points now live in the run's own detail. */
export async function clearRunFixQueue(userID: string, sessionID: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM running_fix_queue WHERE user_id = ? AND session_id = ?`, userID, sessionID);
}

// The task must be defined at module scope so it is registered before iOS
// ever hands work back to a relaunched app (TaskManager looks it up by name
// at that moment, not when the screen mounts).
TaskManager.defineTask(RUN_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const identity = taskIdentity;
  if (!identity) return; // no run in progress — nothing owns these fixes
  const locations = (data as { locations?: Parameters<typeof appendRunFixes>[2] } | undefined)?.locations;
  if (!locations?.length) return;
  try {
    await appendRunFixes(identity.userID, identity.sessionID, locations);
  } catch {
    // A failed local write loses one batch of fixes, not the run. Throwing
    // here would only surface in the OS log where nothing reads it.
  }
});

/** Starts background-capable tracking for this run. Foreground accuracy and
 *  cadence match what `watchPositionAsync` used before, so the track's shape
 *  is unchanged; what changes is that it keeps arriving once the screen
 *  locks. */
let androidSub: Location.LocationSubscription | null = null;

/**
 * Starts capture for this run.
 *
 * **Two capture mechanisms, ONE interpretation.** Both paths append to the
 * same queue, so `app/running/[id].tsx` drains identically on either
 * platform and there is no second copy of the accuracy/auto-pause logic:
 *
 * - **iOS** — the TaskManager path, which is the only one expo-location
 *   allows to run backgrounded (see this file's doc comment). This is the
 *   fix W21/#992 is about.
 * - **Android** — `watchPositionAsync`, exactly as before this ticket.
 *   Background location on Android additionally needs
 *   `ACCESS_BACKGROUND_LOCATION` and a foreground service, which is its own
 *   permission story and its own Play review; adopting the task path here
 *   without them would risk `startLocationUpdatesAsync` failing outright and
 *   turning a working foreground run into no run at all. Android keeps
 *   today's behaviour until that ticket, rather than being made worse by a
 *   fix aimed at iOS.
 */
export async function startRunTracking(userID: string, sessionID: string): Promise<void> {
  setRunTrackingIdentity({ userID, sessionID });
  const options = {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 3000,
    distanceInterval: 8,
  } as const;

  if (Platform.OS !== 'ios') {
    if (androidSub) return;
    androidSub = await Location.watchPositionAsync(options, (loc) => {
      void appendRunFixes(userID, sessionID, [loc]).catch(() => {});
    });
    return;
  }

  if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(RUN_LOCATION_TASK, {
    ...options,
    // The athlete's assurance that a locked phone is still recording the run
    // they started — iOS shows its blue indicator while this is true.
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
  });
}

/** Stops tracking. Safe to call when nothing is running — a finished run
 *  must leave no background work behind, which is half of what this ticket
 *  is about. */
export async function stopRunTracking(): Promise<void> {
  setRunTrackingIdentity(null);
  androidSub?.remove();
  androidSub = null;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK);
    }
  } catch {
    // Already stopped, or the task was never registered in this process.
  }
}
