/**
 * The pure half of the biometric enrichment feature (N477/#822): the
 * window-join, the source classification, the upload-plan/hr_source
 * decision, and the HRmax seed. Deliberately not testing the API client
 * functions (`putBiometricSamples` etc.) beyond what a mocked `apiRequest`
 * proves about the request shape — see `apiRequest.ts`'s own tests for the
 * transport machinery itself.
 */

import {
  ageInYears,
  classifyHealthKitSource,
  hrMaxFromDateOfBirth,
  planHRSync,
  sessionHRWindow,
  toBiometricSample,
  type BiometricSample,
  type RawQuantitySample,
} from '../biometric';

function raw(overrides: Partial<RawQuantitySample> = {}): RawQuantitySample {
  return {
    uuid: 'sample-1',
    value: 142,
    unit: 'count/min',
    measuredAt: '2026-09-01T07:15:00.000Z',
    sourceName: 'Watch',
    sourceBundleId: 'com.apple.health.watch',
    ...overrides,
  };
}

describe('sessionHRWindow', () => {
  it('returns the started_at/ended_at window as Dates', () => {
    const win = sessionHRWindow('2026-09-01T07:00:00Z', '2026-09-01T07:30:00Z');
    expect(win).not.toBeNull();
    expect(win?.start.toISOString()).toBe('2026-09-01T07:00:00.000Z');
    expect(win?.end.toISOString()).toBe('2026-09-01T07:30:00.000Z');
  });

  it('returns null for a session with no ended_at (still in progress)', () => {
    expect(sessionHRWindow('2026-09-01T07:00:00Z', null)).toBeNull();
    expect(sessionHRWindow('2026-09-01T07:00:00Z', undefined)).toBeNull();
  });

  it('returns null when ended_at precedes started_at', () => {
    expect(sessionHRWindow('2026-09-01T07:30:00Z', '2026-09-01T07:00:00Z')).toBeNull();
  });

  it('returns null for an unparseable date rather than throwing', () => {
    expect(sessionHRWindow('not-a-date', '2026-09-01T07:30:00Z')).toBeNull();
  });

  it('accepts a zero-length window (started and ended in the same instant)', () => {
    const win = sessionHRWindow('2026-09-01T07:00:00Z', '2026-09-01T07:00:00Z');
    expect(win).not.toBeNull();
    expect(win?.start.getTime()).toBe(win?.end.getTime());
  });
});

describe('classifyHealthKitSource', () => {
  it('recognises Whoop by name or bundle id', () => {
    expect(classifyHealthKitSource('Whoop', 'com.whoop.iphone')).toBe('whoop');
    expect(classifyHealthKitSource('Some App', 'com.whoop.iphone')).toBe('whoop');
  });

  it('recognises Oura', () => {
    expect(classifyHealthKitSource('Oura', 'com.ouraring.oura')).toBe('oura');
  });

  it('recognises Garmin Connect', () => {
    expect(classifyHealthKitSource('Garmin Connect', 'com.garmin.connect.mobile')).toBe('garmin');
  });

  it('is case-insensitive', () => {
    expect(classifyHealthKitSource('WHOOP', 'COM.WHOOP.IPHONE')).toBe('whoop');
  });

  it('falls back to apple_watch for the Health app and an unrecognised device alike', () => {
    // The documented, accepted approximation — see this function's own doc
    // comment on why `biometric.Source` has no "unknown" slot to fall back
    // to instead.
    expect(classifyHealthKitSource('Health', 'com.apple.health')).toBe('apple_watch');
    expect(classifyHealthKitSource('Some Unheard-Of Strap', 'com.example.strap')).toBe('apple_watch');
  });
});

describe('toBiometricSample', () => {
  it('carries the native uuid through as the wire id, for idempotent retries', () => {
    const s = toBiometricSample(raw({ uuid: 'abc-123' }), 'heart_rate', 'healthkit');
    expect(s.id).toBe('abc-123');
  });

  it('maps value, unit and measured_at straight through', () => {
    const s = toBiometricSample(
      raw({ value: 168, unit: 'count/min', measuredAt: '2026-09-01T07:15:30.000Z' }),
      'heart_rate',
      'healthkit',
    );
    expect(s.value).toBe(168);
    expect(s.unit).toBe('count/min');
    expect(s.measured_at).toBe('2026-09-01T07:15:30.000Z');
  });

  it('stamps the metric_type and source_platform the caller asked for', () => {
    const s = toBiometricSample(raw(), 'vo2_max', 'healthkit');
    expect(s.metric_type).toBe('vo2_max');
    expect(s.source_platform).toBe('healthkit');
  });

  it('classifies the source from the raw sample', () => {
    const s = toBiometricSample(raw({ sourceName: 'Whoop', sourceBundleId: 'com.whoop.iphone' }), 'heart_rate', 'healthkit');
    expect(s.source).toBe('whoop');
  });
});

describe('planHRSync', () => {
  it('given zero samples, plans a compute-only pass claiming window', () => {
    const plan = planHRSync([]);
    expect(plan).toEqual({ kind: 'compute-only', hrSource: 'window' });
  });

  it('given one or more samples, plans to upload them and then compute, claiming window', () => {
    const samples: BiometricSample[] = [toBiometricSample(raw(), 'heart_rate', 'healthkit')];
    const plan = planHRSync(samples);
    expect(plan.kind).toBe('upload-and-compute');
    expect(plan.hrSource).toBe('window');
    if (plan.kind === 'upload-and-compute') {
      expect(plan.samples).toBe(samples);
    }
  });

  it('never plans to claim workout — this ticket builds no anchor refinement', () => {
    expect(planHRSync([]).hrSource).not.toBe('workout');
    expect(planHRSync([toBiometricSample(raw(), 'heart_rate', 'healthkit')]).hrSource).not.toBe('workout');
  });
});

describe('ageInYears', () => {
  it('counts a whole year once the birthday this year has passed', () => {
    expect(ageInYears('1990-01-01', new Date('2026-06-01T00:00:00Z'))).toBe(36);
  });

  it('does not count this year until the birthday has actually happened', () => {
    expect(ageInYears('1990-12-31', new Date('2026-06-01T00:00:00Z'))).toBe(35);
  });

  it('counts the birthday itself as the new age', () => {
    expect(ageInYears('1990-06-01', new Date('2026-06-01T00:00:00Z'))).toBe(36);
  });
});

describe('hrMaxFromDateOfBirth', () => {
  it('seeds 220 minus age', () => {
    expect(hrMaxFromDateOfBirth('1990-01-01', new Date('2026-06-01T00:00:00Z'))).toBe(220 - 36);
  });

  it('returns null with no date of birth', () => {
    expect(hrMaxFromDateOfBirth(null, new Date())).toBeNull();
    expect(hrMaxFromDateOfBirth(undefined, new Date())).toBeNull();
  });

  it('returns null when the seed falls outside what the server accepts (implausibly old)', () => {
    // 220 - 130 = 90, below MIN_HR_MAX_BPM (100).
    expect(hrMaxFromDateOfBirth('1896-01-01', new Date('2026-06-01T00:00:00Z'))).toBeNull();
  });

  it('returns null for a birth date in the future (age <= 0)', () => {
    expect(hrMaxFromDateOfBirth('2030-01-01', new Date('2026-06-01T00:00:00Z'))).toBeNull();
  });
});
