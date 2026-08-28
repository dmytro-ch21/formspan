import { useEffect } from 'react';
import { render, screen } from '@testing-library/react-native';

import WeightTrendScreen from '../../app/goals/trend';
import { buildTrend, fromPlanProjection, projectionGoal } from '@/lib/trendSeries';

/**
 * N429 — the chart's dashed goal line and its rendered number were still
 * reading `useWeightTrend`'s separately-fetched `goalKg`, even after N103
 * fixed the refusal SENTENCE beside it (`trendGoalFigure.test.tsx`) to read
 * the projection instead. Same race, one component over: `goalKg` comes from
 * `listPhases`, on its own lifecycle; `projection` comes from
 * `suggestedTarget`, on its own. After a phase edit, one stale response could
 * draw the chart's dashed line at a target the current projection was never
 * built against, while the sentence right next to it already told the truth.
 *
 * Mirrors `trendGoalFigure.test.tsx`'s fixture exactly — a stale `goalKg`
 * disagreeing with a fresh `projection` — but reads the CHART's own rendered
 * number rather than the sentence.
 */

const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
}));

jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => async () => 'token' }));
jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric' }) }));
jest.mock('@/lib/AccentProvider', () => ({ useAccent: () => ({ accent: '#8BC34A', on: '#000' }) }));

jest.mock('@/lib/nutritionApi', () => ({
  ...jest.requireActual('@/lib/nutritionApi'),
  suggestedTarget: jest.fn(() => Promise.resolve({ suggestion: null })),
}));

jest.mock('@/lib/useWeightTrend', () => ({ useWeightTrend: jest.fn() }));
const { useWeightTrend } = jest.requireMock('@/lib/useWeightTrend') as { useWeightTrend: jest.Mock };

const TODAY = '2026-08-19';

// A single reading far from either goal candidate, so the chart draws the
// off-scale marker (`▼ goal {n}`) rather than the in-bounds dashed line —
// either way the rendered text carries the same number this test cares
// about, and the off-scale path is the one a single-reading fixture reaches.
function series() {
  return buildTrend({ readings: [{ on: TODAY, value: 90 }], today: TODAY, range: '1Y' });
}

// `react-native-svg`'s `<Text>` renders its string child through an inner
// `<TSpan>` host component (RNSVGText > TSpan), so the label text lives one
// level deeper than the testID'd node itself.
function readLabel(testID: string): string {
  const children = screen.getByTestId(testID).props.children.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

test("the chart's goal marker follows the fresh projection, not the stale phase fetch", () => {
  const stalePhaseGoalKg = 80;
  const freshProjection = fromPlanProjection(
    {
      reached_on: '',
      target_weight_kg: 75, // the FRESH goal — what the projection is actually about
      kg_to_go: 15,
      weeks_to_go: 0,
      already: false,
      unreachable: false, // -> reason: 'no-trend', still a real (non-null) goal
    },
    null,
  );
  // Unlike `freshProjection.kind === 'none' && freshProjection.goal`, this
  // doesn't go vacuously true if the fixture above ever drifted to a
  // `projected` result — it exercises the same helper the screen itself now
  // calls, so a fixture that stopped disagreeing with `stalePhaseGoalKg`
  // would fail HERE rather than pass silently.
  expect(projectionGoal(freshProjection)).not.toBe(stalePhaseGoalKg);
  expect(projectionGoal(freshProjection)).toBe(75);

  useWeightTrend.mockReturnValue({
    loading: false,
    series: series(),
    goalKg: stalePhaseGoalKg,
    projection: freshProjection,
    today: TODAY,
    checkins: [],
  });

  render(<WeightTrendScreen />);

  const marker = readLabel('trend-goal-offscale');
  expect(marker).toContain('75');
  expect(marker).not.toContain('80');
});

test('the no-goal refusal draws no goal line at all — there is no projection to take a number from', () => {
  useWeightTrend.mockReturnValue({
    loading: false,
    series: series(),
    goalKg: 80, // non-null and stale, but there is genuinely no projection behind it
    projection: fromPlanProjection(null, null),
    today: TODAY,
    checkins: [],
  });

  render(<WeightTrendScreen />);

  expect(screen.queryByTestId('trend-goal-line')).toBeNull();
  expect(screen.queryByTestId('trend-goal-offscale')).toBeNull();
});
