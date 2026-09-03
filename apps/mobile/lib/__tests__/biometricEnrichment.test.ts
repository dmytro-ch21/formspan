/**
 * The §2 window join and its supporting decisions (N478) — every function in
 * `lib/biometricEnrichment.ts` is pure over plain data, so this suite needs
 * no device, no SQLite fixture and no mock of Health Connect at all. See
 * that file's own doc comment for why this is the half of the feature kept
 * separable from `lib/healthConnect.ts`'s native boundary.
 */

import {
  HEALTH_CONNECT_HISTORY_WALL_DAYS,
  MAX_HR_MAX_BPM,
  MIN_HR_MAX_BPM,
  RETRY_COOLDOWN_HOURS,
  RETRY_WINDOW_DAYS,
  estimateHRMaxBPM,
  heartRateSamplesInWindow,
  isWithinHealthConnectHistoryWall,
  needsEnrichmentAttempt,
  selectEnrichmentCandidates,
  type EnrichmentCandidate,
  type EnrichmentLedgerEntry,
} from '../biometricEnrichment';

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

describe('estimateHRMaxBPM', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');

  it('estimates 220 - age for an athlete who has already had this year\'s birthday', () => {
    // Born 1996-01-15: turned 30 on 2026-01-15, before `now` — age 30.
    expect(estimateHRMaxBPM('1996-01-15', now)).toBe(190);
  });

  it("has not yet had this year's birthday", () => {
    // Born 1996-12-15: turns 30 on 2026-12-15, after `now` — age still 29.
    expect(estimateHRMaxBPM('1996-12-15', now)).toBe(191);
  });

  it('returns null for a missing date of birth', () => {
    expect(estimateHRMaxBPM(null, now)).toBeNull();
    expect(estimateHRMaxBPM(undefined, now)).toBeNull();
  });

  it('returns null for an unparseable date of birth', () => {
    expect(estimateHRMaxBPM('not-a-date', now)).toBeNull();
  });

  it('returns null for a date of birth in the future', () => {
    expect(estimateHRMaxBPM('2027-01-01', now)).toBeNull();
  });

  it(`never exceeds the backend's own upper bound (${MAX_HR_MAX_BPM}), even at age 0`, () => {
    // The `220 - age` formula cannot itself produce anything above 220 for
    // a non-negative age, so this clamp can never actually engage through
    // this estimator — recorded here rather than silently assumed, so a
    // future change to the formula (a different constant than 220, say)
    // is the only way this bound stops being purely defensive.
    expect(estimateHRMaxBPM('2026-09-01', now)).toBeLessThanOrEqual(MAX_HR_MAX_BPM);
  });

  it(`clamps to the backend's own bound (${MIN_HR_MAX_BPM}) for a very old athlete`, () => {
    // Age 125: 220 - 125 = 95, below MIN_HR_MAX_BPM (100) — must clamp up,
    // not report a value the backend's own handler.go rejects as
    // invalid_input.
    expect(estimateHRMaxBPM('1901-01-01', now)).toBe(MIN_HR_MAX_BPM);
  });

  it('returns null for an implausible age past the sanity ceiling', () => {
    expect(estimateHRMaxBPM('1800-01-01', now)).toBeNull();
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
