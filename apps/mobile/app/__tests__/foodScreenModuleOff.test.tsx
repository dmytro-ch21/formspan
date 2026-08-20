import { act, render, screen, waitFor } from '@testing-library/react-native';

import FoodScreen from '../(tabs)/food';
import { localEntries, localTargetView } from '@/lib/foodLog';
import type { Module } from '@/lib/modules';
import { listTargets } from '@/lib/nutritionApi';

/**
 * N61 / #423 — the Food tab now exists with nutrition off, so the screen it
 * leads to has to say so.
 *
 * The tab bar used to drop Food and Goals entirely when the module was off:
 * 40% of the primary navigation gone, with nothing left to say why, which is
 * indistinguishable from the feature never having been built. #370 fixed the
 * same shape across the BJJ surfaces by restoring the LINKS to screens that
 * already explained themselves. A tab is that link — and this screen is the
 * half that has to do the explaining.
 *
 * Scoped to that one property. The day stepper, the meal slots and the
 * remaining block are not this file's business; `nutrition.test.ts` and
 * friends own them.
 */

const mockFocusCbs: (() => void | (() => void))[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  // Keyed on the callback, matching React Navigation: a focus effect re-runs
  // when its callback identity changes while focused, which is exactly how the
  // module gate reaches the fetch (`refresh` changes when it flips).
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
}));

jest.mock('@/lib/nutritionApi', () => ({
  listTargets: jest.fn(async () => []),
  // NOT a stub: `targetOn` is the "newest row on or before this day" rule, and
  // a mock would supply the behaviour rather than test it. Same reasoning as
  // `goalsScreen.test.tsx`.
  targetOn: jest.requireActual('@/lib/nutritionApi').targetOn,
}));

// ONE getter, created once — the real hook returns `useCallback(..., [])`, and
// a fresh `jest.fn()` per render turns a focus fetch into a refetch loop that
// does not exist in the app.
const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', ink: '#8BC34A', on: '#000' }),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  useSyncState: () => ({ lastSyncAt: null }),
}));

jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric', unitsReady: true }) }));

/**
 * ONE object, created once, and this is not tidiness — it is the same contract
 * `mockTokenGetter` above is protecting.
 *
 * The real `useTrackerDay` memoises; the screen's focus effect depends on its
 * `refresh`. A mock handing out a fresh object per render changes that identity
 * every render, so the focus effect re-runs, sets state, and re-renders —
 * forever. Measured: the first draft of this file returned a literal and the
 * "different module off" test spun until jest's 15s timeout, which reads as a
 * hang in the screen and is entirely the mock's doing.
 */
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
  modules: [] as Module[],
  ready: true,
  stale: false,
  apply: jest.fn(),
}));
jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => mockUseModules() }));

function withModules(modules: Module[], ready = true) {
  mockUseModules.mockReturnValue({ modules, ready, stale: false, apply: jest.fn() });
}

function nutrition(enabled: boolean): Module {
  return {
    key: 'nutrition',
    label: 'Nutrition',
    is_sport: false,
    default_on: true,
    enabled,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: true,
      record_kinds: [],
    },
  };
}

const runningOff: Module = {
  key: 'running',
  label: 'Running',
  is_sport: true,
  default_on: false,
  enabled: false,
  capabilities: {
    catalog: 'exercises',
    facets: [],
    has_goals: false,
    has_progression: false,
    has_food_log: false,
    record_kinds: [],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFocusCbs.length = 0;
});

it('names the module that is off instead of rendering an empty day', () => {
  withModules([nutrition(false)]);
  render(<FoodScreen />);

  expect(screen.getByTestId('food-disabled')).toBeTruthy();
  expect(screen.getByText('Nutrition is turned off')).toBeTruthy();
  // Not a day with nothing in it — which is the reading an athlete would take
  // from the ordinary screen with no entries, and the opposite of the truth.
  expect(screen.queryByTestId('food-remaining')).toBeNull();
});

// Guarded, not merely hidden: without this the screen asks the server for a
// target on every focus while showing an explanation instead. Both render
// identically, so only this assertion tells them apart.
it('reads nothing, locally or from the server, while it is off', () => {
  withModules([nutrition(false)]);
  render(<FoodScreen />);

  expect(listTargets).not.toHaveBeenCalled();
  expect(localEntries).not.toHaveBeenCalled();
  expect(localTargetView).not.toHaveBeenCalled();
});

/**
 * **The vector that distinguishes a correct gate from a broken one**, and the
 * lesson #468 paid for: its guard survived mutation because every test vector
 * had the same shape — the only disabled module in it WAS the food-log module.
 *
 * With the food log ON and something else off, this screen must be completely
 * unaffected. A gate reading "any module is off" would replace an athlete's
 * food diary with an offer to turn Nutrition on, because they do not run.
 */
it('is unaffected by a different module being turned off', async () => {
  withModules([nutrition(true), runningOff]);
  render(<FoodScreen />);

  expect(screen.queryByTestId('food-disabled')).toBeNull();
  await waitFor(() => expect(listTargets).toHaveBeenCalled());
  // Let the fetch chain settle before the test ends, or its `setDated` lands
  // after teardown as an un-acted update — noise that reads like a defect.
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
});

// An unread module list is an unanswered question, not a "no". Without the
// `ready` half every cold start would say "Nutrition is turned off" for a frame
// or two — a sentence, not merely a missing button, so worse here than in the
// tab bar that holds a frame for the same reason.
it('claims nothing before the module set has been read', async () => {
  withModules([], false);
  render(<FoodScreen />);

  expect(screen.queryByTestId('food-disabled')).toBeNull();
  // The screen proceeds to load normally in this state, so its reads have to be
  // let settle before the test ends — otherwise they land after teardown as
  // un-acted updates.
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
});
