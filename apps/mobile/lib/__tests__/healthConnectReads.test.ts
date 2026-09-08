/**
 * W15/#944 — the three Health Connect reads tell a REFUSED grant apart from
 * an empty window, and only that.
 *
 * `healthConnect.test.ts` deliberately runs as iOS (`jest-expo`'s default),
 * which makes `load()` return `null` before any native call and is the right
 * way to pin the module-scope platform guard. It also means that file can
 * never reach the `catch` blocks this ticket is about — they sit BEHIND the
 * guard. So this file runs as Android, with the native module replaced by a
 * fake whose `readRecords` rejects with whatever a test says, and asserts on
 * the one decision those catches now make: is this rejection Health Connect
 * saying "not permitted"?
 *
 * Why the fake rejects with `{ code: 'PERMISSION_ERROR' }` and not a message:
 * that is the package's own vendor-defined code for a native
 * `SecurityException` (`ExceptionsUtils.kt`, `rejectWithException`), and it
 * reaches JS unwrapped — `readRecords` in the package's TypeScript returns
 * the bridge promise directly. A test built on a message substring would
 * pass against this fake and could be wrong against the real thing; the code
 * is the contract.
 */

import {
  HealthConnectPermissionError,
  isHealthConnectPermissionError,
  queryHeartRateSamples,
  queryOtherExerciseSessions,
  queryVo2MaxReadings,
} from '../healthConnect';

// Real import first, jest.mock calls after — the same shape as
// `healthConnectSync.test.ts`, and for the same reason: babel-jest HOISTS
// every `jest.mock` above every import regardless of where it sits in the
// file, so the Platform and native-module fakes below are in place before
// `../healthConnect` evaluates either way. Writing it in source order would
// be a lie about execution order, and it is what `import/first` flags.
// Platform first, before anything imports `react-native` — `load()` reads
// `Platform.OS` at module scope, so the override has to be in place before
// `../healthConnect` is evaluated. This is jest-expo's own Platform module,
// replaced rather than reassigned, because `Platform.OS` is a getter there.
jest.mock('react-native/Libraries/Utilities/Platform', () => {
  const platform = {
    OS: 'android',
    select: (spec: Record<string, unknown>) => spec.android ?? spec.default,
    Version: 35,
    isTV: false,
    isTesting: true,
    constants: {},
  };
  // RN's own modules import this as an ES default (`Platform.default.select`),
  // while `react-native`'s index re-exports the CJS shape — so both are
  // served, or the first `Platform.select` inside react-native throws
  // "Cannot read properties of undefined (reading 'select')".
  return { __esModule: true, default: platform, ...platform };
});

/** What the fake native `readRecords` does next: resolve with records, or
 *  reject with this. Set per test; reset in `beforeEach`. */
let mockReadRejectsWith: unknown = null;
let mockRecords: unknown[] = [];
const mockReadRecords = jest.fn((_recordType: string, _options: unknown) =>
  mockReadRejectsWith ? Promise.reject(mockReadRejectsWith) : Promise.resolve({ records: mockRecords }),
);

jest.mock('react-native-health-connect', () => ({
  // `SDK_AVAILABLE` — the literal `lib/healthConnect.ts` compares against.
  getSdkStatus: () => Promise.resolve(3),
  initialize: () => Promise.resolve(true),
  requestPermission: (perms: unknown[]) => Promise.resolve(perms),
  readRecords: (recordType: string, options: unknown) => mockReadRecords(recordType, options),
}));

/** The exact shape the RN bridge hands JS for a rejected native promise:
 *  an `Error` carrying the vendor `code`. */
function bridgeError(code: string, message = 'native'): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

beforeEach(() => {
  mockReadRejectsWith = null;
  mockRecords = [];
  mockReadRecords.mockClear();
});

describe('isHealthConnectPermissionError — the classification, pinned exactly', () => {
  it("is true for the package's PERMISSION_ERROR code", () => {
    expect(isHealthConnectPermissionError(bridgeError('PERMISSION_ERROR'))).toBe(true);
  });

  it('is false for every other code the package can reject with', () => {
    // A representative sample of `ExceptionsUtils.kt`'s other branches —
    // each of these is "try again later", and none of them is a grant.
    for (const code of ['IO_EXCEPTION', 'SERVICE_UNAVAILABLE', 'SDK_VERSION_ERROR', 'UNKNOWN_ERROR']) {
      expect(isHealthConnectPermissionError(bridgeError(code))).toBe(false);
    }
  });

  it('does not match on the message — only the code is the contract', () => {
    // Guards the obvious "helpful" rewrite to `message.includes('permission')`,
    // which would pass a fake and drift against the real package.
    expect(isHealthConnectPermissionError(new Error('permission denied'))).toBe(false);
    expect(isHealthConnectPermissionError(bridgeError('IO_EXCEPTION', 'PERMISSION_ERROR'))).toBe(false);
  });

  it('is false for the shapes a catch can also receive', () => {
    expect(isHealthConnectPermissionError(undefined)).toBe(false);
    expect(isHealthConnectPermissionError(null)).toBe(false);
    expect(isHealthConnectPermissionError('PERMISSION_ERROR')).toBe(false);
    expect(isHealthConnectPermissionError({})).toBe(false);
  });
});

describe('the three reads, behind the guard, on Android', () => {
  const since = '2026-09-01T00:00:00.000Z';
  const until = '2026-09-04T00:00:00.000Z';

  it.each([
    ['ExerciseSession', () => queryOtherExerciseSessions(since, until)],
    ['HeartRate', () => queryHeartRateSamples(since, until)],
    ['Vo2Max', () => queryVo2MaxReadings(since, until)],
  ] as const)('%s: a refused grant THROWS a typed error naming the record type', async (recordType, read) => {
    mockReadRejectsWith = bridgeError('PERMISSION_ERROR');

    await expect(read()).rejects.toBeInstanceOf(HealthConnectPermissionError);
    await expect(read()).rejects.toMatchObject({ recordType });
  });

  it.each([
    ['ExerciseSession', () => queryOtherExerciseSessions(since, until)],
    ['HeartRate', () => queryHeartRateSamples(since, until)],
    ['Vo2Max', () => queryVo2MaxReadings(since, until)],
  ] as const)('%s: any other failure still resolves to an empty array — the old contract, kept', async (_recordType, read) => {
    // The "return `[]`, never throw" posture every consumer was written
    // against is preserved for everything that is genuinely transient.
    mockReadRejectsWith = bridgeError('IO_EXCEPTION');

    await expect(read()).resolves.toEqual([]);
  });

  it('an empty window still resolves to an empty array, and is not confused with a refusal', async () => {
    mockRecords = [];

    await expect(queryOtherExerciseSessions(since, until)).resolves.toEqual([]);
    expect(mockReadRecords).toHaveBeenCalledWith(
      'ExerciseSession',
      expect.objectContaining({ timeRangeFilter: expect.objectContaining({ operator: 'between' }) }),
    );
  });

  it('a permitted read still returns real records — the fix changed nothing on the happy path', async () => {
    mockRecords = [
      {
        metadata: { id: 'rec-walk-1', dataOrigin: 'com.google.android.apps.fitness' },
        exerciseType: 79, // WALKING
        startTime: '2026-09-02T07:00:00.000Z',
        endTime: '2026-09-02T07:30:00.000Z',
      },
    ];

    await expect(queryOtherExerciseSessions(since, until)).resolves.toEqual([
      {
        id: 'rec-walk-1',
        type: 'walking',
        startDate: '2026-09-02T07:00:00.000Z',
        endDate: '2026-09-02T07:30:00.000Z',
        durationSeconds: 1800,
      },
    ]);
  });
});
