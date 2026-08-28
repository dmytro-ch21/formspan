import { useEffect } from 'react';
import { render, screen } from '@testing-library/react-native';

import WeightTrendScreen from '../../app/goals/trend';
import { buildTrend, fromPlanProjection } from '@/lib/trendSeries';

/**
 * N103 — the refusal sentence's goal figure and its reason used to come from
 * two independent requests.
 *
 * `serverReason` (and, since it exists, the reason enum itself) rides on
 * `suggestedTarget(...).basis.projection`, fetched by this screen's own
 * `useFocusEffect`. The `goal` interpolated beside it used to be `goalKg` —
 * `phase?.target_weight_kg`, from `useWeightTrend`'s SEPARATE `listPhases`
 * fetch, on its own lifecycle. After a phase edit, one stale response could
 * pair the server's reason with a goal figure the server never judged.
 *
 * This is a component test, not a pure one, on purpose: the property under
 * test is which of TWO sources `app/goals/trend.tsx` reaches for at the
 * render site, and a pure test of `refusalCopy` alone (see
 * `trendRefusalCopy.test.ts`) cannot see that seam — it only sees whatever
 * string the caller already decided to hand it. `useWeightTrend` is mocked so
 * the two sources can be set to values that DISAGREE, the way they would for
 * real during the race this ticket exists to close.
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

// The screen's own `useFocusEffect` calls this directly, ahead of and
// independently of `useWeightTrend` — it is the OTHER fetch this bug is
// about. Its result feeds `useWeightTrend` as the `plan` argument in the real
// app, but `useWeightTrend` itself is mocked below, so what this resolves to
// is inert here; it only has to resolve without throwing.
jest.mock('@/lib/nutritionApi', () => ({
  ...jest.requireActual('@/lib/nutritionApi'),
  suggestedTarget: jest.fn(() => Promise.resolve({ suggestion: null })),
}));

jest.mock('@/lib/useWeightTrend', () => ({ useWeightTrend: jest.fn() }));
const { useWeightTrend } = jest.requireMock('@/lib/useWeightTrend') as { useWeightTrend: jest.Mock };

const TODAY = '2026-08-19';

function series() {
  return buildTrend({ readings: [{ on: TODAY, value: 90 }], today: TODAY, range: '1Y' });
}

function readText(): string {
  const children = screen.getByTestId('trend-projection-text').props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

test("the refusal sentence's goal follows the fresh projection, not the stale phase fetch", () => {
  // The exact shape of the bug: an athlete edits their phase target from 80kg
  // down to 75kg. `useWeightTrend`'s `listPhases` fetch has not caught up —
  // `goalKg` still reports the STALE 80 — while `suggestedTarget`'s own,
  // independently-timed fetch has, and the plan projection it produced was
  // built against the FRESH 75.
  const stalePhaseGoalKg = 80;
  const freshProjection = fromPlanProjection(
    {
      reached_on: '',
      target_weight_kg: 75, // the FRESH goal — what the reason is actually about
      kg_to_go: 3,
      weeks_to_go: 0,
      already: false,
      unreachable: false, // -> reason: 'no-trend', which still owes a sentence
    },
    null,
  );
  // The mismatch this test exists to catch — a bug that reads `goalKg` would
  // otherwise never be exercised by a fixture where the two numbers agree.
  expect(freshProjection.kind === 'none' && freshProjection.goal).not.toBe(stalePhaseGoalKg);

  useWeightTrend.mockReturnValue({
    loading: false,
    series: series(),
    goalKg: stalePhaseGoalKg,
    projection: freshProjection,
    today: TODAY,
    checkins: [],
  });

  render(<WeightTrendScreen />);

  const rendered = readText();
  expect(rendered).toContain('75');
  expect(rendered).not.toContain('80');
});

test('the no-goal refusal still renders nothing — there is no projection to take a number from', () => {
  // `useWeightTrend`'s `goalKg` is non-null here (a real phase target), but
  // `fromPlanProjection(null, ...)` is the one path with genuinely no
  // projection behind it, and the AC requires that stays silent even though a
  // stale `goalKg` is sitting right there.
  useWeightTrend.mockReturnValue({
    loading: false,
    series: series(),
    goalKg: 80,
    projection: fromPlanProjection(null, null),
    today: TODAY,
    checkins: [],
  });

  render(<WeightTrendScreen />);

  expect(screen.queryByTestId('trend-projection-text')).toBeNull();
});
