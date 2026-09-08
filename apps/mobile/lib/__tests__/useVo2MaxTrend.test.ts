import { renderHook, waitFor } from '@testing-library/react-native';
import { useVo2MaxTrend } from '../useVo2MaxTrend';
import { SERVER_MAX_LIST_RANGE_DAYS, VO2MAX_FETCH_DAYS } from '../vo2MaxSource';

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
    // route around it.
    renderHook(() => useVo2MaxTrend(getToken, 'All', 365 * 3));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    const [, , from, to] = mockList.mock.calls[0] as [unknown, string, string, string];
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
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
