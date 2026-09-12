import { render, screen } from '@testing-library/react-native';

import { WeightTrendCard } from '../WeightTrendCard';

jest.mock('@/lib/useWeightTrend', () => ({ useWeightTrend: jest.fn() }));
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => async () => 't' }));
jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric' }) }));

const { useWeightTrend } = jest.requireMock('@/lib/useWeightTrend') as {
  useWeightTrend: jest.Mock;
};

const { buildTrend, fromPlanProjection, projectionGoal } = jest.requireActual(
  '@/lib/trendSeries',
) as typeof import('@/lib/trendSeries');

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
test('renders nothing at all while the first load is in flight', async () => {
  useWeightTrend.mockReturnValue(state({ loading: true }));
  await render(<WeightTrendCard projection={null} />);
  expect(screen.queryByTestId('weight-trend-card')).toBeNull();
  expect(screen.queryByTestId('trend-card-empty')).toBeNull();
});

test('once it has answered, an empty series may say so', async () => {
  useWeightTrend.mockReturnValue(state({ loading: false }));
  await render(<WeightTrendCard projection={null} />);
  expect(screen.getByTestId('weight-trend-card')).toBeTruthy();
  expect(screen.getByTestId('trend-card-empty').props.children).toMatch(/record your weight/i);
});

// `react-native-svg`'s `<Text>` renders its string through an inner `<TSpan>`,
// so the label sits one level below the testID'd node (as in trendGoalLine).
function readLabel(testID: string): string {
  const children = screen.getByTestId(testID).props.children.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

function oneReading() {
  return buildTrend({ readings: [{ on: '2026-08-19', value: 90 }], today: '2026-08-19', range: '1Y' as const });
}

/**
 * N433 (#714): N429's race, on the card. `goalKg` came from `listPhases` on its
 * own lifecycle and `projection` from the plan payload on another, so after a
 * phase edit the card could draw its goal at a target the projection was never
 * built against, while the full screen one tap away drew the fresh one. The
 * hook no longer returns `goalKg`; the stale 80 stays in this mock as the shape
 * of the race, so a card that grows a second goal source again fails here.
 */
test("the card's goal marker follows the fresh projection, not a stale phase target", async () => {
  const freshProjection = fromPlanProjection(
    {
      reached_on: '',
      target_weight_kg: 75,
      kg_to_go: 15,
      weeks_to_go: 0,
      already: false,
      unreachable: false,
    },
    null,
  );
  // Not vacuous: the fixture really disagrees with the stale target.
  expect(projectionGoal(freshProjection)).toBe(75);

  useWeightTrend.mockReturnValue({ ...base(), series: oneReading(), goalKg: 80, projection: freshProjection });
  await render(<WeightTrendCard projection={null} />);

  const marker = readLabel('trend-goal-offscale');
  expect(marker).toContain('75');
  expect(marker).not.toContain('80');
});

test('a goalless projection draws no goal on the card, whatever a phase says', async () => {
  useWeightTrend.mockReturnValue({
    ...base(),
    series: oneReading(),
    goalKg: 80,
    projection: fromPlanProjection(null, null),
  });
  await render(<WeightTrendCard projection={null} />);

  // The chart is there, so the absence below is about the goal and not the chart.
  expect(screen.getByTestId('trend-card-chart')).toBeTruthy();
  expect(screen.queryByTestId('trend-goal-line')).toBeNull();
  expect(screen.queryByTestId('trend-goal-offscale')).toBeNull();
});
