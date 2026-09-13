import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

import { shiftDate } from '@/lib/anthropometry';
import type { Checkin, Phase } from '@/lib/body';
import { dayString } from '@/lib/calendar';

import { WeightTrendCard } from '../WeightTrendCard';

/**
 * F63 (#1168), on the Goals card: a phase with a target and a null projection.
 *
 * The REAL hook runs, with only the network mocked, so the card is tested with
 * the same derivation the full screen uses (`trendGoalProfileGap.test.tsx`).
 */
const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
}));
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => async () => 't' }));
jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric' }) }));

const mockListCheckins = jest.fn();
const mockListPhases = jest.fn();
jest.mock('@/lib/body', () => ({
  listCheckins: (...a: unknown[]) => mockListCheckins(...a),
  listPhases: (...a: unknown[]) => mockListPhases(...a),
}));

const TODAY = dayString(new Date());

beforeEach(() => {
  // Three weigh-ins inside a week, so the chart draws rather than explaining.
  mockListCheckins.mockResolvedValue(
    [2, 1, 0].map((d) => ({ measured_on: shiftDate(TODAY, -d), weight_kg: 90 }) as unknown as Checkin),
  );
});

function phaseWithTarget(target: number) {
  mockListPhases.mockResolvedValue([
    { started_on: shiftDate(TODAY, -30), ended_on: null, target_weight_kg: target } as unknown as Phase,
  ]);
}

// `react-native-svg`'s `<Text>` renders its string through an inner `<TSpan>`,
// so the label sits one level below the testID'd node (as in trendGoalLine).
function readLabel(testID: string): string {
  const children = screen.getByTestId(testID).props.children.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

function noGoalDrawn() {
  expect(screen.getByTestId('trend-card-chart')).toBeTruthy();
  expect(screen.queryByTestId('trend-goal-offscale')).toBeNull();
  expect(screen.queryByTestId('trend-goal-line')).toBeNull();
}

test("an incomplete profile: the card draws the phase's target", async () => {
  phaseWithTarget(75);
  await render(<WeightTrendCard plan={{ kind: 'incomplete' }} />);
  await waitFor(() => expect(screen.getByTestId('trend-card-chart')).toBeTruthy());
  expect(readLabel('trend-goal-offscale')).toContain('75');
});

test('a derivation that found no goal draws none, even beside a phase target', async () => {
  phaseWithTarget(80);
  await render(<WeightTrendCard plan={{ kind: 'derived', projection: null }} />);
  await waitFor(() => expect(screen.getByTestId('trend-card-chart')).toBeTruthy());
  noGoalDrawn();
});

test('a derivation that has not answered draws none, even beside a phase target', async () => {
  phaseWithTarget(80);
  await render(<WeightTrendCard plan={null} />);
  await waitFor(() => expect(screen.getByTestId('trend-card-chart')).toBeTruthy());
  noGoalDrawn();
});
