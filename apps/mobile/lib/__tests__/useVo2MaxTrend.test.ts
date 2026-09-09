import { renderHook, waitFor } from '@testing-library/react-native';
import { useVo2MaxTrend } from '../useVo2MaxTrend';
import { RANGE_DAYS } from '../trendSeries';
import { SERVER_MAX_LIST_RANGE_DAYS, VO2MAX_FETCH_DAYS, vo2MaxRanges } from '../vo2MaxSource';

/**
 * W16/#945 — what `useVo2MaxTrend` actually SENDS.
 *
 * This hook asked `GET /v1/biometric/samples` for `365 * 3 + 14` days from
 * the day it was written (N477). The server caps that endpoint at 400 days
 * and refused every request with a 400, which the hook's own catch turned
 * into "Couldn't load your VO2max trend" — on every load, for every athlete,
 * on both platforms. The chart had never rendered. Nothing noticed for the
 * same reason nothing noticed the You screen's date-only bounds: no test
 * mocked the network, and an absent server fails exactly like a refused
 * request. Same idiom as `useDetectedActivity.test.ts`; the assertion is on
 * the call's arguments, because that is where the bug was.
 */
const mockList = jest.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
jest.mock('../biometric', () => ({
  ...jest.requireActual('../biometric'),
  listBiometricSamples: (...a: unknown[]) => mockList(...a),
}));

const getToken = async () => 'tok';
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([]);
});

describe('useVo2MaxTrend — the request the server will accept', () => {
  it('sends RFC3339 bounds spanning less than the 400-day cap, for the default window', async () => {
    renderHook(() => useVo2MaxTrend(getToken, '6M', VO2MAX_FETCH_DAYS));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    const [, metric, from, to] = mockList.mock.calls[0] as [unknown, string, string, string];
    expect(metric).toBe('vo2_max');
    expect(from).toMatch(RFC3339);
    expect(to).toMatch(RFC3339);
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
  });

  it('stays under the cap even when a caller asks for the old three years', async () => {
    // The screen used to pass `365 * 3`. The helper clamps; the hook must not
    // route around it. (`1Y`, not `All`: F34/#955 took `All` off this screen
    // because a capped fetch cannot honour an unbounded label.)
    renderHook(() => useVo2MaxTrend(getToken, '1Y', 365 * 3));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    const [, , from, to] = mockList.mock.calls[0] as [unknown, string, string, string];
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
  });

  it('fetches back far enough to fill the WIDEST range the screen offers', async () => {
    // F34/#955 — the other direction of the same drift, and the one the old
    // test could not see: staying under the cap says nothing about whether the
    // window covers the chips. `All` was offered on a fetch that could not
    // reach the athlete's first reading, so it showed ~13 months under a label
    // meaning everything. This asserts the invariant that replaced it — every
    // preset on screen is entirely inside what was actually requested — and it
    // goes red if either the offered set widens or the fetch narrows.
    const widest = vo2MaxRanges().at(-1)!.key as keyof typeof RANGE_DAYS;
    renderHook(() => useVo2MaxTrend(getToken, widest, VO2MAX_FETCH_DAYS));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    const [, , from, to] = mockList.mock.calls[0] as [unknown, string, string, string];
    const fetchedDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(fetchedDays).toBeGreaterThanOrEqual(RANGE_DAYS[widest]);
    // ...and still under the cap, so the two constraints hold at once rather
    // than one being satisfied by breaking the other.
    expect(fetchedDays).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
  });

  it('exposes the fetched samples and settles loading', async () => {
    mockList.mockResolvedValue([
      { id: 'hc:vo2:1', metric_type: 'vo2_max', value: 44.1, unit: 'ml/kg/min', measured_at: '2026-09-01T07:00:00Z' },
    ]);
    const { result } = renderHook(() => useVo2MaxTrend(getToken, '6M', VO2MAX_FETCH_DAYS));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.samples).toHaveLength(1);
  });
});
