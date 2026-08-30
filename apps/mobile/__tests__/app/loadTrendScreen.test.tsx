/**
 * N84 — "is my top set going up", the per-exercise load trend screen.
 *
 * What this pins, beyond "it renders": a failed load reads as "couldn't load"
 * rather than "no sessions yet" (the codebase's most repeated defect, per
 * CLAUDE.md's own "Verify that a check can fail" section), an exercise that
 * cannot carry a weight says so rather than showing an empty chart, and
 * switching the range chip re-fetches nothing (the history is fetched once
 * and sliced client-side, matching `app/goals/trend.tsx`'s own approach) but
 * DOES redraw with a different window.
 */
import { useEffect } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';

import LoadTrendScreen from '../../app/records/[exerciseId]/trend';

const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ exerciseId: 'back-squat', name: 'Back Squat' }),
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
  Stack: { Screen: () => null },
}));

const mockFetch = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({ exercise_id: 'back-squat', load_type: 'weight_reps', points: [] }));
jest.mock('@/lib/records', () => ({
  ...jest.requireActual('@/lib/records'),
  fetchLoadHistory: (...a: unknown[]) => mockFetch(...a),
}));

// Relative to test-run time, not hardcoded calendar dates: the screen computes
// its window as `today - 90 days` off the REAL clock (`app/records/[exerciseId]/trend.tsx`'s
// `today = dayString(new Date())`, not mockable here — no prop or context
// overrides it), and the default range is `'3M'` (90 days, `lib/trendSeries.ts`).
// A fixture pinned to specific 2026 calendar dates decays as the window slides
// past it — measured 2026-08-30, when a `2026-06-01` point that was safely
// inside a 90-day window when written had drifted to the exact edge of one and
// intermittently dropped out, failing `load-trend-delta` in real CI. Offsets
// well clear of both edges (60 and 5 days back) keep this true regardless of
// when the suite runs.
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(10, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const point = (started_at: string, top_weight_kg: number | null) => ({
  session_id: started_at,
  started_at,
  top_weight_kg,
  best_1rm_kg: null,
  best_1rm_reps: null,
  best_1rm_weight_kg: null,
  best_1rm_assisted_reps: null,
  best_1rm_rir: null,
  best_1rm_rpe: null,
  tonnage_kg: 0,
  sets: 3,
  reps: 15,
});

beforeEach(() => mockFetch.mockReset());

it('shows the unavailable message on a failed load, not "no sessions yet"', async () => {
  mockFetch.mockRejectedValue(new Error('offline'));
  render(<LoadTrendScreen />);
  const empty = await screen.findByTestId('load-trend-empty');
  expect(empty.props.children).toMatch(/couldn.?t load/i);
});

it('renders sessions as entries and a readable delta once loaded', async () => {
  const older = daysAgo(60);
  const recent = daysAgo(5);
  mockFetch.mockResolvedValue({
    exercise_id: 'back-squat',
    load_type: 'weight_reps',
    points: [point(older, 100), point(recent, 110)],
  });
  render(<LoadTrendScreen />);

  expect(await screen.findByTestId('load-trend-delta')).toBeTruthy();
  expect(screen.getByTestId(`load-trend-entry-${older}`)).toBeTruthy();
  expect(screen.getByTestId(`load-trend-entry-${recent}`)).toBeTruthy();
});

it('says a non-strength exercise needs a logged weight, rather than drawing an empty chart', async () => {
  mockFetch.mockResolvedValue({ exercise_id: 'plank', load_type: 'time', points: [point(daysAgo(5), null)] });
  render(<LoadTrendScreen />);
  expect(await screen.findByTestId('load-trend-no-weight')).toBeTruthy();
  expect(screen.queryByTestId('load-trend-chart')).toBeNull();
});

it('switching the range does not re-fetch — it slices what is already loaded', async () => {
  mockFetch.mockResolvedValue({
    exercise_id: 'back-squat',
    load_type: 'weight_reps',
    points: [point(daysAgo(5), 100)],
  });
  render(<LoadTrendScreen />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

  fireEvent.press(await screen.findByTestId('load-trend-range-1Y'));
  await waitFor(() => expect(screen.getByTestId('load-trend-range-1Y').props.accessibilityState.selected).toBe(true));
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
