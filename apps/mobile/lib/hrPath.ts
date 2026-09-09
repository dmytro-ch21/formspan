/**
 * N552/#1021 — "it should work with any wearable": the TWO paths heart rate
 * can reach VOLA by, which one this athlete is actually on, and what to say
 * about it. Pure — no I/O, no platform — so every branch is testable and the
 * two surfaces that name a path (Settings, and the finished report's
 * `hrSourceLine`) cannot drift apart.
 *
 * ## The complaint, and why "support more devices" is the wrong answer
 *
 * The BLE path is already vendor-neutral BY CONSTRUCTION.
 * `lib/hrMonitor/liveHR.ts` scans on the standard GATT Heart Rate Service
 * (`0x180D`) and `lib/hrMonitor/heartRateProfile.ts` parses the standard
 * measurement characteristic (`0x2A37`) per HRS 1.0 §3.1.1. Neither ever
 * looks at a brand, a model or a device name — which is why `source:
 * 'hr_monitor'` is one vendor-neutral value rather than a vendor list. Every
 * chest strap, and every watch with broadcasting switched on, already works
 * with no per-brand code.
 *
 * What does NOT work over BLE cannot be fixed in this repo at all. An Apple
 * Watch never exposes live heart rate to a third-party app over Bluetooth —
 * HealthKit is the only route. Fitbit and Oura have no standard broadcast.
 * Most Samsung / Wear OS watches go through Health Connect instead.
 *
 * So the failure this module fixes is not a missing device: it is that
 * Settings offered a scan and said NOTHING about a device that can never
 * appear in one. An Apple Watch owner scanned, found nothing, and reasonably
 * concluded the feature was broken — when in fact their path exists, works,
 * and simply is not the scan.
 *
 * ## The two paths, named once
 *
 * Every surface uses `hrPathName` rather than its own words, so "Live over
 * Bluetooth" in Settings and "Live over Bluetooth" on the finished report
 * are the same string from the same place.
 */

import type { HealthSource } from './vo2MaxSource';
import { healthSourceLabel } from './vo2MaxSource';

/** The two ways heart rate reaches a session. There is no third. */
export type HRPath = 'live' | 'health';

/**
 * What each path is CALLED, everywhere. The health path's name carries the
 * store's own name because "afterwards" alone says nothing about where from,
 * and the athlete knows the store by its brand.
 */
export function hrPathName(path: HRPath, sourceLabel: string): string {
  return path === 'live' ? 'Live over Bluetooth' : `From ${sourceLabel} afterwards`;
}

/**
 * Which situation this athlete is in.
 *
 * `'live'` is stated from the PAIRING, not from a live connection: the link
 * is opened by a run and released when it ends (W21/#992), so a paired strap
 * sitting in a drawer with the app open is correctly "on the live path" —
 * that is what will happen when they next start a run.
 */
export type HRPathState =
  /** Something needed to decide is still being read. Say nothing yet. */
  | 'loading'
  /** A monitor is paired. Live over Bluetooth, with the health store filling
   *  any gaps — the best case, and the only one where both paths are live. */
  | 'live'
  /** No monitor paired, health sync on, and the store holds recent heart
   *  rate: the fallback path is demonstrably working. */
  | 'health'
  /** No monitor paired, health sync on, and the store holds NO recent heart
   *  rate. Nothing is feeding it — a finished session will come back empty. */
  | 'health_quiet'
  /** No monitor paired, health sync on, and we could not tell what the store
   *  holds (the read failed, or access was declined). */
  | 'health_unknown'
  /** Neither path is set up: no monitor, and no usable health store or its
   *  sync is off. Sessions get no heart rate at all. */
  | 'nothing';

export type HRPathInput = {
  /** `isBluetoothSupported()` — false in a build with no BLE module. */
  bluetoothSupported: boolean;
  /** The remembered monitor's name, `null` for none, `undefined` while the
   *  store read is still in flight. */
  monitorName: string | null | undefined;
  /** This device's health store, or `null` if it has none. */
  healthSource: HealthSource | null;
  /** The Settings toggle. `null` while still being read. */
  healthSyncOn: boolean | null;
  /** Whether the store holds heart rate in the recent past — `null` for "not
   *  known" (still probing, probe failed, or access declined). */
  healthHasRecentHR: boolean | null;
  /** Whether the probe has finished at all. False keeps the block on
   *  `'loading'` rather than flashing `'health_unknown'` for a moment and
   *  then correcting itself, which is the monotonic-screen rule
   *  `vo2MaxScreenState` already follows for its own two async reads. */
  healthProbeSettled: boolean;
};

export function hrPathState(input: HRPathInput): HRPathState {
  if (input.monitorName === undefined) return 'loading';
  // A paired monitor decides it outright: the live path is set up, and the
  // health store's state only ever ADDS to that (it fills gaps). No probe
  // needed, so this never waits on one.
  if (input.bluetoothSupported && input.monitorName !== null) return 'live';
  if (input.healthSource === null) return 'nothing';
  if (input.healthSyncOn === null) return 'loading';
  if (!input.healthSyncOn) return 'nothing';
  if (!input.healthProbeSettled) return 'loading';
  if (input.healthHasRecentHR === null) return 'health_unknown';
  return input.healthHasRecentHR ? 'health' : 'health_quiet';
}

/** The one-line answer to "which path am I on". */
export function hrPathHeadline(state: HRPathState, input: Pick<HRPathInput, 'monitorName' | 'healthSource'>): string | null {
  const label = input.healthSource ? healthSourceLabel(input.healthSource) : 'your health app';
  switch (state) {
    case 'loading':
      return null;
    case 'live':
      return `You're on "${hrPathName('live', label)}".`;
    case 'health':
    case 'health_quiet':
    case 'health_unknown':
      return `You're on "${hrPathName('health', label)}".`;
    case 'nothing':
      return 'No heart-rate path is set up.';
  }
}

/**
 * What that means for the next session, in one paragraph — including, for
 * the health path, whether the store actually has anything in it.
 *
 * The `'health_quiet'` sentence deliberately states an OBSERVATION and an
 * ACTION rather than a cause. On iOS `queryHeartRateSamples` returns `[]`
 * for a declined grant exactly as it does for an empty store (design doc
 * §5.1, and that function's own doc comment), so "nothing is writing to
 * Apple Health" would be an assertion this app cannot actually make.
 */
export function hrPathDetail(state: HRPathState, input: Pick<HRPathInput, 'monitorName' | 'healthSource'>): string | null {
  const label = input.healthSource ? healthSourceLabel(input.healthSource) : 'your health app';
  switch (state) {
    case 'loading':
      return null;
    case 'live':
      return (
        `${input.monitorName ?? 'Your monitor'} streams heart rate straight to VOLA while a run is on — no waiting, ` +
        `and it keeps going with the screen locked. ${label} still fills in any gaps afterwards.`
      );
    case 'health':
      return (
        `No monitor is paired, so VOLA reads each finished session's heart rate from ${label} once your wearable ` +
        `has written it there. ${label} has heart rate from the last day, so that route is working. It arrives on ` +
        `your wearable's own schedule — usually minutes, sometimes hours.`
      );
    case 'health_quiet':
      return (
        `No monitor is paired, so VOLA reads each finished session's heart rate from ${label}. VOLA found none ` +
        `there from the last day — open your wearable's own app to push its data, and check VOLA can read ` +
        `heart rate from ${label}. Until something writes there, a finished session has nothing to read.`
      );
    case 'health_unknown':
      return (
        `No monitor is paired, so VOLA reads each finished session's heart rate from ${label} once your wearable ` +
        `has written it there. VOLA couldn't check what ${label} holds right now — the read failed, or VOLA ` +
        `doesn't have permission to read heart rate from it.`
      );
    case 'nothing':
      return (
        `No monitor is paired and VOLA isn't reading from ${label}, so finished sessions will have no heart ` +
        `rate, no zones and no training load. Pair a monitor below, or switch ${label} sync on above.`
      );
  }
}

/**
 * The single most actionable thing an athlete on the health-store path can
 * be told, and nothing in the app said it — so it is its own line rather
 * than a clause buried in `hrPathDetail`.
 *
 * An Apple Watch (or any wearable) worn passively writes BACKGROUND heart
 * rate — one reading every few minutes. A workout STARTED ON THE WATCH
 * writes a continuous recording. VOLA reads the same window either way, so
 * the difference between a report worth having and the thin one W19/#985's
 * incident produced is entirely this gesture: the class that produced that
 * incident had 469 readings for its window, every one of them background,
 * and the class itself was never written at all.
 *
 * `null` for the live path — a paired monitor is already the dense
 * recording, so this would be noise.
 */
export function healthPathTip(state: HRPathState): string | null {
  if (state !== 'health' && state !== 'health_quiet' && state !== 'health_unknown') return null;
  return (
    'Worth knowing: start the workout on your watch as well as in VOLA. A watch that is merely worn writes a ' +
    'reading every few minutes; one that is recording writes a continuous one, and that is the difference ' +
    'between a heart-rate report worth reading and a thin one.'
  );
}

/**
 * The sentence that exists for the athlete whose scan finds nothing and who
 * would otherwise conclude the app is broken — shown in EVERY state, because
 * it is the thing nobody knows and the reason this ticket was filed.
 *
 * Named devices rather than a rule, because "does this watch implement the
 * GATT Heart Rate Service as a peripheral" is not a question an athlete can
 * answer about their own wrist. These four cover essentially every wearable
 * that will never appear in a scan.
 */
export function nonBroadcastingNote(sourceLabel: string): string {
  return (
    `Some wearables never broadcast heart rate to other apps, so a scan will never find them — Apple Watch, ` +
    `Fitbit, Oura, and most Samsung and Wear OS watches. That is how they are built, not a fault in VOLA or in ` +
    `the watch. VOLA reads those from ${sourceLabel} after the session instead, which is a supported way to ` +
    `train — it just is not live.`
  );
}

/**
 * The GENERIC broadcast guidance (this ticket's second criterion). The copy
 * this replaces named one watch — the Amazfit that produced N528 — which
 * read as "VOLA supports Amazfit" to everybody holding anything else.
 *
 * Brand rows are examples of ONE setting under different names, which is why
 * `BROADCAST_RULE` leads and the rows follow: VOLA does not check the brand,
 * so the athlete's job is to find whatever their watch calls "broadcast",
 * not to find their watch on a list. A device absent from these rows is not
 * unsupported.
 */
export const BROADCAST_RULE =
  'VOLA reads the standard Bluetooth heart-rate profile, the one every brand speaks — it never checks which ' +
  'watch or strap it is. So the only question is whether yours broadcasts. Most watches call the setting ' +
  '"broadcast heart rate", and many only broadcast while a workout is running on the watch itself.';

export type BroadcastStep = { device: string; how: string };

export const BROADCAST_STEPS: readonly BroadcastStep[] = [
  { device: 'Chest straps (Polar, Garmin, Wahoo, Coospo, Magene…)', how: 'Nothing to switch on — wet the electrodes, put it on, and it appears in a scan within seconds.' },
  { device: 'Garmin watches', how: 'Hold the controls button → Broadcast Heart Rate. Or Settings → Sensors & Accessories → Wrist Heart Rate → Broadcast During Activity.' },
  { device: 'Amazfit (Zepp)', how: 'Zepp app → Profile → your watch → Heart rate broadcasting. Then start a workout on the watch.' },
  { device: 'Polar watches', how: 'Settings → General settings → Broadcast heart rate.' },
  { device: 'Coros watches', how: 'Toolbox → Heart Rate Broadcast.' },
  { device: 'Suunto watches', how: 'Start a workout, then Connectivity → Broadcast HR.' },
  { device: 'Whoop', how: 'WHOOP app → your device → Broadcast Heart Rate.' },
] as const;
