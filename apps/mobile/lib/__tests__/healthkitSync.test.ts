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
import { listLocalSessions, readLocalRunningDetail } from '../sessionStore';

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
const mockRequestAuth = jest.fn().mockResolvedValue(true);
jest.mock('../healthkit', () => {
  const real = jest.requireActual('../healthkit');
  return {
    ...real,
    isHealthKitSupported: () => mockSupported,
    requestHealthKitReadAuthorization: () => mockRequestAuth(),
    queryRunningWorkouts: () => Promise.resolve(mockWorkouts),
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
  mockRequestAuth.mockClear();
  mockRequestSync.mockClear();
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
