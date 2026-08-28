import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import FoodScreen from '../../app/(tabs)/food';
import type { Module } from '@/lib/modules';

/**
 * N81/#415 — correcting a food day more than a day ago was practically
 * impossible on a phone: the ±1-day stepper was the ONLY way to move, and a
 * day three months back was up to ninety taps away.
 *
 * This file owns the month grid the day switcher's label now opens — a day
 * picked there in a couple of taps, however far back, rather than the
 * stepper being the only route. It does not own the stepper itself, the meal
 * slots, the remaining figures or the target row; `foodTargetRow.test.tsx`
 * and `nutrition.test.ts` already do.
 *
 * Mocking follows `foodTargetRow.test.tsx`'s own conventions to the letter —
 * same stable getters and single mock objects, for the same reasons given
 * there (a fresh function identity per render turns a `useCallback`'s
 * dependents into a refetch loop that does not exist in the app).
 */

// The one-off cost of standing up the React Native module graph under
// jest-expo, matching every other screen test in this app.
jest.setTimeout(30_000);

/**
 * The clock is PINNED — Wednesday 2026-08-05, noon local, in the suite's LA
 * timezone. Wednesday and mid-week so the day is unambiguous; the 5th so
 * stepping backward three days crosses into July for the "opens on the
 * shown day's month" test without needing dozens of presses.
 *
 * Only `Date` is faked, matching `weekPlanner.test.tsx`'s own list — the
 * month-grid press handlers still need working timers to settle.
 */
beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback',
      'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ],
    now: new Date('2026-08-05T12:00:00'),
  });
});

afterAll(() => {
  jest.useRealTimers();
});

const mockPush = jest.fn();
const mockFocusCbs: (() => void | (() => void))[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const react = jest.requireActual('react') as typeof import('react');
    react.useEffect(() => {
      mockFocusCbs.push(cb);
      const cleanup = cb();
      return () => {
        const i = mockFocusCbs.indexOf(cb);
        if (i >= 0) mockFocusCbs.splice(i, 1);
        if (cleanup) cleanup();
      };
    }, [cb]);
  },
}));

/** The days the fake SQLite store answers as already logged, per test. */
const loggedDays: { current: string[] } = { current: [] };

const mockLocalLoggedDays = jest.fn(async (..._a: unknown[]) => loggedDays.current);
jest.mock('@/lib/foodLog', () => ({
  localEntries: jest.fn(async () => []),
  localTargetView: jest.fn(async () => ({ state: 'unknown' })),
  cacheTargets: jest.fn(async () => {}),
  removeEntry: jest.fn(async () => {}),
  localLoggedDays: (...a: unknown[]) => mockLocalLoggedDays(...a),
}));

jest.mock('@/lib/nutritionApi', () => ({
  listTargets: jest.fn(async () => []),
  targetOn: jest.requireActual('@/lib/nutritionApi').targetOn,
}));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'user_1' }) }));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#B8FF2C', ink: '#B8FF2C', on: '#0B0F16' }),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  useSyncState: () => ({ lastSyncAt: null }),
}));

jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric', unitsReady: true }) }));

const mockTrackerDay = {
  view: { state: 'ready', trackers: [] },
  entriesFor: () => [],
  refresh: () => () => {},
  addTap: jest.fn(async () => {}),
  removeEntry: jest.fn(async () => {}),
  openSettings: jest.fn(),
};
jest.mock('@/lib/useTrackerDay', () => ({ useTrackerDay: () => mockTrackerDay }));

const mockUseModules = jest.fn(() => ({
  modules: [
    {
      key: 'nutrition',
      label: 'Nutrition',
      is_sport: false,
      default_on: true,
      enabled: true,
      capabilities: {
        catalog: '',
        facets: [],
        has_goals: false,
        has_progression: false,
        has_food_log: true,
        record_kinds: [],
      },
    },
  ] as Module[],
  ready: true,
  stale: false,
  apply: jest.fn(),
}));
jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => mockUseModules() }));

/** Let the screen's own read chains settle, matching `foodTargetRow.test.tsx`. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocusCbs.length = 0;
  mockPush.mockClear();
  loggedDays.current = [];
  mockUseModules.mockReturnValue({
    modules: [
      {
        key: 'nutrition',
        label: 'Nutrition',
        is_sport: false,
        default_on: true,
        enabled: true,
        capabilities: {
          catalog: '',
          facets: [],
          has_goals: false,
          has_progression: false,
          has_food_log: true,
          record_kinds: [],
        },
      },
    ] as Module[],
    ready: true,
    stale: false,
    apply: jest.fn(),
  });
});

it('opens the month grid from the day label, and it opens on the shown month', async () => {
  render(<FoodScreen />);
  await settle();

  expect(screen.queryByTestId('food-month-close')).toBeNull();

  fireEvent.press(screen.getByTestId('food-day-label'));
  await settle();

  expect(await screen.findByTestId('food-month-close')).toBeTruthy();
  // Pinned to August 5th — the grid should open on AUGUST, not on whatever
  // month it last happened to show.
  expect(screen.getByTestId('food-month-label')).toHaveTextContent('AUGUST 2026');
});

it('does not build the grid until it is opened', async () => {
  // Counted, not queried — `Modal` does not render its children while
  // hidden, so `queryByTestId` returns null on both the gated and the
  // ungated version and proves nothing. Each of the ~42 cells formats its
  // own accessibility label, so counting that call is what actually tells
  // the two apart. Same technique as `weekPlanner.test.tsx`'s identical test
  // over its own month grid.
  const spy = jest.spyOn(Date.prototype, 'toLocaleDateString');
  try {
    render(<FoodScreen />);
    await settle();

    // Measured, not guessed: 0 calls to mount this screen with the grid
    // closed — the day pill states `on`/'Today' directly and does no date
    // formatting of its own — against exactly 100 once the ~42-cell grid is
    // built for the pinned August 2026 (7 head cells plus 2 calls per cell:
    // the visible date's own formatting and the accessibility label's). 50
    // is the midpoint of the two, matching `weekPlanner.test.tsx`'s own rule
    // for picking a bound: the most room available in both directions.
    // Re-measure both numbers when either the pill or a grid cell grows
    // another date-formatting call; do not just raise the bound to make a
    // failure go away.
    const closed = spy.mock.calls.length;
    expect(closed).toBeLessThan(50);

    spy.mockClear();
    fireEvent.press(screen.getByTestId('food-day-label'));
    await waitFor(() => expect(screen.getByTestId('food-month-close')).toBeTruthy());

    expect(spy.mock.calls.length).toBeGreaterThan(50);
  } finally {
    spy.mockRestore();
  }
});

it('picking a day in the grid jumps the screen straight to it', async () => {
  render(<FoodScreen />);
  await settle();

  fireEvent.press(screen.getByTestId('food-day-label'));
  await settle();

  // Three months back — the case the ±1-day stepper would need ~90 taps for.
  fireEvent.press(screen.getByTestId('food-month-prev'));
  fireEvent.press(screen.getByTestId('food-month-prev'));
  fireEvent.press(screen.getByTestId('food-month-prev'));
  await waitFor(() => expect(screen.getByTestId('food-month-label')).toHaveTextContent('MAY 2026'));

  fireEvent.press(screen.getByTestId('food-month-day-2026-05-12'));
  await settle();

  // The grid closes and the day pill now names the picked day — two taps
  // total (label, then the cell) to reach a day three months back.
  expect(screen.queryByTestId('food-month-close')).toBeNull();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-05-12');
});

it('reopens on the month of the day now on screen, not the calendar’s last position', async () => {
  // `openMonth` reads the day ON SCREEN — without that, reopening the grid
  // three months out would land back on today's month, which is five taps
  // (open, three to page back, open again) to get to a day you had already
  // reached once.
  render(<FoodScreen />);
  await settle();

  fireEvent.press(screen.getByTestId('food-day-label'));
  await settle();
  fireEvent.press(screen.getByTestId('food-month-prev'));
  fireEvent.press(screen.getByTestId('food-month-prev'));
  fireEvent.press(screen.getByTestId('food-month-prev'));
  await waitFor(() => expect(screen.getByTestId('food-month-label')).toHaveTextContent('MAY 2026'));
  fireEvent.press(screen.getByTestId('food-month-day-2026-05-12'));
  await settle();

  fireEvent.press(screen.getByTestId('food-day-label'));
  await settle();

  expect(screen.getByTestId('food-month-label')).toHaveTextContent('MAY 2026');
});

it('cannot pick a day that has not happened yet', async () => {
  render(<FoodScreen />);
  await settle();

  fireEvent.press(screen.getByTestId('food-day-label'));
  await settle();

  // Pinned "today" is August 5th; August 6th is on the same grid and has not
  // happened yet — the same bound web's own jump field holds with
  // `max={now}` on its "Go to a day" field.
  const tomorrow = screen.getByTestId('food-month-day-2026-08-06');
  expect(tomorrow.props.accessibilityState?.disabled).toBe(true);

  fireEvent.press(tomorrow);
  await settle();

  // Disabled means genuinely inert, not merely styled that way — the grid
  // must still be open and the day on screen must not have moved.
  expect(screen.getByTestId('food-month-close')).toBeTruthy();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('Today');
});

it('the sheet\'s Today button returns to today from anywhere and closes the sheet', async () => {
  render(<FoodScreen />);
  await settle();

  fireEvent.press(screen.getByTestId('food-day-label'));
  await settle();
  fireEvent.press(screen.getByTestId('food-month-prev'));
  fireEvent.press(screen.getByTestId('food-month-day-2026-07-04'));
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-07-04');

  fireEvent.press(screen.getByTestId('food-day-label'));
  await settle();
  fireEvent.press(screen.getByTestId('food-month-today'));
  await settle();

  expect(screen.queryByTestId('food-month-close')).toBeNull();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('Today');
});

it('marks a day that already has an entry, and leaves an empty one bare', async () => {
  // Both PAST days, deliberately — pinned "today" is August 5th, and a day
  // that hasn't happened yet is never a candidate for "already logged". Using
  // a future date here would let this pass against a cell whose label says
  // both "logged" and "hasn't happened yet" at once, which is not a state
  // that means anything.
  loggedDays.current = ['2026-08-03'];
  render(<FoodScreen />);
  await settle();

  fireEvent.press(screen.getByTestId('food-day-label'));
  await settle();

  await waitFor(() => expect(mockLocalLoggedDays).toHaveBeenCalled());
  expect(screen.getByTestId('food-month-day-2026-08-03').props.accessibilityLabel).toMatch(/logged/);
  expect(screen.getByTestId('food-month-day-2026-08-02').props.accessibilityLabel).not.toMatch(/logged/);
});

it('the ±1-day arrows still work — the grid is an addition, not a replacement', async () => {
  render(<FoodScreen />);
  await settle();

  expect(screen.getByTestId('food-day-label')).toHaveTextContent('Today');

  fireEvent.press(screen.getByTestId('food-day-prev'));
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-08-04');

  fireEvent.press(screen.getByTestId('food-day-next'));
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('Today');
});
