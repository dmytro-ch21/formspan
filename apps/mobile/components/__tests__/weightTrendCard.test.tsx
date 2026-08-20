import { render, screen } from '@testing-library/react-native';

import { WeightTrendCard } from '../WeightTrendCard';

jest.mock('@/lib/useWeightTrend', () => ({ useWeightTrend: jest.fn() }));
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => async () => 't' }));
jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric' }) }));

const { useWeightTrend } = jest.requireMock('@/lib/useWeightTrend') as {
  useWeightTrend: jest.Mock;
};

const { buildTrend } = jest.requireActual('@/lib/trendSeries') as typeof import('@/lib/trendSeries');

function state(over: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...over };
}
function base() {
  return {
    loading: false,
    series: buildTrend({ readings: [], today: '2026-08-19', range: '1Y' as const }),
    goalKg: null,
    projection: { kind: 'none', reason: 'no-goal' } as const,
    today: '2026-08-19',
    checkins: [],
  };
}

/**
 * THE BUG THIS FILE EXISTS FOR, found by review after it shipped.
 *
 * While the first fetch is in flight the hook has no readings, which is
 * indistinguishable from having none — so the card rendered "Record your weight
 * and the trend appears here" to an athlete with two years of weigh-ins, on
 * every cold open of Goals, for as long as the network took. A claim about the
 * athlete, caused by a request that had simply not answered.
 */
test('renders nothing at all while the first load is in flight', () => {
  useWeightTrend.mockReturnValue(state({ loading: true }));
  render(<WeightTrendCard projection={null} />);
  expect(screen.queryByTestId('weight-trend-card')).toBeNull();
  expect(screen.queryByTestId('trend-card-empty')).toBeNull();
});

test('once it has answered, an empty series may say so', () => {
  useWeightTrend.mockReturnValue(state({ loading: false }));
  render(<WeightTrendCard projection={null} />);
  expect(screen.getByTestId('weight-trend-card')).toBeTruthy();
  expect(screen.getByTestId('trend-card-empty').props.children).toMatch(/record your weight/i);
});
