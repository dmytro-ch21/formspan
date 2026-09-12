import { act, render } from '@testing-library/react-native';

import FoodScreen from '../../app/(tabs)/food';
import type { Module } from '@/lib/modules';

/**
 * N557 — Food reads its trackers at MOUNT, not only on focus.
 *
 * This tab mounts at launch, behind the splash, and is not focused until the
 * athlete opens it. When the focus effect was the only trigger, the first open
 * found `TrackerList` still empty (it renders nothing while the view is
 * `unknown`) and the Water / Caffeine cards arrived a few frames later, shoving
 * the meals list ~387pt down — measured on a Release build, see the N557
 * history entry.
 *
 * Every other Food screen test mocks `useFocusEffect` as a plain effect, so in
 * them the screen is focused the moment it mounts and a mount read cannot be
 * told apart from a focus read. This file's mock is the unfocused tab: it
 * records the callback and does NOT run it. `focus()` runs it.
 *
 * Clock, getters and the single `mockTrackerDay` object follow
 * `foodInitialDay.test.tsx`, for the same reasons given there.
 */

jest.setTimeout(30_000);

/** Wednesday 2026-08-05, noon local, in the suite's LA timezone. */
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

const mockFocusCbs: (() => void | (() => void))[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  // UNFOCUSED: registered, never run. See the file comment.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const react = jest.requireActual('react') as typeof import('react');
    react.useEffect(() => {
      mockFocusCbs.push(cb);
      return () => {
        const i = mockFocusCbs.indexOf(cb);
        if (i >= 0) mockFocusCbs.splice(i, 1);
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

const mockAuth: { userId: string | null } = { userId: 'user_1' };
jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: mockAuth.userId }) }));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#B8FF2C', ink: '#B8FF2C', on: '#0B0F16' }),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  useSyncState: () => ({ lastSyncAt: null }),
}));

jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric', unitsReady: true }) }));

/** What each tracker read hands back to cancel itself. */
const mockTrackerStop = jest.fn();
const mockTrackerRefresh = jest.fn((..._a: unknown[]) => mockTrackerStop);
const trackerRefresh = (...a: unknown[]) => mockTrackerRefresh(...a);
/**
 * ONE object for the life of the file: the real hook memoises, and the screen's
 * effects depend on `refresh`'s identity. Tests change `view` (and, in one,
 * `refresh`) on this object and re-render; `beforeEach` puts both back.
 */
const mockTrackerDay: {
  view: { state: 'unknown' } | { state: 'ready'; trackers: never[] };
  refresh: (...a: unknown[]) => () => void;
  entriesFor: () => never[];
  addTap: jest.Mock;
  removeEntry: jest.Mock;
  openSettings: jest.Mock;
} = {
  view: { state: 'unknown' },
  refresh: trackerRefresh,
  entriesFor: () => [],
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

async function settle() {
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
}

/** The athlete opens the tab. */
async function focus() {
  await act(async () => {
    for (const cb of [...mockFocusCbs]) cb();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocusCbs.length = 0;
  mockAuth.userId = 'user_1';
  mockTrackerDay.view = { state: 'unknown' };
  mockTrackerDay.refresh = trackerRefresh;
});

it('reads the trackers at mount, before the tab is ever opened', async () => {
  await render(<FoodScreen />);
  await settle();

  // The focus effect exists and was not run — otherwise this proves nothing
  // about mount, because a focus read would satisfy the assertion below.
  expect(mockFocusCbs.length).toBeGreaterThan(0);
  expect(mockTrackerRefresh).toHaveBeenCalledTimes(1);
  expect(mockTrackerRefresh).toHaveBeenCalledWith('2026-08-05');
});

it('once the trackers are loaded, mount reads nothing and opening the tab still refreshes', async () => {
  mockTrackerDay.view = { state: 'ready', trackers: [] };
  await render(<FoodScreen />);
  await settle();
  expect(mockTrackerRefresh).not.toHaveBeenCalled();

  await focus();
  expect(mockTrackerRefresh).toHaveBeenCalledTimes(1);
  expect(mockTrackerRefresh).toHaveBeenCalledWith('2026-08-05');
});

it('a mount read cancelled before it lands is retried, not abandoned', async () => {
  const { rerender } = await render(<FoodScreen />);
  await settle();
  expect(mockTrackerRefresh).toHaveBeenCalledTimes(1);

  // A dependency changes while the view is still `unknown` — the shape of
  // StrictMode's double effect, or the hook's `refresh` getting a new identity.
  // The in-flight read is stopped; a one-shot guard would now never read again,
  // and the first open would show the jump this ticket removed.
  mockTrackerDay.refresh = (...a: unknown[]) => mockTrackerRefresh(...a);
  await rerender(<FoodScreen />);
  await settle();

  expect(mockTrackerStop).toHaveBeenCalledTimes(1);
  expect(mockTrackerRefresh).toHaveBeenCalledTimes(2);
});

it('signed out, mount reads nothing — the hook could only restate `unknown`', async () => {
  mockAuth.userId = null;
  await render(<FoodScreen />);
  await settle();
  expect(mockTrackerRefresh).not.toHaveBeenCalled();
});
