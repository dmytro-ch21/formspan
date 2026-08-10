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

/**
 * The clock is PINNED — to a Monday, mid-day, in the suite's LA timezone.
 *
 * This file first shipped reading the real clock, with 'AUG 10 – AUG 16'
 * hard-coded as "next week" — true only during the week it was written. One
 * real week later the suite went red on main with no code change, and the
 * collapse test's `plan-add-2026-08-05` assertion had silently gone vacuous
 * (the day was no longer in the rendered week, so `queryByTestId` returned
 * null whether the collapse gate existed or not).
 *
 * Only `Date` is faked. Everything else stays real because the tests below
 * need working timers: `waitFor` polls on `setTimeout`, and the stays-put test
 * genuinely sleeps 50ms. The month-grid test's spy on
 * `Date.prototype.toLocaleDateString` still counts, because the fake Date
 * subclasses the real one and inherits its prototype.
 */
beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
    // Monday 2026-08-03, noon local (the suite runs under
    // TZ=America/Los_Angeles). A Monday so the shown week is unambiguous, and
    // noon so no UTC-offset arithmetic can land it on another day.
    now: new Date('2026-08-03T12:00:00'),
  });
  // Canary: Date faked, and ONLY Date. Sinon tags the globals it hijacks with
  // `.clock`, so this fails immediately and legibly if the pin stops
  // installing, or if a future jest grows the fakeable-API list past the
  // `doNotFake` above — which would otherwise surface as the 50ms sleep below
  // hanging to its 30s timeout.
  expect('clock' in Date).toBe(true);
  expect('clock' in setTimeout).toBe(false);
});

afterAll(() => {
  jest.useRealTimers();
});

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

  fireEvent.press(screen.getByTestId('plan-week-next'));

  // Exactly seven days later. Under the pinned read this is 0 — the rows move
  // and the query does not, which is the whole bug.
  await waitFor(() => expect(daysBetween(thisWeek, lastFrom())).toBe(7));

  fireEvent.press(screen.getByTestId('plan-week-prev'));
  await waitFor(() => expect(daysBetween(thisWeek, lastFrom())).toBe(0));
});

it('stays on a past week picked from the month grid', async () => {
  render(<WeekPlanner userId="u1" modules={modules} />);
  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());
  const thisWeek = lastFrom();

  // Two weeks back, reached with the arrows — the same anchor change the
  // month grid makes, without needing the sheet open.
  fireEvent.press(screen.getByTestId('plan-week-prev'));
  fireEvent.press(screen.getByTestId('plan-week-prev'));
  await waitFor(() => expect(daysBetween(thisWeek, lastFrom())).toBe(-14));

  // And it STAYS there. With `[refresh]` on the focus effect, changing the
  // anchor re-ran it, `refreshedAnchor` fired against the week just chosen,
  // and any past week bounced straight back to today — which reads here as
  // the range returning to 0.
  await new Promise((r) => setTimeout(r, 50));
  expect(daysBetween(thisWeek, lastFrom())).toBe(-14);
});

it('names the week in the switcher, which is the only thing saying you moved', async () => {
  // This replaced a separate "Today" pill that appeared when you navigated
  // away. The pill was the one thing telling you you had moved, so removing it
  // needed the label to take that over — and the label is better at it: it is
  // text, so it survives greyscale and reaches a screen reader, and it says
  // WHICH week rather than only that it is not this one. Getting back is the
  // month grid, one tap from the same control.
  render(<WeekPlanner userId="u1" modules={modules} />);
  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());
  expect(screen.getByTestId('plan-week-label')).toHaveTextContent('THIS WEEK');

  fireEvent.press(screen.getByTestId('plan-week-next'));
  // The actual range, not merely "not THIS WEEK" — that passes against empty
  // text, and against a range formatted off `now` instead of `anchor`, which
  // is the class of bug this file exists for. The week after the pinned
  // Aug 3 – Aug 9, so it is a constant, not a claim about the real calendar.
  await waitFor(() =>
    expect(screen.getByTestId('plan-week-label')).toHaveTextContent('AUG 10 – AUG 16'),
  );

  fireEvent.press(screen.getByTestId('plan-week-prev'));
  await waitFor(() =>
    expect(screen.getByTestId('plan-week-label')).toHaveTextContent('THIS WEEK'),
  );
});

it('keeps the authoring rows behind a collapse, open by default', async () => {
  // Open by default is the opposite of the Today screen's calendar and is the
  // point: this screen exists to fill the rows in, so starting collapsed would
  // hide the only thing on it.
  //
  // Asserting the ROWS, not the toggle's caption. The first version of this
  // checked only that the label flipped HIDE WEEK → SHOW WEEK, which stays
  // green if the `{expanded && …}` gate is deleted entirely — it tested the
  // button, not the collapse.
  render(<WeekPlanner userId="u1" modules={modules} />);
  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());
  expect(screen.getAllByText('Rest').length).toBeGreaterThan(0);
  // Asserted PRESENT here so its absence below means the collapse removed it.
  // Under the real clock this went vacuous the week after it was written —
  // Aug 5 left the rendered week, the query was null on both sides of the
  // toggle, and the assertion guarded nothing. The pinned clock keeps Aug 5 a
  // plannable (not-past) day of the shown week permanently.
  expect(screen.getByTestId('plan-add-2026-08-05')).toBeTruthy();
  expect(screen.getByTestId('plan-toggle-week')).toHaveTextContent('HIDE WEEK');

  fireEvent.press(screen.getByTestId('plan-toggle-week'));
  expect(screen.queryAllByText('Rest')).toHaveLength(0);
  expect(screen.queryByTestId('plan-add-2026-08-05')).toBeNull();
  expect(screen.getByTestId('plan-toggle-week')).toHaveTextContent('SHOW WEEK');

  // And the strip survives the collapse — it is what the week becomes, so a
  // collapse that took it too would leave the header alone on the screen.
  fireEvent.press(screen.getByTestId('plan-toggle-week'));
  expect(screen.getAllByText('Rest').length).toBeGreaterThan(0);
});

it('offers a way back to this week from the month sheet', async () => {
  // The header's Today pill was removed in favour of the switcher's label.
  // This is where the capability went, and `openMonth` opens on the NAVIGATED
  // month — so without it, returning from three months out is five taps and
  // today is not even on the grid.
  render(<WeekPlanner userId="u1" modules={modules} />);
  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());

  fireEvent.press(screen.getByTestId('plan-week-next'));
  fireEvent.press(screen.getByTestId('plan-week-next'));
  await waitFor(() =>
    expect(screen.getByTestId('plan-week-label')).not.toHaveTextContent('THIS WEEK'),
  );

  fireEvent.press(screen.getByTestId('plan-week-label'));
  fireEvent.press(await screen.findByTestId('plan-month-today'));
  await waitFor(() =>
    expect(screen.getByTestId('plan-week-label')).toHaveTextContent('THIS WEEK'),
  );
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

    // Measured, not guessed, and RE-measured: 87 with the gate, 237 without,
    // across the renders a mount does. It was 45/195 when written with a bound
    // of 100 — the week strip's own seven labels ate most of that headroom, and
    // a bound with 13 points of slack fails next for a reason unrelated to the
    // gate it guards. 160 is the midpoint of the current pair, which is the
    // most room in both directions.
    //
    // Re-measure this when the header grows anything; do not just raise it.
    expect(spy.mock.calls.length).toBeLessThan(160);

    spy.mockClear();
    fireEvent.press(screen.getByTestId('plan-week-label'));
    await waitFor(() => expect(screen.getByTestId('plan-month-close')).toBeTruthy());
    // And opening it genuinely does the work — otherwise the assertion above
    // would also pass against a grid that had simply stopped rendering.
    expect(spy.mock.calls.length).toBeGreaterThan(100);
  } finally {
    spy.mockRestore();
  }
});
