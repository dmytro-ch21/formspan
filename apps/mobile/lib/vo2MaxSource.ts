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

import { shiftDate } from './anthropometry';

export type HealthSource = 'healthkit' | 'health_connect';

/**
 * -----------------------------------------------------------------------
 * The fetch window — ONE definition, because two callers built their own
 * and both were wrong in ways no test could see
 * -----------------------------------------------------------------------
 *
 * `GET /v1/biometric/samples` parses `from`/`to` as RFC3339 and refuses a
 * span over `maxListRangeDays` — 400, read from
 * `backend/internal/modules/biometric/handler.go`, not assumed. Two things
 * were true before this helper existed, and review found both:
 *
 * - `useVo2MaxTrend` asked for THREE YEARS plus slack (1,109 days). Every
 *   VO₂max trend fetch this app has ever made was refused with a 400,
 *   `apiRequest` threw, the hook's catch set `failed`, and the screen showed
 *   "Couldn't load…" — on every load, for every athlete, since N477. The
 *   chart this ticket exists to show had never rendered on any platform.
 * - The You screen's own fetch (added for this ticket) passed date-only
 *   strings, which `time.Parse(time.RFC3339, …)` refuses outright. Its catch
 *   swallowed the 400 and the "account has readings" branch was dead code
 *   behind a green test, because the test did not mock the network and an
 *   absent server fails exactly like an absent reading.
 *
 * So the window is built here, once: the span is clamped so `to - from`
 * stays strictly under the cap even with the end-of-day tail, and both
 * bounds carry a time component. Pure, so both properties are pinned by a
 * test rather than by a server that only answers on a device.
 */

/** `maxListRangeDays` in the backend's ListSamples handler. If that constant
 *  moves, this one must follow — the test below pins the arithmetic, not the
 *  number's truth, which only the server knows. */
export const SERVER_MAX_LIST_RANGE_DAYS = 400;

/** Slack past the visible window, for parity with `useWeightTrend.ts` —
 *  see `useVo2MaxTrend.ts`'s own note on why it is kept. */
export const LOOKBACK_SLACK_DAYS = 14;

/** The most the trend screen may ask for: the server cap, less the slack the
 *  helper adds back, less one day for the `T23:59:59Z` tail on `to`. Was
 *  `365 * 3`, which is how every fetch came back 400. */
export const VO2MAX_FETCH_DAYS = SERVER_MAX_LIST_RANGE_DAYS - LOOKBACK_SLACK_DAYS - 1;

/**
 * `[from, to]` for a VO₂max samples fetch ending today, as the RFC3339 strings
 * the endpoint requires. `windowDays` is clamped to `VO2MAX_FETCH_DAYS` — a
 * caller cannot ask for a span the server will refuse.
 */
export function vo2MaxFetchWindow(
  today: string,
  windowDays: number = VO2MAX_FETCH_DAYS,
): { from: string; to: string } {
  const days = Math.max(0, Math.min(windowDays, VO2MAX_FETCH_DAYS));
  const from = shiftDate(today, -(days + LOOKBACK_SLACK_DAYS));
  return { from: `${from}T00:00:00Z`, to: `${today}T23:59:59Z` };
}

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
  /**
   * Whether the SERVER returned any VO₂max sample for this athlete at all —
   * `samples.length > 0` from `useVo2MaxTrend`, over its whole fetch window.
   *
   * NOT `!series.empty`. That was the first version, and review caught it as
   * this ticket's own bug in a narrower shape: `series.empty` is also set
   * for `'none-in-range'` (readings exist, none fall in the selected
   * window) and `'unavailable'` (the fetch failed), so an athlete with
   * fourteen months of readings opening the default six-month view with the
   * toggle now off had `hasReadings === false`, hit the `sync_off` gate, and
   * lost the chart AND the range picker they would have needed to see the
   * data they have. "Has readings" means the account has readings, not that
   * the current window has enough of them to draw.
   */
  hasReadings: boolean;
  /** The fetch itself failed — nothing is known, so no gate may speak. */
  fetchFailed?: boolean;
  source: HealthSource | null;
  /** Only meaningful when `source` is set. `null` while still being asked. */
  sourceAvailable: boolean | null;
  /** `null` while still being read. */
  syncOn: boolean | null;
}): Vo2MaxScreenState {
  if (input.loading) return 'loading';
  // Data the athlete has beats every gate below — see the file comment.
  if (input.hasReadings) return 'chart';
  // A failed fetch is not "no data": the screen's own `'unavailable'` empty
  // copy ("Couldn't load…") is the true sentence, and it lives on the chart
  // path, so fall through to it rather than let a gate assert something
  // about a grant or a toggle that this pass never got far enough to test.
  if (input.fetchFailed) return 'empty';
  if (input.source === null) return 'no_source';
  // The two async reads below are `null` until answered. While either is,
  // keep showing the spinner rather than a sentence that may flip a moment
  // later — a monotonic screen, not one that says "nothing read yet" and
  // then "Health Connect isn't available" once the bridge replies.
  if (input.source === 'health_connect' && input.sourceAvailable === null) return 'loading';
  if (input.sourceAvailable === false) return 'source_unavailable';
  if (input.syncOn === null) return 'loading';
  if (input.syncOn === false) return 'sync_off';
  return 'empty';
}

/**
 * Whether the VO₂max row on the You tab is shown at all.
 *
 * Readings first, same rule as the screen: an account with readings shows
 * the row on ANY device — the readings came from a previous phone, or from
 * the other platform on the same account, and they are the athlete's
 * regardless of what this handset can read from. Otherwise the row shows
 * whenever this device has a health source, so the trend screen can explain
 * itself in words (its own N61 reasoning) rather than the feature vanishing.
 * The one case that hides it: no readings AND no source — an iOS build with
 * no HealthKit linked, for an athlete who has never had a reading uploaded.
 */
export function vo2MaxRowVisible(input: { hasReadings: boolean; source: HealthSource | null }): boolean {
  return input.hasReadings || input.source !== null;
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
