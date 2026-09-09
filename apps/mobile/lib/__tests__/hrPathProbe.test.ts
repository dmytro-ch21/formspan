import { HEALTH_HR_PROBE_HOURS, healthStoreHasRecentHeartRate } from '../hrPathProbe';
import { queryHeartRateSamples as queryHC } from '../healthConnect';
import { queryHeartRateSamples as queryHK } from '../healthkit';

/**
 * N552/#1021 — the one read behind "…so that route is working".
 *
 * Mocked at the two store modules rather than at the native layer: what is
 * under test here is the probe's own contract (bounded window, right store,
 * and `null` — never `false` — when the question could not be answered), not
 * either store's query, which has its own tests.
 */

jest.mock('../healthkit', () => ({ queryHeartRateSamples: jest.fn() }));
jest.mock('../healthConnect', () => ({ queryHeartRateSamples: jest.fn() }));

const hk = queryHK as jest.MockedFunction<typeof queryHK>;
const hc = queryHC as jest.MockedFunction<typeof queryHC>;

const NOW = new Date('2026-09-09T12:00:00.000Z');

beforeEach(() => {
  hk.mockReset();
  hc.mockReset();
});

describe('healthStoreHasRecentHeartRate', () => {
  it('true when the store holds a reading, false when it holds none', async () => {
    hk.mockResolvedValue([{ uuid: 'a', value: 61, unit: 'count/min', measuredAt: NOW.toISOString(), sourceName: 'Watch', sourceBundleId: 'com.apple.health' }]);
    await expect(healthStoreHasRecentHeartRate('healthkit', NOW)).resolves.toBe(true);

    hk.mockResolvedValue([]);
    await expect(healthStoreHasRecentHeartRate('healthkit', NOW)).resolves.toBe(false);
  });

  it('asks the store for exactly the last 24 hours', async () => {
    hk.mockResolvedValue([]);
    await healthStoreHasRecentHeartRate('healthkit', NOW);
    const [start, end] = hk.mock.calls[0];
    // Literal, not `HEALTH_HR_PROBE_HOURS * …` — a fixture derived from the
    // constant under test cannot pin it (W19's own lesson).
    expect(start.toISOString()).toBe('2026-09-08T12:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-09T12:00:00.000Z');
    expect(HEALTH_HR_PROBE_HOURS).toBe(24);
  });

  it('asks Health Connect on Android, with RFC3339 bounds', async () => {
    hc.mockResolvedValue([{ id: 'x', time: NOW.toISOString(), beatsPerMinute: 70, dataOrigin: null }]);
    await expect(healthStoreHasRecentHeartRate('health_connect', NOW)).resolves.toBe(true);
    expect(hc.mock.calls[0]).toEqual(['2026-09-08T12:00:00.000Z', '2026-09-09T12:00:00.000Z']);
    // ...and never the other store's query.
    expect(hk).not.toHaveBeenCalled();
  });

  it('a read that throws is unknown, NOT "found none"', async () => {
    // The whole reason this returns `boolean | null`: a refused Health
    // Connect grant throws here (W15/#954), and reporting that as `false`
    // would put "VOLA found none there" on screen for an athlete whose store
    // is full — the exact "a refusal read as no data" defect W15 closed.
    hc.mockRejectedValue(new Error('PERMISSION_ERROR'));
    await expect(healthStoreHasRecentHeartRate('health_connect', NOW)).resolves.toBeNull();

    hk.mockRejectedValue(new Error('boom'));
    await expect(healthStoreHasRecentHeartRate('healthkit', NOW)).resolves.toBeNull();
  });
});
