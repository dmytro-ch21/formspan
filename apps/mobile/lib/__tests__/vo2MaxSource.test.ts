import {
  LOOKBACK_SLACK_DAYS,
  SERVER_MAX_LIST_RANGE_DAYS,
  VO2MAX_FETCH_DAYS,
  healthSourceFor,
  healthSourceLabel,
  healthSyncSettingLabel,
  vo2MaxRowVisible,
  vo2MaxScreenState,
  vo2MaxFetchWindow,
  vo2MaxStateCopy,
} from '@/lib/vo2MaxSource';

/**
 * W16/#945 — the VO₂max screens decide what to show in one pure place.
 *
 * Nothing rendered can pin this: no test in the repo renders either VO₂max
 * screen, and under `jest-expo` `Platform.OS` is always `ios`, which is the
 * one platform on which the original bug did NOT show. So the platform is a
 * parameter here and the Android branch — the one that was wrong — is
 * exercised directly.
 */
describe('healthSourceFor — which source this device has', () => {
  it('is HealthKit on iOS only when the module is linked', () => {
    expect(healthSourceFor('ios', true)).toBe('healthkit');
    // An iOS build without HealthKit linked has NO source — the only case
    // in which "not available on this device" was ever true.
    expect(healthSourceFor('ios', false)).toBeNull();
  });

  it('is Health Connect on Android regardless of the HealthKit flag', () => {
    // The bug: Android was being judged by an iOS-only check. The flag is
    // meaningless there and must not be consulted.
    expect(healthSourceFor('android', false)).toBe('health_connect');
    expect(healthSourceFor('android', true)).toBe('health_connect');
  });

  it('is nothing on a platform with no health store', () => {
    expect(healthSourceFor('web', true)).toBeNull();
    expect(healthSourceFor('windows', false)).toBeNull();
  });
});

describe('the labels name the source the athlete actually has', () => {
  it('reads Apple Health / Health Connect', () => {
    expect(healthSourceLabel('healthkit')).toBe('Apple Health');
    expect(healthSourceLabel('health_connect')).toBe('Health Connect');
  });

  it("points at a Settings toggle that exists under exactly that name", () => {
    // Verbatim the `label` props in app/settings.tsx — a sentence that sends
    // the athlete to a switch called something else is a broken instruction.
    expect(healthSyncSettingLabel('healthkit')).toBe('Sync with Apple Health');
    expect(healthSyncSettingLabel('health_connect')).toBe('Sync with Health Connect');
  });
});

describe('vo2MaxScreenState — readings first, gates only when there is nothing to show', () => {
  const base = { loading: false, hasReadings: false, source: 'health_connect' as const, sourceAvailable: true, syncOn: true };

  it('shows the chart whenever readings exist, whatever the gates say', () => {
    // THE decision this ticket is about. Every gate below is set to the
    // value that would otherwise hide the screen, and none of them may.
    expect(vo2MaxScreenState({ ...base, hasReadings: true })).toBe('chart');
    expect(vo2MaxScreenState({ ...base, hasReadings: true, source: null })).toBe('chart');
    expect(vo2MaxScreenState({ ...base, hasReadings: true, sourceAvailable: false })).toBe('chart');
    expect(vo2MaxScreenState({ ...base, hasReadings: true, syncOn: false })).toBe('chart');
  });

  it('renders nothing while the first fetch is still settling — even with readings', () => {
    expect(vo2MaxScreenState({ ...base, loading: true })).toBe('loading');
    expect(vo2MaxScreenState({ ...base, loading: true, hasReadings: true })).toBe('loading');
  });

  it('says there is no source only when there genuinely is none', () => {
    expect(vo2MaxScreenState({ ...base, source: null })).toBe('no_source');
  });

  it('distinguishes a source this device cannot use from one that is switched off', () => {
    // An Android phone with no Health Connect provider: a true sentence
    // about the device, not about the athlete's settings.
    expect(vo2MaxScreenState({ ...base, sourceAvailable: false })).toBe('source_unavailable');
    // A usable source with the toggle off: point at the toggle.
    expect(vo2MaxScreenState({ ...base, syncOn: false })).toBe('sync_off');
  });

  it('keeps the spinner while an availability or sync read is still unanswered', () => {
    // `null` means "still asking". Review caught the first version falling
    // through to "nothing read yet" here, which then flipped to a different
    // sentence once the bridge replied — a screen that changes its mind is
    // worse than one that waits a moment. Monotonic: spinner until known.
    expect(vo2MaxScreenState({ ...base, sourceAvailable: null })).toBe('loading');
    expect(vo2MaxScreenState({ ...base, syncOn: null })).toBe('loading');
    // ...but only for the reads this source actually needs: HealthKit has no
    // async availability question, so a null there must not stall iOS.
    expect(vo2MaxScreenState({ ...base, source: 'healthkit', sourceAvailable: null })).toBe('empty');
  });

  it('shows the chart for readings ANYWHERE on the account, not only in the selected window', () => {
    // The reviewer's catch: the first version derived hasReadings from
    // `!series.empty`, which is also set for 'none-in-range' — fourteen
    // months of readings, a six-month default window, toggle off → the gate
    // fired and hid the chart AND the range picker. `hasReadings` is now the
    // server's answer over the whole fetch window; this pins that a caller
    // passing it correctly gets the chart even with every gate against it.
    expect(vo2MaxScreenState({ ...base, hasReadings: true, syncOn: false, sourceAvailable: false })).toBe('chart');
  });

  it('lets a FAILED fetch speak for itself rather than through a gate', () => {
    // Nothing is known when the fetch failed, so no gate may assert a grant
    // or a toggle state. 'empty' routes to the screen's own "Couldn't load"
    // sentence on the chart path.
    expect(vo2MaxScreenState({ ...base, fetchFailed: true, syncOn: false })).toBe('empty');
    expect(vo2MaxScreenState({ ...base, fetchFailed: true, source: null })).toBe('empty');
    // Readings still win over a failed re-fetch (stale data beats no data).
    expect(vo2MaxScreenState({ ...base, fetchFailed: true, hasReadings: true })).toBe('chart');
  });

  it('is empty when everything is on and nothing has been read', () => {
    expect(vo2MaxScreenState(base)).toBe('empty');
  });

  it('checks the gates in the order an athlete can act on them', () => {
    // No source outranks unavailable, which outranks sync-off: the first
    // is about the build, the second about the device, the third about a
    // setting — and only the last is something the athlete can change.
    expect(vo2MaxScreenState({ ...base, source: null, sourceAvailable: false, syncOn: false })).toBe('no_source');
    expect(vo2MaxScreenState({ ...base, sourceAvailable: false, syncOn: false })).toBe('source_unavailable');
  });
});

describe('vo2MaxStateCopy — true whenever it is on screen', () => {
  it('names the source the device has, never the other vendor', () => {
    expect(vo2MaxStateCopy('sync_off', 'health_connect')).toContain('Sync with Health Connect');
    expect(vo2MaxStateCopy('sync_off', 'health_connect')).not.toContain('Apple');
    expect(vo2MaxStateCopy('sync_off', 'healthkit')).toContain('Sync with Apple Health');
    expect(vo2MaxStateCopy('source_unavailable', 'health_connect')).toContain("Health Connect isn't available");
  });

  it('has nothing to say for the states that show data or nothing', () => {
    expect(vo2MaxStateCopy('chart', 'healthkit')).toBeNull();
    expect(vo2MaxStateCopy('loading', 'healthkit')).toBeNull();
    expect(vo2MaxStateCopy('empty', 'healthkit')).toBeNull();
  });

  it('keeps the original sentence for the one case it was always true in', () => {
    expect(vo2MaxStateCopy('no_source', null)).toBe("VO2max reading isn't available on this device.");
  });
});

describe('vo2MaxRowVisible — the You-tab row is data-first too', () => {
  it('shows the row on ANY device when the account has readings', () => {
    // Readings from a previous phone, or from the other platform on the same
    // account, are the athlete's regardless of what this handset can read.
    // This is the case the AC verifier caught the first version missing.
    expect(vo2MaxRowVisible({ hasReadings: true, source: null })).toBe(true);
    expect(vo2MaxRowVisible({ hasReadings: true, source: 'healthkit' })).toBe(true);
  });

  it('shows the row whenever the device has a source, so the screen can explain itself', () => {
    expect(vo2MaxRowVisible({ hasReadings: false, source: 'health_connect' })).toBe(true);
    expect(vo2MaxRowVisible({ hasReadings: false, source: 'healthkit' })).toBe(true);
  });

  it('hides it only with no readings AND no source', () => {
    // An iOS build with no HealthKit linked, for an athlete who has never
    // had a reading uploaded — the one case there is genuinely nothing.
    expect(vo2MaxRowVisible({ hasReadings: false, source: null })).toBe(false);
  });
});


/**
 * The fetch window — the two properties the server enforces and no rendered
 * test can see, because an absent server fails exactly like a refused one.
 */
describe('vo2MaxFetchWindow — what the samples endpoint will actually accept', () => {
  const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const spanDays = (w: { from: string; to: string }) =>
    (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;

  it('emits RFC3339 with a time component on BOTH bounds', () => {
    // The You screen's first fetch sent `YYYY-MM-DD` and got a 400 from
    // `time.Parse(time.RFC3339, …)` on every call — swallowed, so the row's
    // "account has readings" branch was dead code behind a green test.
    const w = vo2MaxFetchWindow('2026-09-08');
    expect(w.from).toMatch(RFC3339);
    expect(w.to).toMatch(RFC3339);
    expect(w.to).toBe('2026-09-08T23:59:59Z');
  });

  it('never spans more than the server cap, tail included', () => {
    // `useVo2MaxTrend` asked for 365*3 + 14 days; the server caps at 400 and
    // refused every request the trend screen ever made. The `to` bound sits
    // at 23:59:59, so the span is a day less than whole days would suggest.
    const w = vo2MaxFetchWindow('2026-09-08');
    expect(spanDays(w)).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
    expect(spanDays(w)).toBeGreaterThan(SERVER_MAX_LIST_RANGE_DAYS - 3);
  });

  it('clamps a caller that asks for more than the cap allows', () => {
    // The old three-year request, made against the helper, is silently
    // narrowed rather than refused by the server.
    const w = vo2MaxFetchWindow('2026-09-08', 365 * 3);
    expect(spanDays(w)).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
  });

  it('adds the lookback slack on top of the requested window', () => {
    const w = vo2MaxFetchWindow('2026-09-08', 30);
    expect(w.from).toBe(`2026-${String(7).padStart(2, '0')}-${String(26).padStart(2, '0')}T00:00:00Z`);
    expect(30 + LOOKBACK_SLACK_DAYS).toBe(44);
  });

  it('keeps the default within the cap by construction', () => {
    expect(VO2MAX_FETCH_DAYS + LOOKBACK_SLACK_DAYS).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
  });
});
