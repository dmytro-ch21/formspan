/**
 * N569 (#1130) — the iOS steps read, with the native module present.
 *
 * `healthkit.test.ts` runs with no HealthKit module linked (Nitro cannot load
 * under Jest), which pins the "no module" path and leaves everything past it
 * unreachable. This file replaces `@kingstinct/react-native-healthkit` with a
 * fake shaped like the calls `lib/healthkit.ts` makes, so the composition that
 * decides "zero or refused" on iPhone actually runs:
 *
 * - today's STATISTICS sum first (de-duplicated by source, like the Health app);
 * - only when that is empty, whether HealthKit shared any step sample this week;
 * - a denied read looks exactly like "empty both times", which is a refusal.
 *
 * The fake's shapes follow the package's v14.1.0 types and Swift (an empty
 * statistics query RESOLVES with no `sumQuantity`); what the real store returns
 * on a real phone is still device evidence (D30).
 */

import {
  healthKitReadTypes,
  queryHealthKitSteps,
  requestHealthKitReadAuthorization,
  requestHealthKitStepsAuthorization,
  STEPS_READ_TYPE,
} from '../healthkit';

let mockSum: number | undefined;
let mockRecent: unknown[] = [];
let mockStatsRejectsWith: unknown = null;
const mockStats = jest.fn((_identifier: string, _statistics: string[], _options: unknown) =>
  mockStatsRejectsWith
    ? Promise.reject(mockStatsRejectsWith)
    : Promise.resolve(mockSum == null ? {} : { sumQuantity: { unit: 'count', quantity: mockSum } }),
);
const mockSamples = jest.fn((_identifier: string, _options: unknown) => Promise.resolve(mockRecent));
const mockRequestAuthorization = jest.fn((_request: { toRead: readonly string[] }) => Promise.resolve(true));

jest.mock('@kingstinct/react-native-healthkit', () => ({
  isHealthDataAvailable: () => true,
  requestAuthorization: (request: { toRead: readonly string[] }) => mockRequestAuthorization(request),
  queryStatisticsForQuantity: (identifier: string, statistics: string[], options: unknown) =>
    mockStats(identifier, statistics, options),
  queryQuantitySamples: (identifier: string, options: unknown) => mockSamples(identifier, options),
}));

const window = {
  dayStart: new Date('2026-09-10T07:00:00.000Z'),
  lookbackStart: new Date('2026-09-03T07:00:00.000Z'),
  now: new Date('2026-09-10T21:00:00.000Z'),
};

beforeEach(() => {
  mockSum = undefined;
  mockRecent = [];
  mockStatsRejectsWith = null;
  mockStats.mockClear();
  mockSamples.mockClear();
  mockRequestAuthorization.mockClear();
});

describe('queryHealthKitSteps, with HealthKit present', () => {
  it("a count today comes from today's statistics sum, and the lookback is never asked", async () => {
    mockSum = 8412;

    await expect(queryHealthKitSteps(window)).resolves.toEqual({ kind: 'steps', steps: 8412 });
    expect(mockStats).toHaveBeenCalledWith(STEPS_READ_TYPE, ['cumulativeSum'], {
      filter: { date: { startDate: window.dayStart, endDate: window.now } },
      unit: 'count',
    });
    expect(mockSamples).not.toHaveBeenCalled();
  });

  it('nothing today, with a step sample shared this week: a genuine zero', async () => {
    mockRecent = [{ uuid: 's1' }];

    await expect(queryHealthKitSteps(window)).resolves.toEqual({ kind: 'steps', steps: 0 });
    expect(mockSamples).toHaveBeenCalledWith(STEPS_READ_TYPE, {
      filter: { date: { startDate: window.lookbackStart, endDate: window.now } },
      limit: 1,
      ascending: false,
      unit: 'count',
    });
  });

  it('nothing today and nothing shared all week — what a denied read looks like — is refused, never zero', async () => {
    await expect(queryHealthKitSteps(window)).resolves.toEqual({ kind: 'refused' });
  });

  it('a native failure throws rather than becoming a count', async () => {
    mockStatsRejectsWith = new Error('HealthKit query failed');

    await expect(queryHealthKitSteps(window)).rejects.toThrow('HealthKit query failed');
  });
});

describe('asking HealthKit for access, with HealthKit present', () => {
  it('a pass not yet asked for steps requests every type except steps', async () => {
    await requestHealthKitReadAuthorization();
    expect(mockRequestAuthorization).toHaveBeenCalledWith({ toRead: healthKitReadTypes(false) });
    expect(mockRequestAuthorization.mock.calls[0][0].toRead).not.toContain(STEPS_READ_TYPE);
  });

  it('the explicit ask, and a pass after it, include steps', async () => {
    await requestHealthKitStepsAuthorization();
    await requestHealthKitReadAuthorization({ includeSteps: true });
    for (const [request] of mockRequestAuthorization.mock.calls) {
      expect(request.toRead).toContain(STEPS_READ_TYPE);
    }
  });
});
