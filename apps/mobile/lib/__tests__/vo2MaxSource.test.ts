import {
  healthSourceFor,
  healthSourceLabel,
  healthSyncSettingLabel,
  vo2MaxScreenState,
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

  it('treats an unanswered availability or sync read as not-yet-blocking', () => {
    // `null` means "still asking" — the screen falls through to the plain
    // empty state rather than asserting a gate it has not read yet.
    expect(vo2MaxScreenState({ ...base, sourceAvailable: null })).toBe('empty');
    expect(vo2MaxScreenState({ ...base, syncOn: null })).toBe('empty');
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
