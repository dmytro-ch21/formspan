/**
 * N489/#850 — the Progress-tab cross-session training-load trend.
 *
 * What this pins, beyond "it renders": a failed load reads as "couldn't
 * load" rather than the empty-history copy (this codebase's most repeated
 * defect — CLAUDE.md's "Verify that a check can fail"); two sessions on the
 * SAME day sum into one entry rather than drawing as two overlapping dots
 * (see `lib/trainingLoadTrend.ts`'s own doc comment on why); a genuinely
 * empty account says so honestly, distinct from a failed fetch; and
 * switching the range re-slices what is already loaded rather than
 * re-fetching, matching `app/records/[exerciseId]/trend.tsx`'s own approach.
 */
import { useEffect } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';

import TrainingLoadTrendScreen from '../../app/trainingLoad/trend';
import type { SessionLoad } from '@/lib/biometric';

const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
  Stack: { Screen: () => null },
}));

const mockFetch = jest.fn((..._a: unknown[]): Promise<SessionLoad[]> => Promise.resolve([]));
jest.mock('@/lib/biometric', () => ({
  ...jest.requireActual('@/lib/biometric'),
  listSessionLoad: (...a: unknown[]) => mockFetch(...a),
}));

// Relative to test-run time, matching `loadTrendScreen.test.tsx`'s own
// reasoning exactly: the hook's fetch window is `today - (windowDays +
// slack)` off the real clock, and hardcoded 2026 calendar dates decay as
// that window slides past them.
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(10, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};
const dayOf = (iso: string) => iso.slice(0, 10);

const load = (id: string, startedAt: string, trimp: number, sport: SessionLoad['sport'] = 'strength'): SessionLoad => ({
  session_id: id,
  sport,
  started_at: startedAt,
  trimp,
});

beforeEach(() => mockFetch.mockReset());

it('shows the unavailable message on a failed load, not "no training yet"', async () => {
  mockFetch.mockRejectedValue(new Error('offline'));
  render(<TrainingLoadTrendScreen />);
  const empty = await screen.findByTestId('training-load-empty');
  expect(empty.props.children).toMatch(/couldn.?t load/i);
});

it('says so honestly when the account genuinely has no computed load yet', async () => {
  mockFetch.mockResolvedValue([]);
  render(<TrainingLoadTrendScreen />);
  const empty = await screen.findByTestId('training-load-empty');
  expect(empty.props.children).toMatch(/no training load yet/i);
});

it('renders sessions as entries and a readable delta once loaded', async () => {
  const older = daysAgo(60);
  const recent = daysAgo(5);
  mockFetch.mockResolvedValue([load('ses-1', older, 80), load('ses-2', recent, 120)]);
  render(<TrainingLoadTrendScreen />);

  expect(await screen.findByTestId('training-load-delta')).toBeTruthy();
  expect(screen.getByTestId(`training-load-entry-${dayOf(older)}`)).toBeTruthy();
  expect(screen.getByTestId(`training-load-entry-${dayOf(recent)}`)).toBeTruthy();
});

// The core claim `lib/trainingLoadTrend.ts` exists to make honest: a BJJ
// session and a strength session on the SAME day are one day of load, not
// two competing dots at the same x-coordinate.
it('sums two sessions on the same day into one entry', async () => {
  const on = daysAgo(5);
  mockFetch.mockResolvedValue([
    load('ses-am', on, 50, 'strength'),
    load('ses-pm', on, 30, 'bjj'),
  ]);
  render(<TrainingLoadTrendScreen />);

  const entry = await screen.findByTestId(`training-load-entry-${dayOf(on)}`);
  expect(entry).toBeTruthy();
  // Exactly one entry for that day, not two.
  expect(screen.queryAllByTestId(new RegExp(`^training-load-entry-${dayOf(on)}$`))).toHaveLength(1);
  expect(entry.props.children[1].props.children.join('')).toMatch(/80 TRIMP/);
});

it('switching the range does not re-fetch — it slices what is already loaded', async () => {
  mockFetch.mockResolvedValue([load('ses-1', daysAgo(5), 100)]);
  render(<TrainingLoadTrendScreen />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

  fireEvent.press(await screen.findByTestId('training-load-range-1Y'));
  await waitFor(() =>
    expect(screen.getByTestId('training-load-range-1Y').props.accessibilityState.selected).toBe(true),
  );
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

// frontend-reviewer, N489/#850: the screen's own fetch window used to be
// WIDER than the backend would ever accept (FETCH_DAYS + the hook's lookback
// slack came to ~1103 days, and maxSessionLoadRangeDays was 1100 at the
// time) — every load of this screen failed, unconditionally, and nothing in
// this file caught it because `listSessionLoad` was mocked wholesale with no
// assertion on what it was actually called WITH. This pins the real request
// window against the backend's own cap (1200 days,
// backend/internal/modules/biometric/handler.go's maxSessionLoadRangeDays),
// so a future FETCH_DAYS/slack change that regresses past it fails here
// rather than only in production.
it('requests a window that stays under the backend range cap', async () => {
  mockFetch.mockResolvedValue([]);
  render(<TrainingLoadTrendScreen />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

  const [, from, to] = mockFetch.mock.calls[0] as [unknown, string, string];
  const days = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);
  // The backend's own cap, mirrored here as a literal rather than imported —
  // this is a Go constant, and the whole point is to catch a drift between
  // the two sides, not to read the same number from both.
  const BACKEND_MAX_RANGE_DAYS = 1200;
  expect(days).toBeLessThan(BACKEND_MAX_RANGE_DAYS);
});
