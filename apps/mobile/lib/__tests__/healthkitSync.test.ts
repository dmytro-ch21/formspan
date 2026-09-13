/**
 * HealthKit import orchestration (N465), against a real SQLite database.
 *
 * `../db`'s `getDb` is redirected to a migrated fixture — the same pattern
 * `barcodeCache.test.ts` uses — so this exercises the REAL
 * `healthkit_imports` table (the local half of the dedup story) and the
 * real `local_sessions` writes `startLocalSession`/`saveLocalRunningDetail`/
 * `saveLocalSets` make, not a mock standing in for either. `../healthkit`'s
 * native-touching exports are replaced with fakes — the native call itself
 * is covered by nothing this environment can run (see that module's doc
 * comment) — while its pure `filterNewWorkouts`/`mapWorkoutToRunningDetail`
 * stay real via `jest.requireActual`, so the mapping under test here is the
 * one the app actually ships.
 */

/*
  All real imports first, jest.mock calls after — the same ordering
  sounds.test.ts documents: babel hoists jest.mock above every import in the
  compiled output regardless of source order, so this is cosmetic for
  runtime behaviour and is what keeps `import/first` quiet. Safe because
  none of the factories below reference a `mock*` binding at DEFINITION
  time — only the closures they return do, and those run inside tests.
*/
import { migratedFixture, type FixtureDb } from './support/sqlite';
import type { HealthKitRunningWorkout } from '../healthkit';
import {
  importedHealthKitUUIDs,
  importHealthKitRuns,
  readHealthKitImportEnabled,
  writeHealthKitImportEnabled,
} from '../healthkitSync';
import { listLocalSessions, readLocalRunningDetail, readLocalSession } from '../sessionStore';
import { dayString } from '../calendar';
import { localStepsView, recordStepsOutcome, writeStepsAsked, type StepSource, type StepsOutcome } from '../steps';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

// jest-expo stubs expo-crypto's randomUUID to the CONSTANT string
// "generated-uuid" (see plan.test.ts's own note on this) — every session
// this test creates would collide on that one primary key otherwise, which
// is exactly what the first version of this file did, silently overwriting
// rather than importing a second run.
let mockUuidSeq = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

let mockSupported = true;
let mockWorkouts: HealthKitRunningWorkout[] = [];
/** Set to a uuid to simulate a mid-import failure on that ONE workout —
 *  the mapping is the last write-adjacent call before the transaction's
 *  final insert, so throwing here proves the whole transaction, not just
 *  one statement in it, rolls back. */
let mockThrowMappingFor: string | null = null;
const mockRequestAuth = jest.fn().mockResolvedValue(true);
/** N569: what the steps read answers this pass — an outcome, or an Error to throw. */
let mockStepsOutcome: StepsOutcome | Error = { kind: 'steps', steps: 0 };
const mockQuerySteps = jest.fn((_window: unknown) =>
  mockStepsOutcome instanceof Error ? Promise.reject(mockStepsOutcome) : Promise.resolve(mockStepsOutcome),
);
/** N569: which platform owns steps — iOS under jest-expo; one test moves it to
 *  Android to prove this pass then leaves Health Connect's reading alone. */
let mockStepPlatform: StepSource | null = 'healthkit';
jest.mock('../steps', () => ({
  ...jest.requireActual('../steps'),
  platformStepSource: () => mockStepPlatform,
}));
jest.mock('../healthkit', () => {
  const real = jest.requireActual('../healthkit');
  return {
    ...real,
    isHealthKitSupported: () => mockSupported,
    requestHealthKitReadAuthorization: (options?: { includeSteps?: boolean }) => mockRequestAuth(options),
    queryHealthKitSteps: (window: unknown) => mockQuerySteps(window),
    queryRunningWorkouts: () => Promise.resolve(mockWorkouts),
    mapWorkoutToRunningDetail: (workout: HealthKitRunningWorkout, sessionID: string) => {
      if (workout.uuid === mockThrowMappingFor) {
        throw new Error('simulated failure mid-import');
      }
      return real.mapWorkoutToRunningDetail(workout, sessionID);
    },
  };
});

const mockRequestSync = jest.fn();
jest.mock('../sync', () => ({ request: (reason: string) => mockRequestSync(reason) }));

const USER = 'user_hk_1';

function workout(overrides: Partial<HealthKitRunningWorkout> = {}): HealthKitRunningWorkout {
  return {
    uuid: '11111111-1111-1111-1111-111111111111',
    startDate: '2026-09-01T07:00:00.000Z',
    endDate: '2026-09-01T07:30:00.000Z',
    durationSeconds: 1800,
    distanceMeters: 5000,
    route: [],
    ...overrides,
  };
}

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockSupported = true;
  mockWorkouts = [];
  mockThrowMappingFor = null;
  mockRequestAuth.mockClear();
  mockRequestSync.mockClear();
  mockStepsOutcome = { kind: 'steps', steps: 0 };
  mockStepPlatform = 'healthkit';
  mockQuerySteps.mockClear();
});

describe('the settings toggle', () => {
  it('defaults to off', async () => {
    expect(await readHealthKitImportEnabled(USER)).toBe(false);
  });

  it('round-trips on and off', async () => {
    await writeHealthKitImportEnabled(USER, true);
    expect(await readHealthKitImportEnabled(USER)).toBe(true);
    await writeHealthKitImportEnabled(USER, false);
    expect(await readHealthKitImportEnabled(USER)).toBe(false);
  });

  it('is scoped per user, like every other local preference', async () => {
    await writeHealthKitImportEnabled(USER, true);
    expect(await readHealthKitImportEnabled('somebody_else')).toBe(false);
  });
});

describe('importHealthKitRuns', () => {
  it('does nothing while the toggle is off', async () => {
    mockWorkouts = [workout()];
    const result = await importHealthKitRuns(USER);
    expect(result.imported).toBe(0);
    expect(await listLocalSessions(USER)).toEqual([]);
    expect(mockRequestSync).not.toHaveBeenCalled();
  });

  it('does nothing when this binary has no HealthKit module', async () => {
    await writeHealthKitImportEnabled(USER, true);
    mockSupported = false;
    mockWorkouts = [workout()];
    const result = await importHealthKitRuns(USER);
    expect(result.imported).toBe(0);
    expect(await listLocalSessions(USER)).toEqual([]);
  });

  it('creates a session for a new workout, tagged with source and uuid', async () => {
    await writeHealthKitImportEnabled(USER, true);
    mockWorkouts = [workout({ uuid: 'hk-a', distanceMeters: 5000, durationSeconds: 1500 })];

    const result = await importHealthKitRuns(USER);

    expect(result.imported).toBe(1);
    const sessions = await listLocalSessions(USER);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sport).toBe('running');
    // A past workout is a reflection log, not a live session — ended_at is
    // set at creation, same as startLocalSession's own contract.
    expect(sessions[0].ended_at).toBe('2026-09-01T07:30:00.000Z');

    const detail = await readLocalRunningDetail(USER, sessions[0].id);
    expect(detail?.source).toBe('healthkit');
    expect(detail?.healthkit_uuid).toBe('hk-a');
    expect(detail?.distance_m).toBe(5000);

    expect(await importedHealthKitUUIDs(USER)).toEqual(new Set(['hk-a']));
    expect(mockRequestSync).toHaveBeenCalledWith('healthkit-import');
  });

  // N507/#884: `Set.distance_m` (session_sets, what this asserts) is `*int`
  // on the wire, unlike the running module's own `distance_m` above (a
  // `*float64`) — a fractional watch-reported distance, essentially every
  // real one (`HKQuantity.doubleValue(for: .meter())`), used to fail to
  // decode server-side as a generic, permanent "invalid JSON body" 400 —
  // exactly the stuck "Run / Session / invalid JSON body" rows the Sync
  // screen showed. Every existing fixture in this file (this suite
  // included, before this test) used a round number, which is precisely how
  // the bug shipped unnoticed: `JSON.stringify(5000.0) === "5000"`.
  it('rounds a fractional watch-reported distance to a whole metre in session_sets', async () => {
    await writeHealthKitImportEnabled(USER, true);
    mockWorkouts = [workout({ uuid: 'hk-frac', distanceMeters: 2011.4523 })];

    await importHealthKitRuns(USER);

    const sessions = await listLocalSessions(USER);
    const session = await readLocalSession(USER, sessions[0].id);
    expect(session?.sets[0].distance_m).toBe(2011);
    expect(Number.isInteger(session?.sets[0].distance_m as number)).toBe(true);
  });

  it('re-running import does not duplicate an already-imported run', async () => {
    await writeHealthKitImportEnabled(USER, true);
    mockWorkouts = [workout({ uuid: 'hk-a' })];

    await importHealthKitRuns(USER);
    const second = await importHealthKitRuns(USER);

    expect(second.imported).toBe(0);
    expect(await listLocalSessions(USER)).toHaveLength(1);
  });

  it('imports only the workouts not already on this device’s ledger', async () => {
    await writeHealthKitImportEnabled(USER, true);
    mockWorkouts = [workout({ uuid: 'hk-a' })];
    await importHealthKitRuns(USER);

    mockWorkouts = [workout({ uuid: 'hk-a' }), workout({ uuid: 'hk-b', startDate: '2026-09-02T07:00:00.000Z', endDate: '2026-09-02T07:30:00.000Z' })];
    const result = await importHealthKitRuns(USER);

    expect(result.imported).toBe(1);
    expect(await listLocalSessions(USER)).toHaveLength(2);
    expect(await importedHealthKitUUIDs(USER)).toEqual(new Set(['hk-a', 'hk-b']));
  });

  it('a mid-workout failure leaves NEITHER a session NOR a ledger entry — the whole write is one transaction', async () => {
    // frontend-reviewer's finding: without a transaction, a failure between
    // startLocalSession and recordHealthKitImport leaves a session on disk
    // with no ledger row, which the NEXT pass reads as "never imported" and
    // creates a SECOND session for the same workout — compounding the exact
    // duplication this whole feature exists to prevent.
    await writeHealthKitImportEnabled(USER, true);
    mockWorkouts = [workout({ uuid: 'hk-fails' })];
    mockThrowMappingFor = 'hk-fails';

    await expect(importHealthKitRuns(USER)).rejects.toThrow('simulated failure mid-import');

    expect(await listLocalSessions(USER)).toEqual([]);
    expect(await importedHealthKitUUIDs(USER)).toEqual(new Set());
  });

  it('one workout failing does not lose an EARLIER workout already committed in this same pass', async () => {
    await writeHealthKitImportEnabled(USER, true);
    mockWorkouts = [
      workout({ uuid: 'hk-good', startDate: '2026-09-01T07:00:00.000Z' }),
      workout({ uuid: 'hk-fails', startDate: '2026-09-02T07:00:00.000Z' }),
    ];
    mockThrowMappingFor = 'hk-fails';

    // Oldest first (hk-good, then hk-fails) — hk-good's transaction commits
    // before hk-fails's throws, so it must survive even though the pass as
    // a whole rejects.
    await expect(importHealthKitRuns(USER)).rejects.toThrow('simulated failure mid-import');

    expect(await listLocalSessions(USER)).toHaveLength(1);
    expect(await importedHealthKitUUIDs(USER)).toEqual(new Set(['hk-good']));
  });

  it('scopes the ledger per user, so two athletes importing the same watch-recorded run both succeed locally', async () => {
    await writeHealthKitImportEnabled(USER, true);
    await writeHealthKitImportEnabled('another_user', true);
    mockWorkouts = [workout({ uuid: 'shared-uuid' })];

    await importHealthKitRuns(USER);
    const other = await importHealthKitRuns('another_user');

    expect(other.imported).toBe(1);
    expect(await listLocalSessions('another_user')).toHaveLength(1);
  });
});

/**
 * N569/#1130 — steps ride the import pass, local-only, and the pass never asks
 * for steps until the athlete has.
 */
describe('steps ride the import pass (N569/#1130)', () => {
  const today = () => dayString(new Date());

  it('Health sync off: "off", nothing read and nothing requested', async () => {
    await importHealthKitRuns(USER);

    expect(await localStepsView(USER, today())).toMatchObject({ state: 'off', source: 'healthkit' });
    expect(mockQuerySteps).not.toHaveBeenCalled();
    expect(mockRequestAuth).not.toHaveBeenCalled();
  });

  it('no HealthKit on this phone: "no_source" — not "off", not zero', async () => {
    await writeHealthKitImportEnabled(USER, true);
    mockSupported = false;

    await importHealthKitRuns(USER);

    expect(await localStepsView(USER, today())).toMatchObject({ state: 'no_source' });
    expect(mockQuerySteps).not.toHaveBeenCalled();
  });

  it('never asked: "not_asked", and the access the pass requests does NOT include steps', async () => {
    await writeHealthKitImportEnabled(USER, true);

    await importHealthKitRuns(USER);

    expect(mockRequestAuth).toHaveBeenCalledWith({ includeSteps: false });
    expect(mockQuerySteps).not.toHaveBeenCalled();
    expect(await localStepsView(USER, today())).toMatchObject({ state: 'not_asked', source: 'healthkit' });
  });

  it("once asked: the pass includes steps, reads them, and stores today's count on the phone", async () => {
    await writeHealthKitImportEnabled(USER, true);
    await writeStepsAsked(USER);
    mockStepsOutcome = { kind: 'steps', steps: 8412 };

    await importHealthKitRuns(USER);

    expect(mockRequestAuth).toHaveBeenCalledWith({ includeSteps: true });
    expect(await localStepsView(USER, today())).toMatchObject({
      state: 'read',
      today: { day: today(), steps: 8412, source: 'healthkit' },
    });
  });

  it('a refusal is recorded as refused — no row, and no zero', async () => {
    await writeHealthKitImportEnabled(USER, true);
    await writeStepsAsked(USER);
    mockStepsOutcome = { kind: 'refused' };

    await importHealthKitRuns(USER);

    expect(await localStepsView(USER, today())).toMatchObject({ state: 'refused', source: 'healthkit' });
    expect(mockFixture.raw.prepare('SELECT count(*) AS n FROM daily_steps').get()).toEqual({ n: 0 });
  });

  it('a genuine zero-step day is stored as 0', async () => {
    await writeHealthKitImportEnabled(USER, true);
    await writeStepsAsked(USER);
    mockStepsOutcome = { kind: 'steps', steps: 0 };

    await importHealthKitRuns(USER);

    expect(await localStepsView(USER, today())).toMatchObject({ state: 'read', today: { steps: 0 } });
  });

  it('a failed steps read writes nothing and does not stop the run import', async () => {
    await writeHealthKitImportEnabled(USER, true);
    await writeStepsAsked(USER);
    mockStepsOutcome = { kind: 'steps', steps: 5000 };
    await importHealthKitRuns(USER);

    mockStepsOutcome = new Error('native failure');
    mockWorkouts = [workout()];
    const result = await importHealthKitRuns(USER);

    expect(result.imported).toBe(1);
    expect(await localStepsView(USER, today())).toMatchObject({ state: 'read', today: { steps: 5000 } });
  });

  it("on Android this pass never touches steps — it cannot overwrite Health Connect's reading with \"no source\"", async () => {
    mockStepPlatform = 'health_connect';
    mockSupported = false; // no HealthKit on an Android phone
    await recordStepsOutcome(USER, 'health_connect', { kind: 'steps', steps: 6120 }, new Date());

    await importHealthKitRuns(USER);

    expect(mockQuerySteps).not.toHaveBeenCalled();
    expect(await localStepsView(USER, today())).toMatchObject({
      state: 'read',
      today: { steps: 6120, source: 'health_connect' },
    });
  });
});
