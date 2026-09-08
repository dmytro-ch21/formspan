/**
 * Where an athlete's VO₂max readings come FROM on this device, and what the
 * VO₂max screens should therefore say — decided in one place, purely, so the
 * two screens that show it cannot disagree (W16, #945).
 *
 * ## The bug this exists to prevent recurring
 *
 * `app/(tabs)/you.tsx` hid the VO₂max row behind `isHealthKitSupported()`,
 * and `app/vo2max/trend.tsx` told an athlete on the other side of that gate
 * "VO₂max reading isn't available on this device." Both were written for
 * iOS and both were false on Android: `lib/healthConnectSync.ts` uploads
 * VO₂max from Health Connect on every sync pass, the backend's `ListSamples`
 * has no platform filter (`WHERE user_id AND metric_type AND measured_at…`,
 * read directly), and `useVo2MaxTrend` fetches from that endpoint — so the
 * readings were on the server, the hook would have returned them, and a
 * vendor-SDK check hid them behind copy that named the wrong vendor. The
 * app was contradicting itself about data it held: the W2/W4 shape.
 *
 * ## Readings first, and that is the whole decision
 *
 * `vo2MaxScreenState` puts `hasReadings` above every gate except `loading`.
 * If the server has readings for this athlete, the screen shows them — no
 * check of which SDK is linked, which provider is installed, or whether a
 * sync toggle is currently on is allowed to hide data the athlete has. The
 * gates only decide what to SAY when there is nothing to show, and each
 * message names the source this device actually has, so the copy is true
 * whenever it is on screen (the ticket's second criterion).
 *
 * ## Platform as a parameter, never read here
 *
 * Same convention as `lib/tabIconPlan.ts` and `lib/tabBarChrome.ts`:
 * `jest-expo` reports `ios`, so a module that read `Platform.OS` itself
 * would leave the Android branch — the one that was wrong — permanently
 * untested. The screens pass it in.
 *
 * ## What "source" means, and why Android is unconditional here
 *
 * On iOS the source exists only if the HealthKit module is linked into this
 * binary (`isHealthKitSupported()` — sync, answered at module load). On
 * Android the source is Health Connect, and whether the provider is
 * actually installed is a separate, ASYNC question (`isHealthConnectSupported`)
 * that the trend screen answers in words via `sourceAvailable` rather than
 * by hiding the row. That is deliberate: `you.tsx`'s own comment on the row
 * cites N61 — an athlete cannot tell "not enabled" from "not built" when the
 * entry point disappears — and the fix for that is a sentence, not an
 * absence. A row that opens to "Health Connect isn't available on this
 * device" is a true statement the athlete can act on; a missing row is not.
 */

export type HealthSource = 'healthkit' | 'health_connect';

/** Which health data source this device has, if any. `healthKitLinked` is
 *  `isHealthKitSupported()` — meaningful only on iOS, ignored elsewhere. */
export function healthSourceFor(platform: string, healthKitLinked: boolean): HealthSource | null {
  if (platform === 'ios') return healthKitLinked ? 'healthkit' : null;
  if (platform === 'android') return 'health_connect';
  return null;
}

/** The name the athlete knows the source by. */
export function healthSourceLabel(source: HealthSource): string {
  return source === 'healthkit' ? 'Apple Health' : 'Health Connect';
}

/** The Settings toggle that turns reading from this source on — verbatim the
 *  `label` on each `<Toggle>` in `app/settings.tsx`, so the copy points at a
 *  switch that exists under exactly that name. */
export function healthSyncSettingLabel(source: HealthSource): string {
  return source === 'healthkit' ? 'Sync with Apple Health' : 'Sync with Health Connect';
}

export type Vo2MaxScreenState =
  /** First fetch not settled — render nothing rather than an absence. */
  | 'loading'
  /** The server has readings: show them, whatever the gates say. */
  | 'chart'
  /** This device has no health source at all (an iOS build with no HealthKit linked; web). */
  | 'no_source'
  /** The source exists in principle but is not usable here (Android with no Health Connect provider). */
  | 'source_unavailable'
  /** A usable source, but the athlete has not turned reading from it on. */
  | 'sync_off'
  /** Everything is on and nothing has been read yet. */
  | 'empty';

export function vo2MaxScreenState(input: {
  loading: boolean;
  hasReadings: boolean;
  source: HealthSource | null;
  /** Only meaningful when `source` is set. `null` while still being asked. */
  sourceAvailable: boolean | null;
  /** `null` while still being read. */
  syncOn: boolean | null;
}): Vo2MaxScreenState {
  if (input.loading) return 'loading';
  // Data the athlete has beats every gate below — see the file comment.
  if (input.hasReadings) return 'chart';
  if (input.source === null) return 'no_source';
  if (input.sourceAvailable === false) return 'source_unavailable';
  if (input.syncOn === false) return 'sync_off';
  return 'empty';
}

/** The sentence for each no-data state, naming the source this device has. */
export function vo2MaxStateCopy(state: Vo2MaxScreenState, source: HealthSource | null): string | null {
  switch (state) {
    case 'no_source':
      return "VO2max reading isn't available on this device.";
    case 'source_unavailable':
      return source
        ? `${healthSourceLabel(source)} isn't available on this device, so there is nothing to read VO2max from.`
        : "VO2max reading isn't available on this device.";
    case 'sync_off':
      return source
        ? `Turn on "${healthSyncSettingLabel(source)}" in Settings to read your VO2max trend from a watch or another device that estimates it.`
        : null;
    default:
      return null;
  }
}
