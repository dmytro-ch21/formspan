/**
 * Health Connect enrichment orchestration (N478), against a real SQLite
 * database — same discipline as `healthkitSync.test.ts`: `../db` is
 * redirected to a migrated fixture (the real `local_sessions` and
 * `health_connect_enrichment` tables, not a mock standing in for either),
 * while `../healthConnect` (the native boundary — covered by nothing this
 * environment can run, see that module's doc comment), the network half of
 * `../biometric` (formerly `../biometricApi`, consolidated by N485/#837) and
 * `../profile` are replaced with controllable fakes. The PURE half of
 * `../biometric` (`hrMaxFromDateOfBirth`, `selectEnrichmentCandidates`, ...)
 * stays real via `jest.requireActual`, same as `biometricSync.test.ts`'s own
 * pattern — the decision under test here is the one the app actually ships.
 */

/*
  Real imports first, jest.mock calls after — see healthkitSync.test.ts's own
  note on why this is safe despite `import/first` reading oddly here.
*/
import { migratedFixture, type FixtureDb } from './support/sqlite';
import { upsert, type LocalSession } from '../sessionStore';
import { HealthConnectPermissionError, type HeartRateReading, type Vo2MaxReading } from '../healthConnect';
import type { SessionMetrics } from '../biometric';
import {
  readHealthConnectImportEnabled,
  syncHealthConnectBiometrics,
  writeHealthConnectImportEnabled,
} from '../healthConnectSync';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

let mockSupported = true;
let mockHeartRateReadings: HeartRateReading[] = [];
let mockVo2MaxReadings: Vo2MaxReading[] = [];
const mockRequestAuth = jest.fn().mockResolvedValue(true);
const mockQueryHeartRate = jest.fn((_startedAt: string, _endedAt: string) =>
  Promise.resolve(mockHeartRateReadings),
);
const mockQueryVo2Max = jest.fn((_since: string, _until: string) =>
  Promise.resolve(mockVo2MaxReadings),
);
/** W15/#944 — what the walk/hike read does this pass: resolve empty, or
 *  reject with whatever is set here (a `HealthConnectPermissionError` to
 *  simulate a refused grant, a plain Error for anything transient). */
let mockExerciseRejectsWith: unknown = null;
const mockQueryExercise = jest.fn((_since: string, _until: string) =>
  mockExerciseRejectsWith ? Promise.reject(mockExerciseRejectsWith) : Promise.resolve([]),
);
/** Same shape for the heart-rate read, so a refused HeartRate grant can be
 *  simulated without disturbing `mockHeartRateReadings`'s happy path. */
let mockHeartRateRejectsWith: unknown = null;
jest.mock('../healthConnect', () => {
  const real = jest.requireActual('../healthConnect');
  return {
    ...real,
    isHealthConnectSupported: () => Promise.resolve(mockSupported),
    requestHealthConnectReadAuthorization: () => mockRequestAuth(),
    queryHeartRateSamples: (startedAt: string, endedAt: string) =>
      mockHeartRateRejectsWith
        ? Promise.reject(mockHeartRateRejectsWith)
        : mockQueryHeartRate(startedAt, endedAt),
    queryVo2MaxReadings: (since: string, until: string) => mockQueryVo2Max(since, until),
    queryOtherExerciseSessions: (since: string, until: string) => mockQueryExercise(since, until),
  };
});

/** Controls what `computeSessionMetrics` reports back — the server is
 *  authoritative on `hr_source`/`sample_count`, so tests set this directly
 *  rather than deriving it from the uploaded samples. */
let mockComputedMetrics: Partial<SessionMetrics> = {};
let mockComputeThrows: string | null = null;
let mockPutSamplesThrows = false;
const mockPutSamples = jest.fn((...args: unknown[]) => {
  if (mockPutSamplesThrows) return Promise.reject(new Error('simulated PutSamples failure'));
  const samples = args[1] as unknown[];
  return Promise.resolve(samples);
});
const mockComputeSessionMetrics = jest.fn((...args: unknown[]) => {
  const sessionID = args[1] as string;
  if (mockComputeThrows === sessionID) return Promise.reject(new Error('simulated compute failure'));
  return Promise.resolve({
    session_id: sessionID,
    avg_hr_bpm: null,
    max_hr_bpm: null,
    trimp: null,
    active_kcal: null,
    hr_max_bpm: null,
    hr_max_source: null,
    time_in_zones: {},
    hr_source: 'none',
    sample_count: 0,
    hr_window_start: new Date().toISOString(),
    hr_window_end: new Date().toISOString(),
    computed_at: new Date().toISOString(),
    rule_version: 1,
    ...mockComputedMetrics,
  } satisfies SessionMetrics);
});
jest.mock('../biometric', () => {
  const real = jest.requireActual('../biometric');
  return {
    ...real,
    putBiometricSamples: (...args: unknown[]) => mockPutSamples(...args),
    computeSessionMetrics: (...args: unknown[]) => mockComputeSessionMetrics(...args),
  };
});

let mockDateOfBirth: string | null = '1996-01-15';
let mockProfileThrows = false;
jest.mock('../profile', () => ({
  getProfile: () =>
    mockProfileThrows
      ? Promise.reject(new Error('simulated profile fetch failure'))
      : Promise.resolve({ date_of_birth: mockDateOfBirth }),
}));

const USER = 'user_hc_1';
const getToken = async () => 'fake-token';

function heartRateReading(overrides: Partial<HeartRateReading> = {}): HeartRateReading {
  return {
    id: 'hc:hr:rec-1:2026-09-01T07:15:00.000Z',
    time: '2026-09-01T07:15:00.000Z',
    beatsPerMinute: 140,
    dataOrigin: 'com.garmin.android.apps.connectmobile',
    ...overrides,
  };
}

/** Seeds a finished, server-confirmed ("remote") session directly — the
 *  shape `syncHealthConnectBiometrics`'s own candidate query needs, without
 *  going through the full start/finish/push flow this test isn't about. */
async function seedFinishedRemoteSession(
  id: string,
  startedAt: string,
  endedAt: string,
): Promise<void> {
  const session: LocalSession = {
    id,
    user_id: USER,
    workout_id: null,
    sport: 'bjj',
    name: 'Session',
    intent: 'normal',
    started_at: startedAt,
    ended_at: endedAt,
    notes: '',
    sets: [],
    created_at: startedAt,
    updated_at: startedAt,
    dirty: false,
  };
  await upsert(session, USER, false, true);
}

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockSupported = true;
  mockHeartRateReadings = [];
  mockVo2MaxReadings = [];
  mockComputedMetrics = {};
  mockComputeThrows = null;
  mockPutSamplesThrows = false;
  mockDateOfBirth = '1996-01-15';
  mockProfileThrows = false;
  mockExerciseRejectsWith = null;
  mockHeartRateRejectsWith = null;
  mockQueryExercise.mockClear();
  mockRequestAuth.mockClear();
  mockQueryHeartRate.mockClear();
  mockQueryVo2Max.mockClear();
  mockPutSamples.mockClear();
  mockComputeSessionMetrics.mockClear();
});

describe('the settings toggle', () => {
  it('defaults to off', async () => {
    expect(await readHealthConnectImportEnabled(USER)).toBe(false);
  });

  it('round-trips on and off', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    expect(await readHealthConnectImportEnabled(USER)).toBe(true);
    await writeHealthConnectImportEnabled(USER, false);
    expect(await readHealthConnectImportEnabled(USER)).toBe(false);
  });

  it('is scoped per user, like every other local preference', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    expect(await readHealthConnectImportEnabled('somebody_else')).toBe(false);
  });
});

describe('syncHealthConnectBiometrics', () => {
  it('does nothing while the toggle is off', async () => {
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.attempted).toBe(0);
    expect(mockPutSamples).not.toHaveBeenCalled();
    expect(mockComputeSessionMetrics).not.toHaveBeenCalled();
  });

  it('does nothing when this binary has no Health Connect module', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    mockSupported = false;
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');

    const result = await syncHealthConnectBiometrics(USER, getToken);
    expect(result.attempted).toBe(0);
    expect(mockQueryHeartRate).not.toHaveBeenCalled();
  });

  it('uploads heart-rate samples and computes session metrics for a finished, synced session', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];
    mockComputedMetrics = { hr_source: 'window', sample_count: 1 };

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.attempted).toBe(1);
    expect(mockPutSamples).toHaveBeenCalledTimes(1);
    const [, samples] = mockPutSamples.mock.calls[0];
    expect(samples).toEqual([
      expect.objectContaining({
        id: 'hc:hr:rec-1:2026-09-01T07:15:00.000Z',
        metric_type: 'heart_rate',
        source: 'garmin',
        source_platform: 'health_connect',
        value: 140,
        unit: 'bpm',
        measured_at: '2026-09-01T07:15:00.000Z',
      }),
    ]);

    expect(mockComputeSessionMetrics).toHaveBeenCalledWith(getToken, 's1', 190, 'estimated', 'window');

    const ledger = await mockFixture.getAllAsync<{ hr_source: string; sample_count: number }>(
      `SELECT hr_source, sample_count FROM health_connect_enrichment WHERE user_id = ? AND session_id = ?`,
      USER,
      's1',
    );
    expect(ledger).toEqual([{ hr_source: 'window', sample_count: 1 }]);
  });

  it("records hr_source: 'none' when Health Connect has zero samples for the window — never fabricated", async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [];
    mockComputedMetrics = { hr_source: 'none', sample_count: 0 };

    await syncHealthConnectBiometrics(USER, getToken);

    expect(mockPutSamples).not.toHaveBeenCalled(); // nothing to upload
    // Still asked the backend to compute — it is the authority on the
    // result, and doing so is what gives the athlete a real "none" row
    // rather than one that silently never exists.
    expect(mockComputeSessionMetrics).toHaveBeenCalledWith(getToken, 's1', 190, 'estimated', 'window');

    const ledger = await mockFixture.getAllAsync<{ hr_source: string }>(
      `SELECT hr_source FROM health_connect_enrichment WHERE user_id = ? AND session_id = ?`,
      USER,
      's1',
    );
    expect(ledger).toEqual([{ hr_source: 'none' }]);
  });

  it('does not re-enrich a session already holding real (window) evidence', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];
    mockComputedMetrics = { hr_source: 'window', sample_count: 1 };

    await syncHealthConnectBiometrics(USER, getToken);
    mockPutSamples.mockClear();
    mockComputeSessionMetrics.mockClear();

    const second = await syncHealthConnectBiometrics(USER, getToken);

    expect(second.attempted).toBe(0);
    expect(mockPutSamples).not.toHaveBeenCalled();
    expect(mockComputeSessionMetrics).not.toHaveBeenCalled();
  });

  it('uploads samples but skips ComputeMetrics — and leaves the ledger retryable — when no HRmax is available', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];
    mockDateOfBirth = null; // no HRmax derivable

    await syncHealthConnectBiometrics(USER, getToken);

    expect(mockPutSamples).toHaveBeenCalledTimes(1); // raw data is still worth having
    expect(mockComputeSessionMetrics).not.toHaveBeenCalled(); // nothing valid to compute with

    const ledger = await mockFixture.getAllAsync<{ hr_source: string }>(
      `SELECT hr_source FROM health_connect_enrichment WHERE user_id = ? AND session_id = ?`,
      USER,
      's1',
    );
    // Recorded as 'none', not 'window' — there is no server-confirmed
    // result to persist, and 'none' keeps the retry window open in case
    // the athlete adds a date of birth in the next few days.
    expect(ledger).toEqual([{ hr_source: 'none' }]);
  });

  it('a profile fetch failure degrades to "no HRmax this pass" rather than throwing the whole sync', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];
    mockProfileThrows = true;

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.attempted).toBe(1);
    expect(mockComputeSessionMetrics).not.toHaveBeenCalled();
  });

  it('one session failing to sync does not lose an already-succeeded session in the same pass, and leaves no ledger row for the failure', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('good', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    await seedFinishedRemoteSession('fails', '2026-09-02T07:00:00.000Z', '2026-09-02T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];
    mockComputedMetrics = { hr_source: 'window', sample_count: 1 };
    mockComputeThrows = 'fails';

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.attempted).toBe(1); // only the good one counted

    const rows = await mockFixture.getAllAsync<{ session_id: string }>(
      `SELECT session_id FROM health_connect_enrichment WHERE user_id = ?`,
      USER,
    );
    expect(rows.map((r) => r.session_id)).toEqual(['good']);
  });

  it('stops mid-pass, before writing anything more, once `stillCurrent` reports the identity has moved on', async () => {
    // frontend-reviewer's finding: a sign-out + different sign-in landing
    // inside an in-flight await could otherwise authenticate a later
    // putBiometricSamples/computeSessionMetrics call as the NEW athlete
    // while this loop is still reasoning about the OLD one's sessions.
    await writeHealthConnectImportEnabled(USER, true);
    // Candidates are read most-recent-started-first (`ORDER BY started_at
    // DESC`), so 'newer' is what the loop reaches on its FIRST iteration —
    // named for processing order, not chronology, to keep the assertions
    // below honest about what actually ran.
    await seedFinishedRemoteSession('older', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    await seedFinishedRemoteSession('newer', '2026-09-02T07:00:00.000Z', '2026-09-02T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];
    mockComputedMetrics = { hr_source: 'window', sample_count: 1 };
    mockVo2MaxReadings = [
      {
        id: 'hc:vo2:rec-9',
        time: '2026-09-01T09:00:00.000Z',
        vo2MillilitersPerMinuteKilogram: 45.2,
        dataOrigin: 'com.garmin.android.apps.connectmobile',
      },
    ];

    let calls = 0;
    const stillCurrent = () => {
      calls++;
      return calls === 1; // true for the first iteration only
    };

    const result = await syncHealthConnectBiometrics(USER, getToken, { stillCurrent });

    expect(result.attempted).toBe(1); // 'older' and VO2max never ran
    expect(mockComputeSessionMetrics).toHaveBeenCalledTimes(1);
    expect(mockComputeSessionMetrics).toHaveBeenCalledWith(getToken, 'newer', 190, 'estimated', 'window');
    // VO2max is the LAST network call this pass makes — confirms the guard
    // covers it too, not only the per-session loop.
    expect(mockPutSamples).not.toHaveBeenCalledWith(
      getToken,
      expect.arrayContaining([expect.objectContaining({ metric_type: 'vo2_max' })]),
    );
  });

  it('runs the whole pass normally when no `stillCurrent` is supplied (the shape every other test in this file calls it with)', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];
    mockComputedMetrics = { hr_source: 'window', sample_count: 1 };

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.attempted).toBe(1);
  });

  it('imports VO2max as a profile-level trend, independent of any session', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    // No sessions at all — VO2max import must not depend on having one.
    mockVo2MaxReadings = [
      {
        id: 'hc:vo2:rec-9',
        time: '2026-09-01T09:00:00.000Z',
        vo2MillilitersPerMinuteKilogram: 45.2,
        dataOrigin: 'com.garmin.android.apps.connectmobile',
      },
    ];

    await syncHealthConnectBiometrics(USER, getToken);

    expect(mockPutSamples).toHaveBeenCalledWith(
      getToken,
      expect.arrayContaining([
        expect.objectContaining({
          id: 'hc:vo2:rec-9',
          metric_type: 'vo2_max',
          value: 45.2,
          source: 'garmin',
        }),
      ]),
    );
  });

  it('scopes candidates and the ledger per user', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await writeHealthConnectImportEnabled('other_user', true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];

    await syncHealthConnectBiometrics('other_user', getToken);

    expect(mockComputeSessionMetrics).not.toHaveBeenCalled(); // s1 belongs to USER, not other_user
  });
});

/**
 * W15/#944 — a refused Health Connect grant is REPORTED, not swallowed.
 *
 * The bug: `READ_EXERCISE` was never declared in the manifest, so every
 * `ExerciseSession` read threw a SecurityException that came back as `[]`,
 * and this function correctly did nothing with nothing. Walk/hike detection
 * was dead behind a Settings toggle that said it worked, and no assertion on
 * `attempted`, on the ledger, or on any mock could have seen it — they all
 * looked exactly like an athlete with no walks. These tests pin the one
 * thing that now differs: the pass says which record type was refused.
 */
describe('syncHealthConnectBiometrics — a refused grant is reported, not swallowed (W15/#944)', () => {
  it('reports ExerciseSession as not permitted, and still enriches heart rate in the same pass', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockHeartRateReadings = [heartRateReading()];
    mockComputedMetrics = { hr_source: 'window', sample_count: 1 };
    mockExerciseRejectsWith = new HealthConnectPermissionError('ExerciseSession');

    const result = await syncHealthConnectBiometrics(USER, getToken);

    // The refusal is the pass's answer, by name...
    expect(result.notPermitted).toEqual(['ExerciseSession']);
    // ...and it cost the heart-rate half of the pass nothing: the walk read
    // is best-effort by design, and a refused one must stay that way.
    expect(result.attempted).toBe(1);
    expect(mockPutSamples).toHaveBeenCalledTimes(1);
    expect(mockComputeSessionMetrics).toHaveBeenCalledTimes(1);
  });

  it('does NOT report a transient exercise-read failure as a refusal', async () => {
    // The distinction is the whole fix. An IO error and a refused grant used
    // to be the same `[]`; they are now different, and only one of them is a
    // permission problem for somebody to act on.
    await writeHealthConnectImportEnabled(USER, true);
    mockExerciseRejectsWith = new Error('simulated transient read failure');

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.notPermitted).toEqual([]);
  });

  it('reports nothing when every read is permitted', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.notPermitted).toEqual([]);
    expect(mockQueryExercise).toHaveBeenCalledTimes(1);
  });

  it('reports a refused HeartRate grant ONCE and stops the per-session loop, leaving every ledger row untouched', async () => {
    // A refused HeartRate grant is identical for every candidate, so the
    // loop ends at the first rather than repeating the refusal per session
    // — and leaves all of them un-attempted, so a later grant picks up
    // every one.
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    await seedFinishedRemoteSession('s2', '2026-09-02T07:00:00.000Z', '2026-09-02T08:00:00.000Z');
    mockHeartRateRejectsWith = new HealthConnectPermissionError('HeartRate');

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.notPermitted).toEqual(['HeartRate']);
    expect(result.attempted).toBe(0);
    expect(mockPutSamples).not.toHaveBeenCalled();
    const ledger = await mockFixture.getAllAsync<{ session_id: string }>(
      `SELECT session_id FROM health_connect_enrichment WHERE user_id = ?`,
      USER,
    );
    expect(ledger).toEqual([]);
  });

  it('lists each refused record type once, in the order encountered', async () => {
    await writeHealthConnectImportEnabled(USER, true);
    await seedFinishedRemoteSession('s1', '2026-09-01T07:00:00.000Z', '2026-09-01T08:00:00.000Z');
    mockExerciseRejectsWith = new HealthConnectPermissionError('ExerciseSession');
    mockHeartRateRejectsWith = new HealthConnectPermissionError('HeartRate');

    const result = await syncHealthConnectBiometrics(USER, getToken);

    expect(result.notPermitted).toEqual(['ExerciseSession', 'HeartRate']);
  });
});
