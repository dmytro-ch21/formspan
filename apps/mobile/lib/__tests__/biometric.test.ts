/**
 * The pure half of the consolidated biometric-sync module (N477/#822 iOS,
 * N478/#823 Android, unified by N485/#837): the window-join (both the
 * simple session-window derivation and Health Connect's overlap clip), the
 * source classification, the upload-plan/hr_source decision, the HRmax
 * seed, and the Health Connect retry-ledger decisions. Deliberately not
 * testing the API client functions (`putBiometricSamples` etc.) beyond what
 * a mocked `apiRequest` proves about the request shape — see
 * `apiRequest.ts`'s own tests for the transport machinery itself.
 *
 * Absorbs what was `lib/__tests__/biometricEnrichment.test.ts` (N478) prior
 * to the consolidation — see `biometric.ts`'s own doc comment for the one
 * behavioral reconciliation this merge made (the out-of-range HRmax case:
 * `null`, never a clamp).
 */

import {
  HEALTH_CONNECT_HISTORY_WALL_DAYS,
  RETRY_COOLDOWN_HOURS,
  RETRY_WINDOW_DAYS,
  ageInYears,
  classifyHealthKitSource,
  heartRateSamplesInWindow,
  hrMaxFromDateOfBirth,
  isWithinHealthConnectHistoryWall,
  needsEnrichmentAttempt,
  planHRSync,
  selectEnrichmentCandidates,
  sessionHRWindow,
  toBiometricSample,
  type BiometricSample,
  type EnrichmentCandidate,
  type EnrichmentLedgerEntry,
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

  it('returns null for an unparseable date of birth rather than throwing', () => {
    expect(hrMaxFromDateOfBirth('not-a-date', new Date('2026-06-01T00:00:00Z'))).toBeNull();
  });
});

describe('heartRateSamplesInWindow', () => {
  const samples = [
    { time: '2026-09-01T06:59:00.000Z', beatsPerMinute: 60 }, // before window
    { time: '2026-09-01T07:00:00.000Z', beatsPerMinute: 90 }, // exactly at start
    { time: '2026-09-01T07:15:00.000Z', beatsPerMinute: 140 }, // inside
    { time: '2026-09-01T07:30:00.000Z', beatsPerMinute: 100 }, // exactly at end
    { time: '2026-09-01T07:31:00.000Z', beatsPerMinute: 70 }, // after window
  ];
  const start = '2026-09-01T07:00:00.000Z';
  const end = '2026-09-01T07:30:00.000Z';

  it('keeps only samples inside [start, end], inclusive of both boundaries', () => {
    expect(heartRateSamplesInWindow(samples, start, end)).toEqual([
      samples[1],
      samples[2],
      samples[3],
    ]);
  });

  it('clips a record whose interval merely OVERLAPS the window — the exact edge case this exists for', () => {
    // A HeartRateRecord returned by Health Connect's own time-range filter
    // can carry samples slightly outside the record's queried boundary
    // (design doc §2's "a session that spans midnight" class of edge case)
    // — this is what makes the window join EXACT rather than
    // approximately-the-window.
    expect(heartRateSamplesInWindow(samples, start, end)).not.toContainEqual(samples[0]);
    expect(heartRateSamplesInWindow(samples, start, end)).not.toContainEqual(samples[4]);
  });

  it('returns empty for an empty input', () => {
    expect(heartRateSamplesInWindow([], start, end)).toEqual([]);
  });

  it('returns empty for an unparseable window rather than throwing', () => {
    expect(heartRateSamplesInWindow(samples, 'not-a-date', end)).toEqual([]);
  });
});

describe('isWithinHealthConnectHistoryWall', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');

  it('is true for a session that started today', () => {
    expect(isWithinHealthConnectHistoryWall('2026-09-01T07:00:00.000Z', now)).toBe(true);
  });

  it(`is true for a session exactly ${HEALTH_CONNECT_HISTORY_WALL_DAYS} days ago`, () => {
    const started = new Date(now.getTime() - HEALTH_CONNECT_HISTORY_WALL_DAYS * 24 * 60 * 60 * 1000);
    expect(isWithinHealthConnectHistoryWall(started.toISOString(), now)).toBe(true);
  });

  it('is false for a session one day past the wall', () => {
    const started = new Date(
      now.getTime() - (HEALTH_CONNECT_HISTORY_WALL_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    expect(isWithinHealthConnectHistoryWall(started.toISOString(), now)).toBe(false);
  });

  it('is false for an unparseable date rather than throwing', () => {
    expect(isWithinHealthConnectHistoryWall('not-a-date', now)).toBe(false);
  });
});

describe('needsEnrichmentAttempt', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');

  it('is false for a session still in progress (no endedAt)', () => {
    expect(needsEnrichmentAttempt({ endedAt: null }, undefined, now)).toBe(false);
  });

  it('is true for a finished session with no ledger row at all — never attempted', () => {
    expect(needsEnrichmentAttempt({ endedAt: '2026-09-10T08:00:00.000Z' }, undefined, now)).toBe(true);
  });

  it("is false once real evidence ('window') has been recorded — terminal, never retried", () => {
    const ledger: EnrichmentLedgerEntry = { hrSource: 'window', attemptedAt: '2026-09-01T00:00:00.000Z' };
    expect(needsEnrichmentAttempt({ endedAt: '2026-09-01T08:00:00.000Z' }, ledger, now)).toBe(false);
  });

  it(`is true for a fresh 'none' result within the retry window and past the cooldown`, () => {
    const attemptedAt = new Date(
      now.getTime() - (RETRY_COOLDOWN_HOURS + 1) * 60 * 60 * 1000,
    ).toISOString();
    const ledger: EnrichmentLedgerEntry = { hrSource: 'none', attemptedAt };
    // Session ended well within RETRY_WINDOW_DAYS of `now`.
    expect(needsEnrichmentAttempt({ endedAt: '2026-09-09T08:00:00.000Z' }, ledger, now)).toBe(true);
  });

  it("is false for a 'none' result still inside its cooldown — do not hammer the API every foreground return", () => {
    const attemptedAt = new Date(
      now.getTime() - (RETRY_COOLDOWN_HOURS - 1) * 60 * 60 * 1000,
    ).toISOString();
    const ledger: EnrichmentLedgerEntry = { hrSource: 'none', attemptedAt };
    expect(needsEnrichmentAttempt({ endedAt: '2026-09-09T08:00:00.000Z' }, ledger, now)).toBe(false);
  });

  it(`is false for a 'none' result once the session is past RETRY_WINDOW_DAYS old — stop asking forever`, () => {
    const endedAt = new Date(
      now.getTime() - (RETRY_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    // Cooldown elapsed long ago too, so the ONLY thing that can be making
    // this false is the retry-window check — isolates the guard under test.
    const attemptedAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ledger: EnrichmentLedgerEntry = { hrSource: 'none', attemptedAt };
    expect(needsEnrichmentAttempt({ endedAt }, ledger, now)).toBe(false);
  });
});

describe('selectEnrichmentCandidates', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');

  function session(overrides: Partial<EnrichmentCandidate> = {}): EnrichmentCandidate {
    return {
      id: 's1',
      startedAt: '2026-09-10T07:00:00.000Z',
      endedAt: '2026-09-10T08:00:00.000Z',
      ...overrides,
    };
  }

  it('includes a fresh finished session within the history wall', () => {
    const result = selectEnrichmentCandidates([session()], new Map(), now);
    expect(result).toEqual([session()]);
  });

  it('excludes a session whose window starts past the 30-day Health Connect history wall', () => {
    const old = session({
      id: 'old',
      startedAt: new Date(
        now.getTime() - (HEALTH_CONNECT_HISTORY_WALL_DAYS + 5) * 24 * 60 * 60 * 1000,
      ).toISOString(),
      endedAt: new Date(
        now.getTime() - (HEALTH_CONNECT_HISTORY_WALL_DAYS + 5) * 24 * 60 * 60 * 1000 + 3_600_000,
      ).toISOString(),
    });
    expect(selectEnrichmentCandidates([old], new Map(), now)).toEqual([]);
  });

  it('excludes a session already carrying real (window) evidence', () => {
    const s = session({ id: 'done' });
    const ledger = new Map([['done', { hrSource: 'window' as const, attemptedAt: now.toISOString() }]]);
    expect(selectEnrichmentCandidates([s], ledger, now)).toEqual([]);
  });

  it('excludes a session still in progress', () => {
    const inProgress = session({ id: 'live', endedAt: null });
    expect(selectEnrichmentCandidates([inProgress], new Map(), now)).toEqual([]);
  });

  it('preserves input order across a mix of included and excluded sessions', () => {
    const a = session({ id: 'a', startedAt: '2026-09-10T06:00:00.000Z' });
    const excluded = session({ id: 'excluded', endedAt: null });
    const b = session({ id: 'b', startedAt: '2026-09-10T07:00:00.000Z' });
    expect(selectEnrichmentCandidates([a, excluded, b], new Map(), now)).toEqual([a, b]);
  });
});
