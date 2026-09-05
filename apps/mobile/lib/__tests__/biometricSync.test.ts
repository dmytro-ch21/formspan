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
import { readBiometricSyncFailureCount, syncBiometricEnrichment } from '../biometricSync';
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
let mockVO2MaxSamples: HealthKitQuantitySample[] = [];
jest.mock('../healthkit', () => {
  const real = jest.requireActual('../healthkit');
  return {
    ...real,
    isHealthKitSupported: () => mockSupported,
    queryHeartRateSamples: () => Promise.resolve(mockHRSamples),
    queryVO2MaxSamples: () => Promise.resolve(mockVO2MaxSamples),
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
const mockComputeMetrics = jest.fn().mockResolvedValue({ metrics: {} });
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

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockUuidSeq = 0;
  mockSupported = true;
  mockHRSamples = [];
  mockVO2MaxSamples = [];
  mockDateOfBirth = '1990-01-01';
  mockPutSamples.mockClear();
  mockComputeMetrics.mockClear();
  mockPutSamples.mockResolvedValue({ samples: [] });
  mockComputeMetrics.mockResolvedValue({ metrics: {} });
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
    mockHRSamples = [hrSample({ uuid: 'hr-1' }), hrSample({ uuid: 'hr-2', value: 165 })];
    const session = await finishedSession();

    await syncBiometricEnrichment(USER, getToken);

    expect(mockPutSamples).toHaveBeenCalledTimes(1);
    const [, uploaded] = mockPutSamples.mock.calls[0];
    expect(uploaded).toHaveLength(2);
    expect(uploaded[0].metric_type).toBe('heart_rate');

    expect(mockComputeMetrics).toHaveBeenCalledTimes(1);
    const [, sessionID, hrMaxBPM, hrMaxSource, hrSource] = mockComputeMetrics.mock.calls[0];
    expect(sessionID).toBe(session.id);
    expect(hrMaxBPM).toBeGreaterThan(0);
    // Every producer of hrMaxBPM in this app today is the 220 - age estimate
    // — see biometric.ts's HRMaxSource doc comment.
    expect(hrMaxSource).toBe('estimated');
    expect(hrSource).toBe('window');

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
