import {
  BROADCAST_RULE,
  BROADCAST_STEPS,
  hrPathDetail,
  hrPathHeadline,
  hrPathName,
  hrPathState,
  healthPathTip,
  nonBroadcastingNote,
  type HRPathInput,
} from '../hrPath';

/**
 * N552/#1021 — which of the two heart-rate paths the athlete is on, and what
 * Settings says about it.
 *
 * Every fixture is a LITERAL rather than something derived from the module
 * under test — the mistake W19's first coverage tests made, where fixtures
 * built from the constants they were pinning left all three constants
 * mutable at 166/166 green.
 */

const base: HRPathInput = {
  bluetoothSupported: true,
  monitorName: null,
  healthSource: 'healthkit',
  healthSyncOn: true,
  healthHasRecentHR: true,
  healthProbeSettled: true,
};

const at = (over: Partial<HRPathInput>): HRPathInput => ({ ...base, ...over });

describe('hrPathState', () => {
  it('says nothing until the remembered-monitor read answers', () => {
    expect(hrPathState(at({ monitorName: undefined }))).toBe('loading');
  });

  it('a paired monitor is the live path, and does not wait on the health probe', () => {
    expect(hrPathState(at({ monitorName: 'Polar H10' }))).toBe('live');
    // The whole point of not waiting: a paired athlete pays for no probe, so
    // an unsettled one must not hold the block on 'loading'.
    expect(
      hrPathState(at({ monitorName: 'Polar H10', healthProbeSettled: false, healthHasRecentHR: null })),
    ).toBe('live');
    // ...and it is still 'live' when the health store is off entirely.
    expect(hrPathState(at({ monitorName: 'Polar H10', healthSyncOn: false }))).toBe('live');
  });

  it('a remembered monitor on a build with no Bluetooth is NOT the live path', () => {
    // The pairing survives in SQLite; the radio does not survive the build.
    // Claiming 'live' here would promise a stream nothing can open.
    expect(hrPathState(at({ monitorName: 'Polar H10', bluetoothSupported: false }))).toBe('health');
  });

  it('no monitor and a working health store is the health path', () => {
    expect(hrPathState(at({}))).toBe('health');
    expect(hrPathState(at({ healthSource: 'health_connect' }))).toBe('health');
  });

  it('a health store with nothing recent in it is called out separately', () => {
    expect(hrPathState(at({ healthHasRecentHR: false }))).toBe('health_quiet');
  });

  it('a probe that could not answer is "unknown", never "quiet"', () => {
    // These are genuinely different situations — "we looked and found none"
    // versus "we could not look" — and collapsing them is the W15/#954
    // mistake (a refused read reported as no data).
    expect(hrPathState(at({ healthHasRecentHR: null }))).toBe('health_unknown');
  });

  it('waits for the probe rather than flashing "unknown" and correcting itself', () => {
    expect(hrPathState(at({ healthProbeSettled: false, healthHasRecentHR: null }))).toBe('loading');
  });

  it('waits for the sync-toggle read too', () => {
    expect(hrPathState(at({ healthSyncOn: null }))).toBe('loading');
  });

  it('no monitor and no route into a health store is no path at all', () => {
    expect(hrPathState(at({ healthSyncOn: false }))).toBe('nothing');
    expect(hrPathState(at({ healthSource: null }))).toBe('nothing');
    // No health store on this device: decided without waiting on a toggle
    // read that will never be relevant.
    expect(hrPathState(at({ healthSource: null, healthSyncOn: null }))).toBe('nothing');
  });
});

describe('hrPathName', () => {
  it('names the two paths, and the health one carries the store', () => {
    expect(hrPathName('live', 'Apple Health')).toBe('Live over Bluetooth');
    expect(hrPathName('health', 'Apple Health')).toBe('From Apple Health afterwards');
    expect(hrPathName('health', 'Health Connect')).toBe('From Health Connect afterwards');
  });
});

describe('what Settings actually says', () => {
  const states = ['live', 'health', 'health_quiet', 'health_unknown', 'nothing'] as const;

  it('every non-loading state has both a headline and a detail', () => {
    for (const s of states) {
      expect(hrPathHeadline(s, { monitorName: 'Polar H10', healthSource: 'healthkit' })).toBeTruthy();
      expect(hrPathDetail(s, { monitorName: 'Polar H10', healthSource: 'healthkit' })).toBeTruthy();
    }
  });

  it('loading says nothing at all, rather than a placeholder', () => {
    expect(hrPathHeadline('loading', { monitorName: undefined, healthSource: 'healthkit' })).toBeNull();
    expect(hrPathDetail('loading', { monitorName: undefined, healthSource: 'healthkit' })).toBeNull();
  });

  it('names the store this device actually has, never the other one', () => {
    // W16/#945's rule, applied here: an Android phone must never be told
    // about Apple Health. Checked on every state that mentions a store.
    for (const s of states) {
      const android = `${hrPathHeadline(s, { monitorName: null, healthSource: 'health_connect' })} ${hrPathDetail(s, {
        monitorName: null,
        healthSource: 'health_connect',
      })}`;
      expect(android).not.toContain('Apple Health');
      const ios = `${hrPathHeadline(s, { monitorName: null, healthSource: 'healthkit' })} ${hrPathDetail(s, {
        monitorName: null,
        healthSource: 'healthkit',
      })}`;
      expect(ios).not.toContain('Health Connect');
    }
  });

  it('the live detail names the monitor, and survives one with no name', () => {
    expect(hrPathDetail('live', { monitorName: 'Polar H10', healthSource: 'healthkit' })).toContain('Polar H10');
    expect(hrPathDetail('live', { monitorName: null, healthSource: 'healthkit' })).toContain('Your monitor');
  });

  it('"quiet" states an observation and an action, never a cause', () => {
    const quiet = hrPathDetail('health_quiet', { monitorName: null, healthSource: 'healthkit' }) ?? '';
    // On iOS a declined grant and an empty store are indistinguishable
    // (`queryHeartRateSamples` returns `[]` for both), so this sentence may
    // not assert that nothing is writing.
    expect(quiet).toContain('found none');
    expect(quiet).not.toMatch(/nothing is writing|no wearable|you have no/i);
  });
});

describe('the non-broadcasting note — the reason this ticket exists', () => {
  const note = nonBroadcastingNote('Apple Health');

  it.each(['Apple Watch', 'Fitbit', 'Oura', 'Wear OS'])('names %s, so a scan that finds nothing is explained', (device) => {
    expect(note).toContain(device);
  });

  it('says the scan cannot find them, and points at the other path', () => {
    expect(note).toContain('scan will never find them');
    expect(note).toContain('Apple Health');
  });

  it('does not read as a fault or as an unsupported device', () => {
    expect(note).toMatch(/not a fault/i);
    expect(note).toMatch(/supported way/i);
  });
});

describe('broadcast guidance is generic, which is the second criterion', () => {
  it('leads with the rule that the brand is not checked', () => {
    expect(BROADCAST_RULE).toMatch(/standard Bluetooth heart-rate profile/i);
    expect(BROADCAST_RULE).toMatch(/never checks which/i);
  });

  it('covers more than the one watch the old copy named', () => {
    // The defect: the shipped copy named the Amazfit that produced N528 and
    // nothing else, which read as "VOLA supports Amazfit".
    const devices = BROADCAST_STEPS.map((s) => s.device.toLowerCase()).join(' | ');
    for (const vendor of ['garmin', 'polar', 'coros', 'suunto', 'whoop', 'amazfit', 'chest strap']) {
      expect(devices).toContain(vendor);
    }
    expect(BROADCAST_STEPS.length).toBeGreaterThanOrEqual(6);
  });

  it('every row actually says what to do', () => {
    for (const step of BROADCAST_STEPS) {
      expect(step.how.length).toBeGreaterThan(20);
    }
  });
});

describe('healthPathTip — the one gesture that changes the report', () => {
  it('is offered on every health-path state and on none of the others', () => {
    for (const s of ['health', 'health_quiet', 'health_unknown'] as const) {
      expect(healthPathTip(s)).toBeTruthy();
    }
    // A paired monitor is already the dense recording; saying this there
    // would be noise, and 'nothing'/'loading' have a different problem.
    expect(healthPathTip('live')).toBeNull();
    expect(healthPathTip('nothing')).toBeNull();
    expect(healthPathTip('loading')).toBeNull();
  });

  it('says to start the workout on the watch, which is the actionable half', () => {
    const tip = healthPathTip('health') ?? '';
    expect(tip).toMatch(/start the workout on your watch/i);
    expect(tip).toMatch(/every few minutes/);
  });
});
