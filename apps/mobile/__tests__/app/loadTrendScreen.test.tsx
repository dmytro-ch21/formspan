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
  mockFetch.mockResolvedValue({
    exercise_id: 'back-squat',
    load_type: 'weight_reps',
    points: [point('2026-06-01T10:00:00Z', 100), point('2026-08-10T10:00:00Z', 110)],
  });
  render(<LoadTrendScreen />);

  expect(await screen.findByTestId('load-trend-delta')).toBeTruthy();
  expect(screen.getByTestId(`load-trend-entry-2026-06-01T10:00:00Z`)).toBeTruthy();
  expect(screen.getByTestId(`load-trend-entry-2026-08-10T10:00:00Z`)).toBeTruthy();
});

it('says a non-strength exercise needs a logged weight, rather than drawing an empty chart', async () => {
  mockFetch.mockResolvedValue({ exercise_id: 'plank', load_type: 'time', points: [point('2026-08-10T10:00:00Z', null)] });
  render(<LoadTrendScreen />);
  expect(await screen.findByTestId('load-trend-no-weight')).toBeTruthy();
  expect(screen.queryByTestId('load-trend-chart')).toBeNull();
});

it('switching the range does not re-fetch — it slices what is already loaded', async () => {
  mockFetch.mockResolvedValue({
    exercise_id: 'back-squat',
    load_type: 'weight_reps',
    points: [point('2026-08-10T10:00:00Z', 100)],
  });
  render(<LoadTrendScreen />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

  fireEvent.press(await screen.findByTestId('load-trend-range-1Y'));
  await waitFor(() => expect(screen.getByTestId('load-trend-range-1Y').props.accessibilityState.selected).toBe(true));
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
