import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import FoodScreen from '../../app/(tabs)/food';
import type { Module } from '@/lib/modules';

/**
 * N430/#692 — "we have today already past 12am but I need to catch up with
 * logs and I can't????"
 *
 * Today's "See logged food" link now deep-links here with `?date=<viewed
 * day>` (`momentumOpenFoodHref`, `lib/todayBoard.ts`) so the athlete lands on
 * the SAME day they were browsing, not always on real today. This file owns
 * that one seam: does the incoming param actually move the day-stepper, both
 * on first mount and on a SECOND deep link while this tab is already mounted
 * (the case a lazy `useState` initializer alone cannot handle — see the
 * `appliedDateParam` comment in `app/(tabs)/food.tsx`).
 *
 * Mocking follows `foodDayJump.test.tsx`'s conventions — same pinned clock,
 * same stable getters — except `useLocalSearchParams` is a real mock this
 * file controls per test, rather than the constant `() => ({})` every other
 * screen test here uses (this is the one screen that now reads it).
 */

jest.setTimeout(30_000);

/** Wednesday 2026-08-05, noon local, in the suite's LA timezone — matching `foodDayJump.test.tsx`. */
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
/** The incoming `?date=`, swapped per test — `undefined` is "no param at all". */
const mockDateParam: { current: string | undefined } = { current: undefined };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ date: mockDateParam.current }),
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

jest.mock('@/lib/foodLog', () => ({
  localEntries: jest.fn(async () => []),
  localTargetView: jest.fn(async () => ({ state: 'unknown' })),
  cacheTargets: jest.fn(async () => {}),
  removeEntry: jest.fn(async () => {}),
  localLoggedDays: jest.fn(async () => []),
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

const mockTrackerRefresh = jest.fn((..._a: unknown[]) => () => {});
const mockTrackerDay = {
  view: { state: 'ready', trackers: [] },
  entriesFor: () => [],
  refresh: (...a: unknown[]) => mockTrackerRefresh(...a),
  addTap: jest.fn(async () => {}),
  removeEntry: jest.fn(async () => {}),
  openSettings: jest.fn(),
};
jest.mock('@/lib/useTrackerDay', () => ({ useTrackerDay: () => mockTrackerDay }));

const nutritionModule: Module = {
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
};
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: [nutritionModule], ready: true, stale: false, apply: jest.fn() }),
}));

/** Let the screen's own read chains settle, matching `foodDayJump.test.tsx`. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocusCbs.length = 0;
  mockPush.mockClear();
  mockDateParam.current = undefined;
});

it('with no `?date=`, opens on today — unchanged from before N430/#692', async () => {
  render(<FoodScreen />);
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('Today');
});

it('seeds the stepper from `?date=` on first mount, without a flash of today first', async () => {
  mockDateParam.current = '2026-08-03'; // two days before the pinned "today"
  render(<FoodScreen />);
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-08-03');
});

it('a FUTURE `?date=` seeds the stepper too — Today can browse forward, not just back', async () => {
  mockDateParam.current = '2026-08-08';
  render(<FoodScreen />);
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-08-08');
});

it('reads trackers for the seeded day, not real today', async () => {
  mockDateParam.current = '2026-08-03';
  render(<FoodScreen />);
  await settle();
  await waitFor(() => expect(mockTrackerRefresh).toHaveBeenCalledWith('2026-08-03'));
});

it('a manual day-step is not clobbered by a mere refocus with the SAME lingering param', async () => {
  // This tab stays mounted for the app's life — a refocus (switching tabs
  // away and back) hands the SAME `params.date` back every time. Without the
  // `appliedDateParam` guard, this would re-seed 2026-08-03 on every focus
  // and silently undo the athlete's own step to 2026-08-04.
  mockDateParam.current = '2026-08-03';
  render(<FoodScreen />);
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-08-03');

  fireEvent.press(screen.getByTestId('food-day-next'));
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-08-04');

  // A refocus with the identical param — every registered focus callback
  // fires again, exactly as a real tab switch would trigger.
  mockFocusCbs.forEach((cb) => cb());
  await settle();

  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-08-04');
});

it('a SECOND, genuinely new `?date=` while already mounted DOES move the stepper', async () => {
  // The case a lazy `useState` initializer cannot handle on its own: Today
  // hands off a new day a second time in the same session (browse to day A,
  // open Food, go back to Today, browse to day B, open Food again).
  mockDateParam.current = '2026-08-03';
  render(<FoodScreen />);
  await settle();
  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-08-03');

  mockDateParam.current = '2026-08-07';
  mockFocusCbs.forEach((cb) => cb());
  await settle();

  expect(screen.getByTestId('food-day-label')).toHaveTextContent('2026-08-07');
});
