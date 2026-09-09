/**
 * The biometric enrichment orchestrator (N477/#822), against a real SQLite
 * database — the same pattern `healthkitSync.test.ts` uses, one layer up:
 * `../db`'s `getDb` is redirected to a migrated fixture, so this exercises
 * the REAL `biometric_hr_synced` ledger and the real `local_sessions` rows
 * `startLocalSession`/`finishLocalSession` write, while `../healthkit`'s
 * native-touching exports and `../biometric`'s NETWORK calls are replaced
 * with fakes — the pure logic in `../biometric` (the window join, the
 * upload plan, the HRmax seed) stays real via `jest.requireActual`, so the
 * decision under test here is the one the app actually ships.
 */

import { migratedFixture, type FixtureDb } from './support/sqlite';
import type { HealthKitQuantitySample } from '../healthkit';
import { enrichSessionNow, readBiometricSyncFailureCount, syncBiometricEnrichment } from '../biometricSync';
import { writeHealthKitImportEnabled } from '../healthkitSync';
import { finishLocalSession, sessionsNeedingBiometricSync, startLocalSession } from '../sessionStore';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

let mockUuidSeq = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

let mockSupported = true;
let mockHRSamples: HealthKitQuantitySample[] = [];
// N522/#934: the wide-window fallback query is a SEPARATE, much longer-span
// call than the exact session-window one — distinguishing on span length
// (rather than call order/count) models the real difference between the two
// windows (`sessionHRWindow` vs. `wideHRQueryWindow`) without coupling this
// mock to how many times either is invoked.
const WIDE_SPAN_THRESHOLD_MS = 6 * 60 * 60 * 1000;
let mockWideHRSamples: HealthKitQuantitySample[] = [];
let mockVO2MaxSamples: HealthKitQuantitySample[] = [];
// N522 PR review (frontend-reviewer): "never runs the wide-window fallback"
// used to be checked only by asserting the RESULT didn't reflect the wide
// samples — true even if the wide query ran and simply failed to fit, which
// is a real but different bug (an unnecessary HealthKit query, not an
// incorrect override). This spy lets the test assert the CALL itself never
// happened.
/**
 * W19/#985 — an opt-in, more literal fake: a STORE of readings that every
 * query filters by its own window, instead of the span-length switch above.
 *
 * The span switch models two windows (exact vs. dated-day) and cannot model
 * four (the watch's own workout, the exact window, the ±20-minute padded
 * search, the dated day) — several of which have similar spans. Tests that
 * care WHICH window was asked about set this; every test written before this
 * ticket leaves it null and keeps the original behaviour exactly.
 */
let mockHRStore: HealthKitQuantitySample[] | null = null;
const mockQueryHeartRateSamples = jest.fn((start: Date, end: Date) => {
  if (mockHRStore) {
    return Promise.resolve(
      mockHRStore.filter((s) => {
        const t = new Date(s.measuredAt).getTime();
        return t >= start.getTime() && t <= end.getTime();
      }),
    );
  }
  return Promise.resolve(end.getTime() - start.getTime() > WIDE_SPAN_THRESHOLD_MS ? mockWideHRSamples : mockHRSamples);
});
/** W19/#985 — what HealthKit's workout store holds for this pass. `[]` (the
 *  default) is "the watch knows no workout", which is the pre-W19 shape and
 *  keeps every test written before this ticket asking about the session's
 *  own window. */
let mockWorkoutWindows: { start: string; end: string }[] = [];
const mockQueryWorkoutWindows = jest.fn((_start: Date, _end: Date) => Promise.resolve(mockWorkoutWindows));
jest.mock('../healthkit', () => {
  const real = jest.requireActual('../healthkit');
  return {
    ...real,
    isHealthKitSupported: () => mockSupported,
    queryHeartRateSamples: (start: Date, end: Date) => mockQueryHeartRateSamples(start, end),
    queryVO2MaxSamples: () => Promise.resolve(mockVO2MaxSamples),
    queryWorkoutWindows: (start: Date, end: Date) => mockQueryWorkoutWindows(start, end),
  };
});

let mockDateOfBirth: string | null = '1990-01-01';
jest.mock('../profile', () => ({
  getProfile: () =>
    mockDateOfBirth === 'REJECT'
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ date_of_birth: mockDateOfBirth }),
}));

const mockPutSamples = jest.fn().mockResolvedValue({ samples: [] });
// Resolves to a FLAT SessionMetrics-shaped object — what the real
// `computeSessionMetrics` actually resolves to (`res.metrics`, already
// unwrapped) — not `{ metrics: {...} }`. The old `{ metrics: {} }` default
// had this wrong for as long as nothing here read the return value; N511's
// fix reads `metrics.hr_source`, which exposed it. Dynamic rather than a
// fixed value: derived from `mockHRSamples` at call time, so it reflects
// realistic server behavior (real samples uploaded -> 'window', none ->
// 'none') without every test having to set it by hand.
const mockComputeMetrics = jest.fn();
jest.mock('../biometric', () => {
  const real = jest.requireActual('../biometric');
  return {
    ...real,
    putBiometricSamples: (...args: unknown[]) => mockPutSamples(...args),
    computeSessionMetrics: (...args: unknown[]) => mockComputeMetrics(...args),
  };
});

const USER = 'user_bio_1';
const getToken = async () => 'test-token';

function hrSample(overrides: Partial<HealthKitQuantitySample> = {}): HealthKitQuantitySample {
  return {
    uuid: 'sample-1',
    value: 150,
    unit: 'count/min',
    measuredAt: '2026-09-01T07:15:00.000Z',
    sourceName: 'Watch',
    sourceBundleId: 'com.apple.health.watch',
    ...overrides,
  };
}

/**
 * A minute-by-minute reading across `[startISO, endISO]` — what a worn strap
 * actually produces, and therefore what `hrSampleCoverage` (W19/#985) calls
 * `'plausible'`.
 *
 * Several tests below predate that rule and used one or two samples as a
 * stand-in for "real evidence exists". That is no longer the same thing: two
 * readings in the middle of a 30-minute window are exactly the shape W19
 * exists to keep RETRYABLE, so those tests now build their evidence with
 * this instead. The behaviour each of them asserts is unchanged; only the
 * fixture is now dense enough to still mean what its name says.
 */
function denseHRSamples(startISO: string, endISO: string, bpm = 150): HealthKitQuantitySample[] {
  const start = new Date(startISO).getTime();
  const end = new Date(endISO).getTime();
  const out: HealthKitQuantitySample[] = [];
  for (let t = start; t <= end; t += 60_000) {
    out.push(hrSample({ uuid: `dense-${t}`, measuredAt: new Date(t).toISOString(), value: bpm }));
  }
  return out;
}

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockUuidSeq = 0;
  mockSupported = true;
  mockHRSamples = [];
  mockWideHRSamples = [];
  mockWorkoutWindows = [];
  mockHRStore = null;
  mockQueryWorkoutWindows.mockClear();
  mockVO2MaxSamples = [];
  mockDateOfBirth = '1990-01-01';
  mockPutSamples.mockClear();
  mockComputeMetrics.mockClear();
  mockQueryHeartRateSamples.mockClear();
  mockPutSamples.mockResolvedValue({ samples: [] });
  mockComputeMetrics.mockImplementation(() =>
    Promise.resolve({
      hr_source: mockHRSamples.length > 0 ? 'window' : 'none',
      sample_count: mockHRSamples.length,
    }),
  );
  await writeHealthKitImportEnabled(USER, true);
});

async function finishedSession(overrides: { started_at?: string; ended_at?: string } = {}) {
  const session = await startLocalSession(USER, {
    sport: 'strength',
    name: 'Session',
    started_at: overrides.started_at ?? '2026-09-01T07:00:00.000Z',
  });
  await finishLocalSession(USER, session.id, overrides.ended_at ?? '2026-09-01T07:30:00.000Z');
  return session;
}

describe('syncBiometricEnrichment — gating', () => {
  it('does nothing while the shared HealthKit toggle is off', async () => {
    await writeHealthKitImportEnabled(USER, false);
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).not.toHaveBeenCalled();
    expect(mockComputeMetrics).not.toHaveBeenCalled();
  });

  it('does nothing when this binary has no HealthKit module', async () => {
    mockSupported = false;
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).not.toHaveBeenCalled();
  });
});

describe('syncBiometricEnrichment — session heart-rate windows', () => {
  it('a session with real HR samples: uploads them, computes with hr_source window, and marks the ledger', async () => {
    // Dense across the whole session window (W19/#985) — see
    // `denseHRSamples`: two readings would now be `'thin'` coverage, which
    // is deliberately NOT terminal, and this test is about the terminal case.
    mockHRSamples = denseHRSamples('2026-09-01T07:00:00.000Z', '2026-09-01T07:30:00.000Z');
    const session = await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).toHaveBeenCalledTimes(1);
    const [, uploaded] = mockPutSamples.mock.calls[0];
    expect(uploaded).toHaveLength(mockHRSamples.length);
    expect(uploaded[0].metric_type).toBe('heart_rate');

    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    const [, sessionID, hrMaxBPM, hrMaxSource, hrSource] = mockComputeMetrics.mock.calls[0];
    expect(sessionID).toBe(session.id);
    expect(hrMaxBPM).toBeGreaterThan(0);
    // Every producer of hrMaxBPM in this app today is the 220 - age estimate
    // — see biometric.ts's HRMaxSource doc comment.
    expect(hrMaxSource).toBe('estimated');
    expect(hrSource).toBe('window');

    // N511/#893: a TERMINAL ('window') session IS excluded at the SQL
    // layer — see sessionsNeedingBiometricSync's own doc comment on why
    // that specific exclusion (not "any ledger row") is what keeps a small
    // `limit` from being starved by old, already-enriched sessions. Back to
    // `[]` here, same as before this ticket — only a `'none'` result is now
    // retryable, not every ledger row.
    expect(await sessionsNeedingBiometricSync(USER, 10)).toEqual([]);
  });

  it("a session with ZERO HR samples: never calls PutSamples, but still computes — hr_source: 'none' is the server's own honest derivation from an empty result", async () => {
    mockHRSamples = [];
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).not.toHaveBeenCalled();
    // The claim sent is still 'window' (see planHRSync's doc comment) — the
    // server is what downgrades it to 'none' once it sees SampleCount is 0.
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    const [, , , , hrSource] = mockComputeMetrics.mock.calls[0];
    expect(hrSource).toBe('window');
  });

  it('W18/#957: a session that ended an HOUR ago is re-asked on the very next pass — the watch has usually pushed by then', async () => {
    // Pre-W18 this was the "does NOT retry within the cooldown" test, with
    // this exact session: ended an hour ago, first pass found nothing, the
    // next pass moments later was refused for 12 hours. That is the
    // athlete-visible bug — the data had long since landed in Apple Health
    // and the screen stayed empty all day. A recent session, not the fixed
    // 2026-09-01 default other tests here use, because RETRY_WINDOW_DAYS
    // is checked against REAL `Date.now()` (this test does not mock the
    // clock).
    const recentEnd = new Date(Date.now() - 60 * 60 * 1000);
    const recentStart = new Date(recentEnd.getTime() - 30 * 60 * 1000);
    mockHRSamples = [];
    await finishedSession({ started_at: recentStart.toISOString(), ended_at: recentEnd.toISOString() });
    await syncBiometricEnrichment(USER, getToken);
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);

    // The Watch data has since arrived; the very next pass finds it.
    mockComputeMetrics.mockClear();
    mockPutSamples.mockClear();
    mockHRSamples = [hrSample()];

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).toHaveBeenCalledTimes(1);
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
  });

  it('W18/#957: a session that ended FIVE hours ago is NOT re-asked moments later — the hourly cadence holds', async () => {
    const recentEnd = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const recentStart = new Date(recentEnd.getTime() - 30 * 60 * 1000);
    mockHRSamples = [];
    await finishedSession({ started_at: recentStart.toISOString(), ended_at: recentEnd.toISOString() });
    await syncBiometricEnrichment(USER, getToken);
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);

    mockComputeMetrics.mockClear();
    mockPutSamples.mockClear();
    mockHRSamples = [hrSample()];

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).not.toHaveBeenCalled();
    expect(mockPutSamples).not.toHaveBeenCalled();
  });

  it('N511/#893: retries a zero-sample session once the retry cooldown has elapsed, and this time finds real data', async () => {
    // A recent session, not the fixed 2026-09-01 default, so
    // RETRY_WINDOW_DAYS does not itself reject it before the cooldown check
    // gets a chance to run. FIVE hours old, not one (W18/#957): a session
    // under two hours old has NO cooldown any more, so backdating its
    // ledger row would prove nothing — this one sits on the hourly tier,
    // where the backdate below is what makes the retry happen.
    const recentEnd = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const recentStart = new Date(recentEnd.getTime() - 30 * 60 * 1000);
    mockHRSamples = [];
    const session = await finishedSession({
      started_at: recentStart.toISOString(),
      ended_at: recentEnd.toISOString(),
    });
    await syncBiometricEnrichment(USER, getToken);
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);

    // Simulate the hourly cooldown having elapsed by backdating the ledger
    // row directly — this is the real `biometric_hr_synced` table migrated
    // by the same fixture, not a mock.
    await mockFixture.runAsync(
      `UPDATE biometric_hr_synced SET attempted_at = ? WHERE user_id = ? AND session_id = ?`,
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      USER,
      session.id,
    );
    mockComputeMetrics.mockClear();
    mockPutSamples.mockClear();
    // The Watch has now synced its data — densely, across the whole window,
    // so this attempt's result is genuinely terminal (W19/#985).
    mockHRSamples = denseHRSamples(recentStart.toISOString(), recentEnd.toISOString());

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).toHaveBeenCalledTimes(1);
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);

    // And a THIRD pass does not re-offer it again — this attempt's result
    // was 'window', which is terminal regardless of cooldown.
    mockComputeMetrics.mockClear();
    await mockFixture.runAsync(
      `UPDATE biometric_hr_synced SET attempted_at = ? WHERE user_id = ? AND session_id = ?`,
      new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
      USER,
      session.id,
    );
    await syncBiometricEnrichment(USER, getToken);
    expect(mockComputeMetrics).not.toHaveBeenCalled();
  });

  it('a session still in progress (no ended_at) is never offered', async () => {
    await startLocalSession(USER, { sport: 'strength', name: 'Live', started_at: '2026-09-01T07:00:00.000Z' });

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).not.toHaveBeenCalled();
  });

  it('a second pass does not re-offer an already-synced session', async () => {
    mockHRSamples = [hrSample()];
    await finishedSession();
    await syncBiometricEnrichment(USER, getToken);
    mockComputeMetrics.mockClear();
    mockPutSamples.mockClear();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).not.toHaveBeenCalled();
    expect(mockPutSamples).not.toHaveBeenCalled();
  });

  it('with no date of birth on the profile, computes nothing and leaves every session pending for the next pass', async () => {
    mockDateOfBirth = null;
    mockHRSamples = [hrSample()];
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).not.toHaveBeenCalled();
    expect(await sessionsNeedingBiometricSync(USER, 10)).toHaveLength(1);
  });

  it('a network failure on one session leaves its ledger row unwritten, so the next pass retries it', async () => {
    mockHRSamples = [hrSample()];
    mockComputeMetrics.mockRejectedValueOnce(new Error('offline'));
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(await sessionsNeedingBiometricSync(USER, 10)).toHaveLength(1);
  });

  it('scopes the ledger per user', async () => {
    mockHRSamples = [hrSample()];
    await writeHealthKitImportEnabled('another_user', true);
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(await sessionsNeedingBiometricSync('another_user', 10)).toHaveLength(0);
  });
});

describe('syncBiometricEnrichment — wide-window HR fit fallback (N522/#934)', () => {
  // A step of 5 minutes across a wide span, elevated (150 bpm) only inside
  // [blockStartISO, blockEndISO) and at a resting baseline (68 bpm)
  // everywhere else — enough real oscillation-free structure to prove the
  // WIRING (fit found -> filtered samples uploaded -> override passed to
  // computeSessionMetrics), which is this describe block's job. The
  // fitting algorithm's own precision, ambiguity handling and empty-case
  // honesty are covered exhaustively, against the real incident's shape,
  // in `hrWindowFit.test.ts` — this only has to prove biometricSync wires
  // that algorithm in correctly.
  function samplesWithElevatedBlock(blockStartISO: string, blockEndISO: string): HealthKitQuantitySample[] {
    const out: HealthKitQuantitySample[] = [];
    const start = new Date('2026-09-01T15:00:00.000Z').getTime();
    const end = new Date('2026-09-01T22:00:00.000Z').getTime();
    const blockStart = new Date(blockStartISO).getTime();
    const blockEnd = new Date(blockEndISO).getTime();
    const step = 5 * 60_000;
    for (let t = start; t <= end; t += step) {
      const elevated = t >= blockStart && t < blockEnd;
      out.push(hrSample({ uuid: `wide-${t}`, measuredAt: new Date(t).toISOString(), value: elevated ? 150 : 68 }));
    }
    return out;
  }

  it('when the exact window is empty but the wide window fits a real elevated block, uploads only the fitted samples and computes with an explicit window override', async () => {
    mockHRSamples = []; // the session's own (wrong) logged window finds nothing
    mockWideHRSamples = samplesWithElevatedBlock('2026-09-01T18:00:00.000Z', '2026-09-01T19:00:00.000Z');
    // The session's own logged window: same DURATION as the real block (60
    // min), wrong CLOCK PLACEMENT (2 hours later) — exactly this ticket's
    // incident shape.
    await finishedSession({ started_at: '2026-09-01T20:00:00.000Z', ended_at: '2026-09-01T21:00:00.000Z' });

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).toHaveBeenCalledTimes(1);
    const [, uploaded] = mockPutSamples.mock.calls[0];
    // A real SUBSET of the fitted window's neighbourhood — not the whole
    // wide window's worth of baseline readings alongside the real block (a
    // fitted window's own boundary sample can legitimately be a
    // transitional, non-elevated reading — see this fixture's own 19:00
    // sample — the property that matters is that this is a fit, not a dump
    // of everything the wide query returned).
    expect(uploaded.length).toBeGreaterThan(0);
    expect(uploaded.length).toBeLessThan(mockWideHRSamples.length);
    expect(uploaded.some((s: { value: number }) => s.value === 150)).toBe(true);

    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    const [, , , , hrSource, windowOverride] = mockComputeMetrics.mock.calls[0];
    expect(hrSource).toBe('window');
    expect(windowOverride).not.toBeNull();
    expect(typeof windowOverride.start).toBe('string');
    expect(typeof windowOverride.end).toBe('string');
    // The override is the REAL block's neighbourhood, not the session's own
    // (wrong) logged window it replaces.
    expect(windowOverride.start).not.toBe('2026-09-01T20:00:00.000Z');
    const overrideStartMs = new Date(windowOverride.start).getTime();
    const overrideEndMs = new Date(windowOverride.end).getTime();
    expect(overrideStartMs).toBeGreaterThanOrEqual(new Date('2026-09-01T17:55:00.000Z').getTime());
    expect(overrideStartMs).toBeLessThanOrEqual(new Date('2026-09-01T18:05:00.000Z').getTime());
    expect(overrideEndMs).toBeGreaterThanOrEqual(new Date('2026-09-01T18:55:00.000Z').getTime());
    expect(overrideEndMs).toBeLessThanOrEqual(new Date('2026-09-01T19:05:00.000Z').getTime());
  });

  it('when the wide window is genuinely empty (flat resting HR), falls back to compute-only exactly as before — no override, no upload', async () => {
    mockHRSamples = [];
    mockWideHRSamples = samplesWithElevatedBlock('2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'); // never elevated
    await finishedSession({ started_at: '2026-09-01T20:00:00.000Z', ended_at: '2026-09-01T21:00:00.000Z' });

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).not.toHaveBeenCalled();
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    const [, , , , hrSource, windowOverride] = mockComputeMetrics.mock.calls[0];
    expect(hrSource).toBe('window'); // still the claim; the server derives 'none' from zero samples
    expect(windowOverride).toBeFalsy();
  });

  it('when the wide window has two comparably-good, well-separated elevated blocks, declines to force a fit — no override, no upload', async () => {
    mockHRSamples = [];
    // Two real-looking blocks, ~3 hours apart, each the same duration as
    // the session's own logged window — genuinely ambiguous: nothing here
    // says which one this session actually was.
    const a = samplesWithElevatedBlock('2026-09-01T16:00:00.000Z', '2026-09-01T17:00:00.000Z');
    const b = samplesWithElevatedBlock('2026-09-01T19:30:00.000Z', '2026-09-01T20:30:00.000Z');
    // Merge: wherever either fixture reports elevated, keep it elevated.
    mockWideHRSamples = a.map((s, i) => ({
      ...s,
      value: s.value === 150 || b[i]?.value === 150 ? 150 : 68,
    }));
    await finishedSession({ started_at: '2026-09-01T22:00:00.000Z', ended_at: '2026-09-01T23:00:00.000Z' });

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).not.toHaveBeenCalled();
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    const [, , , , , windowOverride] = mockComputeMetrics.mock.calls[0];
    expect(windowOverride).toBeFalsy();
  });

  it('never runs the wide-window fallback when the exact window already found real samples', async () => {
    // W19/#985: "real samples" now has to mean samples that COVER the
    // window. A single reading no longer stops the fallback, and should not
    // — see `hrSampleCoverage`. The property this test guards (the common,
    // healthy path costs exactly one heart-rate query) is unchanged.
    mockHRSamples = denseHRSamples('2026-09-01T07:00:00.000Z', '2026-09-01T07:30:00.000Z');
    mockWideHRSamples = samplesWithElevatedBlock('2026-09-01T18:00:00.000Z', '2026-09-01T19:00:00.000Z');
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    const [, , , , , windowOverride] = mockComputeMetrics.mock.calls[0];
    expect(windowOverride).toBeFalsy();
    // N522 PR review (frontend-reviewer): the assertion above alone is
    // satisfied even if the fallback query ran and simply failed to fit —
    // a real but DIFFERENT bug (an unnecessary HealthKit query on the
    // common, non-broken path) that this test's own name promises to catch.
    // Assert the call itself, not merely its absence from the result.
    const ranAWideQuery = mockQueryHeartRateSamples.mock.calls.some(
      ([start, end]: [Date, Date]) => end.getTime() - start.getTime() > WIDE_SPAN_THRESHOLD_MS,
    );
    expect(ranAWideQuery).toBe(false);
  });
});

/**
 * W19/#985 — the incident, end to end, against the real SQLite ledger.
 *
 * A 90-minute class logged 18:41:48 → 20:11:48 whose heart rate Apple Health
 * only holds for its first 37 minutes, because the strap's companion app had
 * not written the class itself yet. Everything here is built from that
 * measurement; see `lib/biometric.ts`'s `hrSampleCoverage` doc comment.
 */
describe('syncBiometricEnrichment — a thin result never becomes final (W19/#985)', () => {
  // Recent, so RETRY_WINDOW_DAYS is never what decides anything below.
  const sessionEnd = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const sessionStart = new Date(sessionEnd.getTime() - 90 * 60_000);
  const startISO = sessionStart.toISOString();
  const endISO = sessionEnd.toISOString();
  const offset = (minutes: number) => new Date(sessionStart.getTime() + minutes * 60_000);

  /** Once-a-minute background heart rate over `[fromMin, toMin]`, in the low
   *  hundreds — the incident's real shape (85–125 bpm, not resting, not
   *  training either). */
  function backgroundHR(fromMin: number, toMin: number): HealthKitQuantitySample[] {
    const out: HealthKitQuantitySample[] = [];
    for (let m = fromMin; m <= toMin; m++) {
      out.push(hrSample({ uuid: `bg-${m}`, measuredAt: offset(m).toISOString(), value: 104 }));
    }
    return out;
  }

  async function theSession() {
    return finishedSession({ started_at: startISO, ended_at: endISO });
  }

  beforeEach(() => {
    // The file-level default derives the server's answer from `mockHRSamples`,
    // which these tests deliberately do not use (they drive `mockHRStore`, so
    // that WHICH window was queried is what decides what comes back). Derive
    // it from what was actually uploaded instead — same intent, right input.
    mockComputeMetrics.mockImplementation((...args: unknown[]) => {
      const uploaded = (mockPutSamples.mock.calls.at(-1)?.[1] as unknown[] | undefined) ?? [];
      void args;
      return Promise.resolve({
        hr_source: uploaded.length > 0 ? 'window' : 'none',
        sample_count: uploaded.length,
      });
    });
  });

  it('records the thin result but leaves the session retryable — the pre-class average is not the last word', async () => {
    mockHRStore = backgroundHR(0, 37); // nothing at all for the last 53 minutes
    const session = await theSession();

    await syncBiometricEnrichment(USER, getToken);

    // The result IS computed and stored — this is not "refuse to answer".
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    const [row] = await mockFixture.getAllAsync<{ hr_source: string; coverage: string }>(
      `SELECT hr_source, coverage FROM biometric_hr_synced WHERE user_id = ? AND session_id = ?`,
      USER,
      session.id,
    );
    expect(row.hr_source).toBe('window');
    expect(row.coverage).toBe('thin');

    // ...and the session is still a candidate, which is the whole fix. Under
    // the old rule this list was empty and stayed empty forever.
    expect((await sessionsNeedingBiometricSync(USER, 10)).map((c) => c.id)).toEqual([session.id]);
  });

  it("picks the class up on a later pass once the strap has written it, and only THEN goes terminal", async () => {
    mockHRStore = backgroundHR(0, 37);
    const session = await theSession();
    await syncBiometricEnrichment(USER, getToken);
    mockComputeMetrics.mockClear();
    mockPutSamples.mockClear();

    // The companion app syncs: Apple Health now holds the class itself, as a
    // workout AND as dense readings running 37 minutes late and 36 minutes
    // past the logged end — the incident's real offsets.
    const classStart = offset(37);
    const classEnd = offset(125);
    mockWorkoutWindows = [{ start: classStart.toISOString(), end: classEnd.toISOString() }];
    mockHRStore = [
      ...backgroundHR(0, 36),
      ...Array.from({ length: 89 }, (_, i) =>
        hrSample({ uuid: `class-${i}`, measuredAt: offset(37 + i).toISOString(), value: 126 + (i % 20) }),
      ),
    ];
    // Past the hourly cooldown for a three-hour-old session.
    await mockFixture.runAsync(
      `UPDATE biometric_hr_synced SET attempted_at = ? WHERE user_id = ? AND session_id = ?`,
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      USER,
      session.id,
    );

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    const [, , , , hrSource, windowOverride] = mockComputeMetrics.mock.calls[0];
    expect(hrSource).toBe('window');
    // The WATCH's window, not the typed one — this is the whole second half
    // of the ticket, and it is what makes the reported max the class's 185
    // rather than the pre-class 125.
    expect(windowOverride).toEqual({
      start: classStart.toISOString(),
      end: classEnd.toISOString(),
    });
    const uploaded = mockPutSamples.mock.calls[0][1];
    expect(uploaded.every((x: { value: number }) => x.value >= 126)).toBe(true);

    // Densely covered now, so it is finally terminal — no re-querying forever.
    const [row] = await mockFixture.getAllAsync<{ coverage: string }>(
      `SELECT coverage FROM biometric_hr_synced WHERE user_id = ? AND session_id = ?`,
      USER,
      session.id,
    );
    expect(row.coverage).toBe('plausible');
    expect(await sessionsNeedingBiometricSync(USER, 10)).toEqual([]);
  });

  it("falls back to the session's own window when the store knows a workout but holds no heart rate for it", async () => {
    // A workout record with nothing behind it tells us WHEN, not WHAT — a
    // real shape on Android especially, where an app can write an exercise
    // session without ever writing heart rate. The workout window is still
    // ASKED about (it is the only way to find out), and then abandoned.
    mockWorkoutWindows = [{ start: offset(37).toISOString(), end: offset(125).toISOString() }];
    mockHRStore = [];
    await theSession();

    await syncBiometricEnrichment(USER, getToken);

    const [, , , , , windowOverride] = mockComputeMetrics.mock.calls[0];
    expect(windowOverride).toBeFalsy();
    const [firstStart, firstEnd] = mockQueryHeartRateSamples.mock.calls[0];
    expect(firstStart.toISOString()).toBe(offset(37).toISOString());
    expect(firstEnd.toISOString()).toBe(offset(125).toISOString());
    const [secondStart] = mockQueryHeartRateSamples.mock.calls[1];
    expect(secondStart.toISOString()).toBe(startISO);
  });

  it('a densely-covered session is terminal after ONE pass, and never queries anything wider', async () => {
    // The ordinary case, and the regression this fix must not cause: no
    // padded search, no dated-day search, one heart-rate query.
    mockHRStore = Array.from({ length: 91 }, (_, m) =>
      hrSample({ uuid: `dense-${m}`, measuredAt: offset(m).toISOString(), value: 150 }),
    );
    await theSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockQueryHeartRateSamples).toHaveBeenCalledTimes(1);
    expect(await sessionsNeedingBiometricSync(USER, 10)).toEqual([]);
  });

  it('W19: the ±20-minute padded search FITS rather than averages, when the logged start is 20 minutes late', async () => {
    // No workout record at all — the fallback the ticket names, and the
    // athlete's own suggested ±20 minutes is exactly what it takes to reach
    // this class. The watch was worn from 20 minutes BEFORE the logged start
    // and taken off 20 minutes before the logged end, so the logged window's
    // own readings stop early: `hrSampleCoverage` calls that thin, which is
    // what lets the fallback run at all.
    mockWorkoutWindows = [];
    const store: HealthKitQuantitySample[] = [];
    for (let m = -20; m <= 0; m++) {
      store.push(hrSample({ uuid: `warm-${m}`, measuredAt: offset(m).toISOString(), value: 62 }));
    }
    for (let m = 1; m <= 70; m++) {
      // Real surges, not a flat block — the fit has its own high-intensity
      // bar and a synthetic plateau would clear it for the wrong reason.
      store.push(hrSample({ uuid: `roll-${m}`, measuredAt: offset(m).toISOString(), value: m % 7 === 0 ? 175 : 145 }));
    }
    mockHRStore = store;
    await theSession();

    await syncBiometricEnrichment(USER, getToken);

    const [, , , , , windowOverride] = mockComputeMetrics.mock.calls[0];
    expect(windowOverride).not.toBeFalsy();
    expect(windowOverride.start).toBe(offset(-20).toISOString());
    expect(windowOverride.end).toBe(offset(70).toISOString());

    // The PADDED search is what found it — three heart-rate queries (the
    // workout window is never asked about, there is no workout), and the
    // dated-day search N522 added is never reached.
    expect(mockQueryHeartRateSamples).toHaveBeenCalledTimes(2);
    const [paddedStart, paddedEnd] = mockQueryHeartRateSamples.mock.calls[1];
    expect(paddedStart.getTime()).toBe(sessionStart.getTime() - 20 * 60_000);
    expect(paddedEnd.getTime()).toBe(sessionEnd.getTime() + 20 * 60_000);
  });
});

describe('sessionsNeedingBiometricSync — SQL-level ledger exclusion (N511/#893)', () => {
  it("excludes a TERMINAL ('window') session from the LIMIT budget, so a small limit still reaches a newer, genuinely pending session", async () => {
    // Two older sessions, already fully enriched to 'window' — a first
    // version of this fix dropped the ledger check from this SQL query
    // entirely, returning every finished session regardless of ledger state
    // and relying only on the in-memory needsEnrichmentAttempt filter. That
    // is correct in isolation but wrong combined with a small `limit`: the
    // query's own LIMIT gets spent on sessions that are filtered out
    // afterward, so the budget shrinks to nothing while genuinely-pending
    // sessions go unenriched. See sessionsNeedingBiometricSync's own doc
    // comment.
    //
    // N523/#937 updated this comment, not this test. Under the ordering this
    // test was written against (oldest-first) the failure mode was the
    // pending session being sorted PAST position 2 and never reaching the
    // result at all. Under newest-first it sorts to position 1 instead, so a
    // reverted ledger filter shows up differently — the terminal session
    // pollutes the result ALONGSIDE pending, making the returned length 2
    // rather than 1. The assertion below still catches the mutation either
    // way (it pins the exact list, not merely membership); only the
    // mechanism the prose describes has changed.
    mockHRSamples = denseHRSamples('2026-08-01T07:00:00.000Z', '2026-08-01T07:30:00.000Z');
    await finishedSession({ started_at: '2026-08-01T07:00:00.000Z', ended_at: '2026-08-01T07:30:00.000Z' });
    await syncBiometricEnrichment(USER, getToken);
    mockComputeMetrics.mockClear();
    mockPutSamples.mockClear();

    mockHRSamples = denseHRSamples('2026-08-02T07:00:00.000Z', '2026-08-02T07:30:00.000Z');
    await finishedSession({ started_at: '2026-08-02T07:00:00.000Z', ended_at: '2026-08-02T07:30:00.000Z' });
    await syncBiometricEnrichment(USER, getToken);
    mockComputeMetrics.mockClear();
    mockPutSamples.mockClear();

    // A brand-new, still-pending session, more recent than both of the
    // above (and than any date-of-birth-driven floor concern here).
    const recentEnd = new Date(Date.now() - 60 * 60 * 1000);
    const recentStart = new Date(recentEnd.getTime() - 30 * 60 * 1000);
    const pending = await finishedSession({
      started_at: recentStart.toISOString(),
      ended_at: recentEnd.toISOString(),
    });

    const candidates = await sessionsNeedingBiometricSync(USER, 2);

    expect(candidates.map((c) => c.id)).toEqual([pending.id]);
  });

  // N523/#937 — the OTHER starvation mode, the one that reached a real
  // phone. N511 (the test above) fixed a slice of already-`'window'`
  // sessions eating the LIMIT budget. This is the same starvation with a
  // different cause and no ledger rows at all: a backlog of NEVER-attempted
  // old sessions. `needsEnrichmentAttempt` opens with `if (!ledgerEntry)
  // return true` — no age test, no cooldown — so every one of them stays
  // eligible forever, and under the old `ORDER BY ended_at ASC` the oldest
  // `limit` of them were re-selected at the front of the queue on every
  // single pass. Live-observed on the reporting user's device: twenty
  // candidates, all from 2026-08-01..15, zero from September, while that
  // day's own BJJ session sat unenriched. Newest-first is the fix.
  it('reaches a session logged TODAY even when more than `limit` older, never-attempted sessions exist', async () => {
    // A backlog strictly larger than the limit under test, all older than
    // the session that actually matters, none of them ever attempted (no
    // ledger rows written for any of them — nothing here runs a pass).
    const backlog = [];
    for (let day = 1; day <= 5; day++) {
      const d = String(day).padStart(2, '0');
      backlog.push(
        await finishedSession({
          started_at: `2026-08-${d}T07:00:00.000Z`,
          ended_at: `2026-08-${d}T07:30:00.000Z`,
        }),
      );
    }

    // The session the athlete just logged and is actually looking at.
    const recentEnd = new Date(Date.now() - 60 * 60 * 1000);
    const recentStart = new Date(recentEnd.getTime() - 90 * 60 * 1000);
    const today = await finishedSession({
      started_at: recentStart.toISOString(),
      ended_at: recentEnd.toISOString(),
    });

    // A budget far smaller than the backlog — exactly the shape that made
    // the real device never reach September.
    const candidates = await sessionsNeedingBiometricSync(USER, 3);

    expect(candidates).toHaveLength(3);
    // The whole point: today's session is in the page, and FIRST, rather
    // than sorted behind five older ones that will never resolve. Under the
    // old `ASC` ordering this line fails with the oldest August session —
    // which is exactly the starvation observed on the real device.
    expect(candidates[0].id).toBe(today.id);
    // And the backlog is not abandoned — it spends what's left of the
    // budget, newest of the old ones first.
    expect(candidates.slice(1).map((c) => c.id)).toEqual([backlog[4].id, backlog[3].id]);
  });
});

describe('syncBiometricEnrichment — session backfill time floor (N502/#873)', () => {
  it('never offers a session that ended more than SESSION_BACKFILL_FLOOR_DAYS ago', async () => {
    mockHRSamples = [hrSample()];
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const startedAt = new Date(longAgo.getTime() - 30 * 60 * 1000).toISOString();
    await finishedSession({ started_at: startedAt, ended_at: longAgo.toISOString() });

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).not.toHaveBeenCalled();
    // Not merely deferred to a later pass — a session this old is never a
    // candidate at all, unlike the "no date of birth" case above which
    // leaves the session pending for next time.
    expect(await sessionsNeedingBiometricSync(USER, 10)).toHaveLength(1);
  });

  it('still offers a session well within the floor', async () => {
    mockHRSamples = [hrSample()];
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const startedAt = new Date(recent.getTime() - 30 * 60 * 1000).toISOString();
    await finishedSession({ started_at: startedAt, ended_at: recent.toISOString() });

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
  });
});

describe('syncBiometricEnrichment — the debug-accessible failure count (N502/#873)', () => {
  it('starts at zero for an account that has never synced', async () => {
    expect(await readBiometricSyncFailureCount(USER)).toBe(0);
  });

  it('a failed session compute increments the count', async () => {
    mockHRSamples = [hrSample()];
    mockComputeMetrics.mockRejectedValueOnce(new Error('offline'));
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(await readBiometricSyncFailureCount(USER)).toBe(1);
  });

  it('a failed VO2max upload increments the count', async () => {
    mockVO2MaxSamples = [
      { uuid: 'vo2-1', value: 50, unit: 'ml/(kg*min)', measuredAt: '2026-08-01T00:00:00.000Z', sourceName: 'Watch', sourceBundleId: 'com.apple.health.watch' },
    ];
    mockPutSamples.mockRejectedValueOnce(new Error('offline'));

    await syncBiometricEnrichment(USER, getToken);

    expect(await readBiometricSyncFailureCount(USER)).toBe(1);
  });

  it('resets to zero once a subsequent pass completes with no failures', async () => {
    mockHRSamples = [hrSample()];
    mockComputeMetrics.mockRejectedValueOnce(new Error('offline'));
    await finishedSession();
    await syncBiometricEnrichment(USER, getToken);
    expect(await readBiometricSyncFailureCount(USER)).toBe(1);

    // The session is still pending (its ledger row was never written), so
    // the next pass retries it — this time it succeeds.
    await syncBiometricEnrichment(USER, getToken);

    expect(await readBiometricSyncFailureCount(USER)).toBe(0);
  });
});

describe('syncBiometricEnrichment — VO2max', () => {
  it('uploads new VO2max samples with metric_type vo2_max', async () => {
    mockVO2MaxSamples = [
      { uuid: 'vo2-1', value: 48.2, unit: 'ml/(kg*min)', measuredAt: '2026-08-01T00:00:00.000Z', sourceName: 'Watch', sourceBundleId: 'com.apple.health.watch' },
    ];

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).toHaveBeenCalled();
    const upload = mockPutSamples.mock.calls.find(
      (call) => call[1]?.[0]?.metric_type === 'vo2_max',
    );
    expect(upload).toBeDefined();
    expect(upload?.[1][0].value).toBe(48.2);
  });

  it('does not call PutSamples when there is nothing new since the last sync', async () => {
    mockVO2MaxSamples = [];

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).not.toHaveBeenCalled();
  });

  it('a failing HR pass does not prevent VO2max from syncing, and vice versa', async () => {
    mockDateOfBirth = null; // HR pass computes nothing, per the test above
    mockHRSamples = [hrSample()];
    mockVO2MaxSamples = [
      { uuid: 'vo2-1', value: 50, unit: 'ml/(kg*min)', measuredAt: '2026-08-01T00:00:00.000Z', sourceName: 'Watch', sourceBundleId: 'com.apple.health.watch' },
    ];
    await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockComputeMetrics).not.toHaveBeenCalled();
    expect(mockPutSamples).toHaveBeenCalled();
  });
});

describe('enrichSessionNow — W18/#957, the "Sync heart rate" button', () => {
  // An hourly-tier session (five hours old): the pass refuses a second
  // attempt moments after the first; the button must not.
  const end = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 30 * 60 * 1000);
  const enrichable = (id: string) => ({ id, started_at: start.toISOString(), ended_at: end.toISOString() });

  async function ledgerRow(sessionID: string): Promise<{ hr_source: string } | null> {
    return mockFixture.getFirstAsync<{ hr_source: string }>(
      `SELECT hr_source FROM biometric_hr_synced WHERE user_id = ? AND session_id = ?`,
      USER,
      sessionID,
    );
  }

  it('bypasses the cooldown: the attempt the pass just refused runs, finds the data, and the ledger records window', async () => {
    mockHRSamples = [];
    const session = await finishedSession({ started_at: start.toISOString(), ended_at: end.toISOString() });
    await syncBiometricEnrichment(USER, getToken);
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    expect((await ledgerRow(session.id))?.hr_source).toBe('none');

    // The Watch pushed in the meantime. The pass is inside its cooldown …
    mockComputeMetrics.mockClear();
    mockPutSamples.mockClear();
    mockHRSamples = [hrSample()];
    await syncBiometricEnrichment(USER, getToken);
    expect(mockComputeMetrics).not.toHaveBeenCalled();

    // … the button is not.
    const outcome = await enrichSessionNow(USER, getToken, enrichable(session.id));

    expect(outcome).toEqual({ status: 'found', sampleCount: 1 });
    expect(mockPutSamples).toHaveBeenCalledTimes(1);
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    expect((await ledgerRow(session.id))?.hr_source).toBe('window');
  });

  it('bypasses the retry WINDOW too: a session the orchestrator has given up on can still be asked about by hand', async () => {
    // `finishedSession`'s default dates are 2026-09-01 — past RETRY_WINDOW_DAYS
    // relative to real now. First pass writes a 'none' row; from then on the
    // pass never offers it again.
    mockHRSamples = [];
    const session = await finishedSession();
    await syncBiometricEnrichment(USER, getToken);
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    mockComputeMetrics.mockClear();
    mockHRSamples = [hrSample()];
    await syncBiometricEnrichment(USER, getToken);
    expect(mockComputeMetrics).not.toHaveBeenCalled();

    const outcome = await enrichSessionNow(USER, getToken, {
      id: session.id,
      started_at: '2026-09-01T07:00:00.000Z',
      ended_at: '2026-09-01T07:30:00.000Z',
    });

    expect(outcome.status).toBe('found');
    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
  });

  it("reports 'none' honestly when Health still has nothing — and records the attempt, so the pass's cadence restarts from now", async () => {
    mockHRSamples = [];
    const session = await finishedSession({ started_at: start.toISOString(), ended_at: end.toISOString() });

    const outcome = await enrichSessionNow(USER, getToken, enrichable(session.id));

    expect(outcome).toEqual({ status: 'none' });
    expect(mockPutSamples).not.toHaveBeenCalled();
    expect((await ledgerRow(session.id))?.hr_source).toBe('none');
  });

  it("reports 'sync_off' with the toggle off, and never touches HealthKit", async () => {
    await writeHealthKitImportEnabled(USER, false);
    mockHRSamples = [hrSample()];
    const session = await finishedSession({ started_at: start.toISOString(), ended_at: end.toISOString() });

    const outcome = await enrichSessionNow(USER, getToken, enrichable(session.id));

    expect(outcome).toEqual({ status: 'sync_off' });
    expect(mockQueryHeartRateSamples).not.toHaveBeenCalled();
    expect(await ledgerRow(session.id)).toBeNull();
  });

  it("reports 'no_hrmax' with no date of birth on the profile — the honest reason nothing can be computed", async () => {
    mockDateOfBirth = null;
    mockHRSamples = [hrSample()];
    const session = await finishedSession({ started_at: start.toISOString(), ended_at: end.toISOString() });

    const outcome = await enrichSessionNow(USER, getToken, enrichable(session.id));

    expect(outcome).toEqual({ status: 'no_hrmax' });
    expect(mockComputeMetrics).not.toHaveBeenCalled();
  });

  it("reports 'error' when the upload fails, and records nothing — the next pass decides fresh", async () => {
    mockHRSamples = [hrSample()];
    mockPutSamples.mockRejectedValue(new Error('simulated network failure'));
    const session = await finishedSession({ started_at: start.toISOString(), ended_at: end.toISOString() });

    const outcome = await enrichSessionNow(USER, getToken, enrichable(session.id));

    expect(outcome).toEqual({ status: 'error' });
    expect(await ledgerRow(session.id)).toBeNull();
  });

  it('an unfinished session is refused up front, without a HealthKit read', async () => {
    const outcome = await enrichSessionNow(USER, getToken, { id: 'x', started_at: start.toISOString(), ended_at: null });
    expect(outcome).toEqual({ status: 'error' });
    expect(mockQueryHeartRateSamples).not.toHaveBeenCalled();
  });
});
