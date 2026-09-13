import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import WeightTrendScreen from '../../app/goals/trend';
import { shiftDate } from '@/lib/anthropometry';
import type { Checkin, Phase } from '@/lib/body';
import { dayString } from '@/lib/calendar';

/**
 * F63 (#1168), on the full weight trend screen: a phase with a target and a
 * null projection.
 *
 * The REAL hook and the REAL `planOutcomeOf` run; only the network is mocked.
 * The Goals card has the same cases in `weightTrendCardProfileGap.test.tsx`.
 */
const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
}));
// A STABLE token function, as the real hook returns. A fresh one per render
// re-runs the screen's focus effect on every render, and since each run stores
// a new plan object the screen never settles.
const mockGetToken = async () => 'token';
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockGetToken }));
jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric' }) }));
jest.mock('@/lib/AccentProvider', () => ({ useAccent: () => ({ accent: '#8BC34A', on: '#000' }) }));

const mockSuggested = jest.fn();
jest.mock('@/lib/nutritionApi', () => ({
  ...jest.requireActual('@/lib/nutritionApi'),
  suggestedTarget: (...a: unknown[]) => mockSuggested(...a),
}));

const mockListCheckins = jest.fn();
const mockListPhases = jest.fn();
jest.mock('@/lib/body', () => ({
  listCheckins: (...a: unknown[]) => mockListCheckins(...a),
  listPhases: (...a: unknown[]) => mockListPhases(...a),
}));

const TODAY = dayString(new Date());

beforeEach(() => {
  mockSuggested.mockReset();
  mockListCheckins.mockResolvedValue(
    [2, 1, 0].map((d) => ({ measured_on: shiftDate(TODAY, -d), weight_kg: 90 }) as unknown as Checkin),
  );
});

function phaseWithTarget(target: number) {
  mockListPhases.mockResolvedValue([
    { started_on: shiftDate(TODAY, -30), ended_on: null, target_weight_kg: target } as unknown as Phase,
  ]);
}

// `react-native-svg`'s `<Text>` renders its string through an inner `<TSpan>`.
function readLabel(testID: string): string {
  const children = screen.getByTestId(testID).props.children.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

/** Lets the screen's own `suggestedTarget` response land before asserting an absence. */
async function derivationAnswered() {
  await waitFor(() => expect(mockSuggested).toHaveBeenCalled());
  await act(async () => {});
  await waitFor(() => expect(screen.getByTestId('trend-chart')).toBeTruthy());
}

test('an incomplete profile: the chart draws the phase target, and the sentence says why there is no date', async () => {
  phaseWithTarget(75);
  mockSuggested.mockResolvedValue({ suggestion: null, missing: ['height_cm'], activities: [] });
  await render(<WeightTrendScreen />);
  await derivationAnswered();
  await waitFor(() => expect(readLabel('trend-goal-offscale')).toContain('75'));
  expect(screen.getByTestId('trend-projection-text').props.children).toBe(
    "Your goal is 75 kg. A date needs your nutrition target first, and your profile doesn't have enough for one yet. Goals shows what to add.",
  );
});

test('a derivation that found no goal: no goal line and no sentence, even beside a phase target', async () => {
  phaseWithTarget(80);
  mockSuggested.mockResolvedValue({
    suggestion: { kcal: 2500, protein_g: 150, carb_g: 300, fat_g: 70, fibre_g: 30, basis: { projection: null } },
    missing: [],
    activities: [],
  });
  await render(<WeightTrendScreen />);
  await derivationAnswered();
  expect(screen.queryByTestId('trend-goal-offscale')).toBeNull();
  expect(screen.queryByTestId('trend-goal-line')).toBeNull();
  expect(screen.queryByTestId('trend-projection-text')).toBeNull();
});
