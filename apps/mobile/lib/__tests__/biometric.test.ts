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
  SAMPLES_PER_SYNC_REQUEST,
  ageInYears,
  chunkSamples,
  classifyHealthKitSource,
  coverageFromLedger,
  heartRateSamplesInWindow,
  hrMaxFromDateOfBirth,
  hrSampleCoverage,
  isWithinHealthConnectHistoryWall,
  needsEnrichmentAttempt,
  planHRSync,
  putBiometricSamples,
  selectEnrichmentCandidates,
  sessionHRWindow,
  toBiometricSample,
  type BiometricSample,
  type EnrichmentCandidate,
  type EnrichmentLedgerEntry,
  type RawQuantitySample,
} from '../biometric';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

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

/**
 * W19/#985 — the coverage rule. Every boundary below is pinned to the
 * constants rather than to a literal, so a retune moves the fixture with the
 * rule and a MUTATION of the constant moves only one of the two and fails.
 * That is the point: see CLAUDE.md's "Verify that a check can fail" — the
 * mutation results for each of these three constants are recorded in this
 * ticket's `docs/decisions/history.md` entry.
 */
describe('hrSampleCoverage (W19/#985)', () => {
  const MINUTE = 60_000;
  const T0 = new Date('2026-09-08T22:41:48.000Z').getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  /** Readings once a minute across `[from, to]`, inclusive of both ends. */
  function everyMinute(from: number, to: number): string[] {
    const out: string[] = [];
    for (let t = from; t <= to; t += MINUTE) out.push(iso(t));
    return out;
  }

  /**
   * **Every fixture below is a LITERAL, and that is the whole point.**
   *
   * A first version of these tests derived the hole size and the last
   * reading's offset FROM the constants — which reads beautifully and cannot
   * fail: mutate `HR_COVERAGE_MIN_FRACTION` and the fixture moves with it, so
   * the assertion holds against the mutated rule. Measured, not argued: six
   * mutations (all three constants, both directions) survived that version
   * with 166/166 green. See CLAUDE.md's "Verify that a check can fail".
   *
   * So the arithmetic is spelled out in each comment instead, and the numbers
   * are fixed. Retuning a constant deliberately therefore breaks these — which
   * is exactly the alarm that was missing.
   */

  const D = 100 * MINUTE;

  it('is plausible exactly AT the covered-fraction bar — the bar is inclusive', () => {
    // 100-minute window, read once a minute except for a 31-minute hole.
    // Covered = 34 (first block) + 6 (the hole, capped at HR_COVERAGE_MAX_GAP_MS)
    //         + 35 (second block) = 75 of 100 minutes = 0.75 exactly.
    const times = [...everyMinute(T0, T0 + 34 * MINUTE), ...everyMinute(T0 + 65 * MINUTE, T0 + D)];
    expect(hrSampleCoverage(iso(T0), iso(T0 + D), times)).toBe('plausible');
  });

  it('is thin one minute of coverage BELOW the bar — nothing else about the window differs', () => {
    // The same window with a 32-minute hole: 34 + 6 + 34 = 74 of 100 = 0.74.
    const times = [...everyMinute(T0, T0 + 34 * MINUTE), ...everyMinute(T0 + 66 * MINUTE, T0 + D)];
    expect(hrSampleCoverage(iso(T0), iso(T0 + D), times)).toBe('thin');
  });

  it('is plausible when the last reading sits exactly ON the trailing-gap bar', () => {
    // Last reading 10 minutes before the window ends. Covered is 96 of 100
    // here, far clear of the fraction bar, so the trailing-gap rule is the
    // only thing this pair can be measuring.
    const times = everyMinute(T0, T0 + 90 * MINUTE);
    expect(hrSampleCoverage(iso(T0), iso(T0 + D), times)).toBe('plausible');
  });

  it('is thin one minute past the trailing-gap bar', () => {
    // Last reading 11 minutes before the end. Still 95 of 100 covered, so the
    // fraction rule would pass this — the gap rule is what refuses it.
    const times = everyMinute(T0, T0 + 89 * MINUTE);
    expect(hrSampleCoverage(iso(T0), iso(T0 + D), times)).toBe('thin');
  });

  it('counts one gap for at most six minutes — the backend attributes zone time the same way', () => {
    // Two readings, one on each window edge, so covered time IS the cap.
    // An 8-minute window: 6 of 8 = 0.75, exactly the bar.
    expect(hrSampleCoverage(iso(T0), iso(T0 + 8 * MINUTE), [iso(T0), iso(T0 + 8 * MINUTE)])).toBe(
      'plausible',
    );
    // A 9-minute window: still 6 covered, now 0.67 — which it would NOT be if
    // one gap could count for more than six minutes.
    expect(hrSampleCoverage(iso(T0), iso(T0 + 9 * MINUTE), [iso(T0), iso(T0 + 9 * MINUTE)])).toBe('thin');
  });

  it('credits the stretch before the FIRST reading, up to the same cap', () => {
    // A 10-minute window first read at minute 6: 6 (head, capped) + 4 = 10 of
    // 10. Without this, a short session read at a perfectly ordinary cadence
    // scores thin purely because coverage was measured only BETWEEN readings.
    expect(hrSampleCoverage(iso(T0), iso(T0 + 10 * MINUTE), everyMinute(T0 + 6 * MINUTE, T0 + 10 * MINUTE))).toBe(
      'plausible',
    );
  });

  it('credits the stretch after the LAST reading, up to the same cap', () => {
    // The mirror: last read at minute 4, so 4 + 6 (tail, capped) = 10 of 10.
    expect(hrSampleCoverage(iso(T0), iso(T0 + 10 * MINUTE), everyMinute(T0, T0 + 4 * MINUTE))).toBe(
      'plausible',
    );
  });

  it("reproduces the incident: 469 readings that stop 53 minutes before the window ends", () => {
    // Session 18:41:48 -> 20:11:48 local (90 minutes, `started_at + 90m` to
    // the millisecond). Apple Health held readings only between 18:41 and
    // 19:18 — one a minute, with an eight-minute burst of 1/s in the middle
    // — and nothing at all afterwards. See `hrSampleCoverage`'s own doc
    // comment for the full measurement.
    const windowEnd = T0 + 90 * MINUTE;
    const times = everyMinute(T0, T0 + 37 * MINUTE);
    for (let t = T0 + 20 * MINUTE; t < T0 + 28 * MINUTE; t += 1000) times.push(iso(t));
    expect(times.length).toBeGreaterThan(400); // the real incident's 469
    expect(hrSampleCoverage(iso(T0), iso(windowEnd), times)).toBe('thin');
  });

  it('a densely-read session is plausible on the first pass — the ordinary case is still terminal at once', () => {
    const times = everyMinute(T0, T0 + 90 * MINUTE);
    expect(hrSampleCoverage(iso(T0), iso(T0 + 90 * MINUTE), times)).toBe('plausible');
  });

  it('ignores readings outside the window rather than crediting them as coverage', () => {
    const windowEnd = T0 + 90 * MINUTE;
    const times = [...everyMinute(T0, T0 + 20 * MINUTE), ...everyMinute(windowEnd + MINUTE, windowEnd + 90 * MINUTE)];
    expect(hrSampleCoverage(iso(T0), iso(windowEnd), times)).toBe('thin');
  });

  it('is thin with no readings at all, and plausible for a zero-length window', () => {
    expect(hrSampleCoverage(iso(T0), iso(T0 + 90 * MINUTE), [])).toBe('thin');
    // Nothing there to under-cover; answering 'thin' would make such a row
    // retry for RETRY_WINDOW_DAYS while never being able to improve.
    expect(hrSampleCoverage(iso(T0), iso(T0), [iso(T0)])).toBe('plausible');
  });
});

describe('coverageFromLedger (W19/#985)', () => {
  it('reads the two real values through, and everything else as unknown', () => {
    expect(coverageFromLedger('plausible')).toBe('plausible');
    expect(coverageFromLedger('thin')).toBe('thin');
    // The migration's own backfill value, a NULL column on a device that
    // somehow skipped it, and anything a future writer might put there.
    expect(coverageFromLedger('unknown')).toBe('unknown');
    expect(coverageFromLedger(null)).toBe('unknown');
    expect(coverageFromLedger(undefined)).toBe('unknown');
    expect(coverageFromLedger('window')).toBe('unknown');
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

  it("is false once a COVERED 'window' result has been recorded — terminal, never retried", () => {
    // Deliberately a RECENT session, unlike the version of this test that
    // predated W19/#985: the old one used a session nine days old, so
    // `RETRY_WINDOW_DAYS` was making it false regardless of what the
    // `'window'` check did — the assertion could not have failed if the
    // terminal rule were deleted outright. Two hours old isolates the rule
    // actually under test.
    const endedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const ledger: EnrichmentLedgerEntry = {
      hrSource: 'window',
      coverage: 'plausible',
      attemptedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    };
    expect(needsEnrichmentAttempt({ endedAt }, ledger, now)).toBe(false);
  });

  it("W19/#985: a 'window' result whose evidence was THIN stays retryable, on the ordinary cadence", () => {
    // The incident: 469 real samples, every one of them from before the
    // class began, recorded as `hr_source: 'window'` and therefore
    // permanently final. It is now retryable — and via the SAME ladder a
    // `'none'` result uses, not a special one.
    const endedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const past = { hrSource: 'window' as const, coverage: 'thin' as const };
    const stale = new Date(now.getTime() - (RETRY_COOLDOWN_HOURS + 1) * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now.getTime() - 60_000).toISOString();

    expect(needsEnrichmentAttempt({ endedAt }, { ...past, attemptedAt: stale }, now)).toBe(true);
    // ...and it is not exempt from the cooldown either: a thin result is
    // still a result, not a licence to re-query on every foreground return.
    expect(needsEnrichmentAttempt({ endedAt }, { ...past, attemptedAt: fresh }, now)).toBe(false);
  });

  it(`W19/#985: a THIN 'window' result stops being retried past RETRY_WINDOW_DAYS, exactly like 'none'`, () => {
    const endedAt = new Date(
      now.getTime() - (RETRY_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const attemptedAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ledger: EnrichmentLedgerEntry = { hrSource: 'window', coverage: 'thin', attemptedAt };
    expect(needsEnrichmentAttempt({ endedAt }, ledger, now)).toBe(false);
  });

  it("W19/#985: a pre-W19 row (no coverage recorded) is retryable, not grandfathered as final", () => {
    // The upgrade path. A device that enriched the incident's session under
    // the old rule holds exactly this row, and the whole point of the
    // migration's `'unknown'` default is that it gets one more honest look
    // rather than staying wrong forever.
    const endedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const attemptedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(needsEnrichmentAttempt({ endedAt }, { hrSource: 'window', attemptedAt }, now)).toBe(true);
    expect(
      needsEnrichmentAttempt({ endedAt }, { hrSource: 'window', coverage: 'unknown', attemptedAt }, now),
    ).toBe(true);
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

describe('chunkSamples (N502/#873)', () => {
  it('returns zero chunks for an empty input', () => {
    expect(chunkSamples([], 5)).toEqual([]);
  });

  it('returns one chunk when everything fits', () => {
    expect(chunkSamples([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
  });

  it('splits into chunks of exactly `size`, with the remainder in the last one', () => {
    expect(chunkSamples([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('preserves order across chunks', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(chunkSamples(items, 3).flat()).toEqual(items);
  });

  it('treats a non-positive size as 1 rather than looping forever', () => {
    expect(chunkSamples([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunkSamples([1, 2], -5)).toEqual([[1], [2]]);
  });
});

describe('putBiometricSamples (N502/#873)', () => {
  const getToken = async () => 'test-token';

  function sample(id: string): BiometricSample {
    return {
      id,
      metric_type: 'heart_rate',
      source: 'apple_watch',
      source_platform: 'healthkit',
      value: 150,
      unit: 'bpm',
      measured_at: '2026-09-01T07:15:00.000Z',
    };
  }

  beforeEach(() => mockApi.mockReset());

  it('never calls the API for an empty batch', async () => {
    const result = await putBiometricSamples(getToken, []);
    expect(mockApi).not.toHaveBeenCalled();
    expect(result).toEqual({ samples: [] });
  });

  it('sends a batch at or under the chunk size in a single request', async () => {
    const samples = Array.from({ length: SAMPLES_PER_SYNC_REQUEST }, (_, i) => sample(`s${i}`));
    mockApi.mockResolvedValueOnce({ samples });

    await putBiometricSamples(getToken, samples);

    expect(mockApi).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockApi.mock.calls[0][2].body as string);
    expect(body.samples).toHaveLength(SAMPLES_PER_SYNC_REQUEST);
  });

  it('splits a batch over the chunk size into multiple requests, each within the cap', async () => {
    const total = SAMPLES_PER_SYNC_REQUEST + 1;
    const samples = Array.from({ length: total }, (_, i) => sample(`s${i}`));
    mockApi.mockImplementation((_token: unknown, _path: unknown, init: RequestInit) => {
      const sent = JSON.parse(init.body as string).samples;
      return Promise.resolve({ samples: sent });
    });

    const result = await putBiometricSamples(getToken, samples);

    expect(mockApi).toHaveBeenCalledTimes(2);
    for (const call of mockApi.mock.calls) {
      const body = JSON.parse(call[2].body as string);
      expect(body.samples.length).toBeLessThanOrEqual(SAMPLES_PER_SYNC_REQUEST);
    }
    // Every sample still makes it through, merged back into one result.
    expect(result.samples).toHaveLength(total);
  });

  it('every request goes to the same endpoint with the same method', async () => {
    const samples = Array.from({ length: SAMPLES_PER_SYNC_REQUEST * 2 }, (_, i) => sample(`s${i}`));
    mockApi.mockResolvedValue({ samples: [] });

    await putBiometricSamples(getToken, samples);

    for (const call of mockApi.mock.calls) {
      expect(call[1]).toBe('/biometric/samples');
      expect((call[2] as RequestInit).method).toBe('POST');
    }
  });

  it('propagates a rejection from any chunk rather than swallowing it', async () => {
    const samples = Array.from({ length: SAMPLES_PER_SYNC_REQUEST + 1 }, (_, i) => sample(`s${i}`));
    mockApi.mockRejectedValueOnce(new Error('offline'));

    await expect(putBiometricSamples(getToken, samples)).rejects.toThrow('offline');
  });
});
