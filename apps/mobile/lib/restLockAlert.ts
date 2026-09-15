import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { remainingAt, type Countdown } from './countdown';
import { PREF_REST_LOCK_ALERT, readPref, writePref } from './prefs';

/**
 * The rest timer's lock-screen alert — N195 (#612).
 *
 * A rest that ends while the phone is locked used to be silent: the chime is
 * driven by the countdown's JS timers, and iOS suspends JS the moment the app
 * leaves the screen (see `lib/sounds.ts`, "What this deliberately does NOT
 * do"). This is the other mechanism that note names: ONE scheduled local
 * notification, set for the moment the rest ends.
 *
 * ## It exists only while the app is away
 *
 * Scheduled when the app goes to `background` or `inactive` with a rest
 * running, for exactly the time left. Cancelled the moment the app is `active`
 * again. So:
 *
 * - **Foreground behaviour is literally unchanged.** With the app on screen
 *   nothing is scheduled, and the in-app chime is the only sound.
 * - **The sound never plays twice.** A rest that ends in the foreground never
 *   had a notification; one that ends while away had no chime, because JS was
 *   suspended.
 * - **Nothing stale can fire.** Skip, Stop and starting another rest are all
 *   taps, and a tap means the app is active — which already cancelled it. A
 *   countdown that changes while the app is away (a guided run stepping on
 *   while `inactive`) is re-planned: rescheduled for the new rest, or cleared.
 *   A relaunch clears it too (`app/_layout.tsx`), because a countdown does not
 *   survive its process.
 *
 * One fixed identifier, so scheduling again REPLACES rather than adds, and a
 * cancel needs no memory of what was scheduled.
 *
 * ## What it deliberately does not do
 *
 * - **No Live Activity.** A live lock-screen countdown needs a second native
 *   target (a widget extension) and native code. The notification answers
 *   "don't let me miss it"; the countdown on the lock screen is a follow-up.
 * - **No exact alarms on Android.** No `SCHEDULE_EXACT_ALARM`: that is a
 *   sensitive permission, and on Android 12+ `expo-notifications` falls back to
 *   `setAndAllowWhileIdle`, which the OS may deliver late. Measured on a device,
 *   not assumed — see `docs/testing/device-checks.md`.
 * - **No bundled chime as the notification sound.** `rest-done.m4a` is AAC in
 *   an MPEG-4 container, and iOS plays a notification sound only from Linear
 *   PCM, MA4, µ-law or a-law in an aiff, wav or caf file. Transcoding it by
 *   hand would put a second binary outside `scripts/generate_sounds.py`, which
 *   is the source of truth for every sound. So the system default sound is
 *   used on both platforms.
 * - **It does not break through the silent switch.** A notification sound
 *   follows the ringer, unlike the in-app chime (`playsInSilentMode`). Getting
 *   past it needs Apple's critical-alerts entitlement, which is not granted for
 *   a rest timer.
 * - **It never asks for permission.** Only the Settings row does, when the
 *   athlete turns it on. A prompt mid-set is exactly the interruption the
 *   set-logging path forbids.
 */

/** One id for the one alert, so a reschedule replaces and a cancel needs no memory. */
export const REST_ALERT_ID = 'vola-rest-timer';

/** Android's channel for it. The athlete can change its sound or silence it in system settings. */
export const REST_ALERT_CHANNEL = 'rest-timer';

/**
 * Below this much rest left, nothing is scheduled.
 *
 * The in-app completion owns anything that close: iOS gives a backgrounding app
 * a few seconds before suspending it, so the countdown's own timeout fires, and
 * a one-second notification would land on top of it as the second sound this
 * design exists to prevent.
 */
export const MIN_LEAD_SECONDS = 1;

/** The two states in which the chime cannot be relied on to play. */
export function isAway(appState: string): boolean {
  return appState === 'background' || appState === 'inactive';
}

export type LockAlertPlan =
  | { kind: 'schedule'; seconds: number; title: string; body: string }
  | {
      kind: 'clear';
      reason: 'foreground' | 'off' | 'no-countdown' | 'not-rest' | 'paused' | 'over';
    };

/**
 * Should a rest alert be scheduled right now, and for when?
 *
 * Pure, with `now` a parameter, for the same reason `countdown.ts` is: every
 * decision here is a guard, and a guard is only tested by the input it rejects.
 * `enabled` is the athlete's preference AND the phone's permission — the
 * caller reads both, because neither can be asked synchronously.
 *
 * Each `clear` names why, so a test can tell "cleared because paused" from
 * "cleared because it was a work set" — a single boolean would let one guard
 * stand in for another.
 */
export function lockAlertPlan(input: {
  appState: string;
  timer: Countdown | null;
  enabled: boolean;
  now: number;
}): LockAlertPlan {
  if (!isAway(input.appState)) return { kind: 'clear', reason: 'foreground' };
  if (!input.enabled) return { kind: 'clear', reason: 'off' };
  const t = input.timer;
  if (!t) return { kind: 'clear', reason: 'no-countdown' };
  // A work countdown ending WRITES a set when the app is back, and a count-in
  // hands straight to work. "Rest's up" over either would be a wrong alert.
  if (t.kind !== 'rest') return { kind: 'clear', reason: 'not-rest' };
  // A paused rest has no end to schedule for.
  if (t.pausedWith != null) return { kind: 'clear', reason: 'paused' };
  const left = remainingAt(t, input.now);
  if (left < MIN_LEAD_SECONDS) return { kind: 'clear', reason: 'over' };
  return {
    kind: 'schedule',
    seconds: Math.max(MIN_LEAD_SECONDS, Math.round(left)),
    ...lockAlertCopy(t.label),
  };
}

/**
 * What the alert says.
 *
 * Names what the athlete rested FROM, never what comes next. The countdown's
 * label is the exercise just done, and in a guided session the rest between
 * exercises carries the one just finished (`intervalRun.ts`,
 * `buildSessionRun`). So "next set of Bench Press" would be false whenever the
 * next set is a squat. `'Rest'` is `startRest`'s fallback when no name is at
 * hand, and repeating it as a name would read "Rest after Rest".
 *
 * No pressure in the wording: the set is ready when the athlete is.
 */
export function lockAlertCopy(label: string): { title: string; body: string } {
  const name = label.trim();
  const named = name.length > 0 && name !== 'Rest';
  return {
    title: "Rest's up",
    body: named
      ? `Rest after ${name} is over. Your next set is ready when you are.`
      : 'Your next set is ready when you are.',
  };
}

/**
 * The phone's answer, reduced to what the Settings row has to say differently.
 *
 * `denied-can-ask` is Android 13+ after a single refusal: the system allows
 * one more ask. iOS reports `canAskAgain: false` after the first refusal, so
 * there it goes straight to `denied`.
 */
export type AlertPermission = 'granted' | 'undetermined' | 'denied-can-ask' | 'denied';

export function permissionOf(r: {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
}): AlertPermission {
  if (r.granted) return 'granted';
  if (r.status === 'undetermined') return 'undetermined';
  return r.canAskAgain ? 'denied-can-ask' : 'denied';
}

/**
 * The line under the Settings row when the athlete wants the alert and the
 * phone refuses it.
 *
 * Says what is off and where to change it, and nothing about the athlete.
 * `null` for any state that is not a refusal, so the row cannot show it by
 * accident.
 */
export function refusedLineFor(os: string, permission: AlertPermission | null): string | null {
  if (permission !== 'denied' && permission !== 'denied-can-ask') return null;
  const lead = "Notifications are off for VOLA, so this can't alert you.";
  if (os === 'android') {
    return permission === 'denied-can-ask'
      ? `${lead} Turn it on again to be asked, or open the Settings app, then Apps, VOLA, Notifications.`
      : `${lead} To change it, open the Settings app, then Apps, VOLA, Notifications.`;
  }
  return `${lead} To change it, open the Settings app, then Notifications, VOLA, and turn on Allow Notifications.`;
}

export async function readRestLockAlertEnabled(userID: string): Promise<boolean> {
  return (await readPref(userID, PREF_REST_LOCK_ALERT)) === '1';
}

export function writeRestLockAlertEnabled(userID: string, on: boolean): Promise<void> {
  return writePref(userID, PREF_REST_LOCK_ALERT, on ? '1' : '0');
}

/**
 * Android's channel, created before anything that needs it.
 *
 * HIGH importance, so it sounds and shows on the lock screen rather than
 * arriving silently in the shade. PUBLIC on the lock screen because "Rest's
 * up" says nothing private. It does not bypass Do Not Disturb: a Focus the
 * athlete set is theirs. Creating it again is a no-op for settings the athlete
 * has since changed, which is Android's rule and the right one.
 *
 * Also a prerequisite for the permission prompt: on Android 13+ the system
 * shows it only once the app has a channel.
 */
export async function ensureRestAlertChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(REST_ALERT_CHANNEL, {
    name: 'Rest timer',
    description: 'Tells you a rest is over while VOLA is not on screen.',
    importance: Notifications.AndroidImportance.HIGH,
    // `sound` deliberately ABSENT. Read in `AndroidXNotificationsChannelManager
    // .createSoundUriFromArguments`: no key means the system default sound, a
    // null means silence, and any string is looked up as a `res/raw` file — so
    // `'default'` would ask for a resource named "default" that does not exist.
    enableVibrate: true,
    vibrationPattern: [0, 250, 150, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    showBadge: false,
    bypassDnd: false,
  });
}

/** Reads the permission. Never prompts. */
export async function readAlertPermission(): Promise<AlertPermission> {
  return permissionOf(await Notifications.getPermissionsAsync());
}

/**
 * Asks for the permission. Called from the Settings row, on the athlete's tap,
 * and from nowhere else.
 */
export async function askAlertPermission(): Promise<AlertPermission> {
  await ensureRestAlertChannel();
  return permissionOf(
    await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    }),
  );
}

/** Schedules (or replaces) the one rest alert. */
export async function scheduleRestLockAlert(plan: {
  seconds: number;
  title: string;
  body: string;
}): Promise<void> {
  await ensureRestAlertChannel();
  await Notifications.scheduleNotificationAsync({
    identifier: REST_ALERT_ID,
    content: {
      title: plan.title,
      body: plan.body,
      sound: 'default',
      interruptionLevel: 'active',
      data: { kind: 'rest-timer' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: plan.seconds,
      channelId: REST_ALERT_CHANNEL,
    },
  });
}

/**
 * Cancels it. Swallows failure, like every sound in the app: a native error
 * here must not break the screen that asked.
 */
export async function cancelRestLockAlert(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(REST_ALERT_ID);
  } catch {
    // Nothing was scheduled, or the module is unavailable.
  }
}
