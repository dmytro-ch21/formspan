import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { WeekPlanner } from '@/components/WeekPlanner';
import type { Module } from '@/lib/modules';

/**
 * The Plan week reads the week it is SHOWING.
 *
 * This exists because the bug it covers is invisible to every other kind of
 * test. `refresh()` was pinned to `weekDays(new Date())` while the rows
 * rendered `weekDays(anchor)` — so once navigation existed, pressing an arrow
 * moved the dates and re-fetched *this* week's plans into them. The dates are
 * right, the component renders, nothing throws, and the plans belong to a
 * different week. A snapshot passes. The typechecker cannot see it.
 *
 * Put `weekDays(new Date())` back on line 101 and this file goes red; the
 * other 382 tests stay green.
 *
 * The store is mocked rather than driven through the real SQLite fixture on
 * purpose: what is under test is which RANGE the screen asks for, which is a
 * property of the component, not of the query.
 */

// The one-off cost of standing up the React Native module graph under
// jest-expo, not this test being slow — the same reason workoutsScreen.test
// raises it. A cold CI runner went past the 5s default.
jest.setTimeout(30_000);

const mockListPlannedBetween = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/plan', () => ({
  ...jest.requireActual('@/lib/plan'),
  listPlannedBetween: (...a: unknown[]) => mockListPlannedBetween(...a),
  planSession: jest.fn(),
  unplanSession: jest.fn(),
}));

jest.mock('@/lib/sessionStore', () => ({ cachedWorkouts: jest.fn(async () => []) }));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

// Typed as `Module[]`, not inferred: an inferred literal silently drifts from
// the real shape, which is how this file first passed its tests and failed
// `typecheck:mobile` on a missing `default_on`.
const modules: Module[] = [
  {
    key: 'strength',
    label: 'Strength',
    is_sport: true,
    enabled: true,
    default_on: true,
    capabilities: {
      catalog: 'exercises',
      facets: [],
      has_goals: true,
      has_progression: true,
      record_kinds: ['heaviest_weight'],
    },
  },
];

/** The `from` argument of the most recent read, as a `YYYY-MM-DD` string. */
function lastFrom(): string {
  const calls = mockListPlannedBetween.mock.calls;
  return calls[calls.length - 1][1] as string;
}

/**
 * Day arithmetic that does NOT go through `lib/calendar`.
 *
 * Deliberate: computing the expectation with `addDays` would make this assert
 * that the code agrees with itself. `YYYY-MM-DD` parses as UTC midnight, and
 * UTC has no DST, so plain millisecond arithmetic is exact here — which it is
 * NOT on a local `Date`, per `addDays`' own test.
 */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

beforeEach(() => {
  mockListPlannedBetween.mockReset();
  mockListPlannedBetween.mockResolvedValue([]);
});

it('reads the week it is showing, not the current one', async () => {
  render(<WeekPlanner userId="u1" modules={modules} />);
  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());
  const thisWeek = lastFrom();

  fireEvent.press(screen.getByTestId('plan-next-week'));

  // Exactly seven days later. Under the pinned read this is 0 — the rows move
  // and the query does not, which is the whole bug.
  await waitFor(() => expect(daysBetween(thisWeek, lastFrom())).toBe(7));

  fireEvent.press(screen.getByTestId('plan-prev-week'));
  await waitFor(() => expect(daysBetween(thisWeek, lastFrom())).toBe(0));
});

it('stays on a past week picked from the month grid', async () => {
  render(<WeekPlanner userId="u1" modules={modules} />);
  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());
  const thisWeek = lastFrom();

  // Two weeks back, reached with the arrows — the same anchor change the
  // month grid makes, without needing the sheet open.
  fireEvent.press(screen.getByTestId('plan-prev-week'));
  fireEvent.press(screen.getByTestId('plan-prev-week'));
  await waitFor(() => expect(daysBetween(thisWeek, lastFrom())).toBe(-14));

  // And it STAYS there. With `[refresh]` on the focus effect, changing the
  // anchor re-ran it, `refreshedAnchor` fired against the week just chosen,
  // and any past week bounced straight back to today — which reads here as
  // the range returning to 0.
  await new Promise((r) => setTimeout(r, 50));
  expect(daysBetween(thisWeek, lastFrom())).toBe(-14);
});

it('offers Today only once the shown week is not the current one', async () => {
  render(<WeekPlanner userId="u1" modules={modules} />);
  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());
  expect(screen.queryByTestId('plan-this-week')).toBeNull();

  fireEvent.press(screen.getByTestId('plan-next-week'));
  await waitFor(() => expect(screen.getByTestId('plan-this-week')).toBeTruthy());

  const thisWeek = lastFrom();
  fireEvent.press(screen.getByTestId('plan-this-week'));
  await waitFor(() => expect(daysBetween(thisWeek, lastFrom())).toBe(-7));
  expect(screen.queryByTestId('plan-this-week')).toBeNull();
});

it('does not build the month grid until it is opened', async () => {
  // Counted, not queried. `Modal` does not render its children while hidden,
  // so `queryByTestId` returns null either way and an assertion on it passes
  // against the ungated version too — it looks like a guard and is not one.
  //
  // What the `{monthOpen && …}` gate actually changes is whether the children
  // are EVALUATED, which happens in the parent before Modal ever sees them.
  // Each of the ~42 cells formats its own accessibility label, so counting
  // that call is what distinguishes the two.
  const spy = jest.spyOn(Date.prototype, 'toLocaleDateString');
  try {
    render(<WeekPlanner userId="u1" modules={modules} />);
    await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());

    // Measured, not guessed: 45 with the gate, 195 without, across the two
    // renders a mount does. 100 sits cleanly between and leaves room for the
    // rows to grow a label without turning this into a flake.
    expect(spy.mock.calls.length).toBeLessThan(100);

    spy.mockClear();
    fireEvent.press(screen.getByTestId('plan-open-month'));
    await waitFor(() => expect(screen.getByTestId('plan-month-close')).toBeTruthy());
    // And opening it genuinely does the work — otherwise the assertion above
    // would also pass against a grid that had simply stopped rendering.
    expect(spy.mock.calls.length).toBeGreaterThan(100);
  } finally {
    spy.mockRestore();
  }
});
