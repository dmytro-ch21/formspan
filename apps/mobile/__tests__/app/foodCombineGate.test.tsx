import { render, screen, waitFor } from '@testing-library/react-native';

import FoodScreen from '../../app/(tabs)/food';
import type { Module } from '@/lib/modules';

/**
 * N115 (#504), review finding (ac-verifier, criterion 6) — combining is
 * DESTRUCTIVE (it deletes the originals) and the combine screen's own copy
 * promises same-day reversibility. Offering "Combine" on a day the athlete
 * has stepped BACK to would combine (and delete) entries from a day that
 * promise does not cover — `food/entry/[id]`'s own Split control already
 * refuses a past day, so a combine reachable on one would create an entry
 * with no way back, seconds after being told there would be one.
 *
 * This file pins the fix at the one place it has to hold: the "Combine" link
 * itself must not be OFFERED once the day switcher has moved off today.
 * `MealCard.test.tsx` already proves the mechanism ("no `onStartCombine` —
 * no link"); this proves `food.tsx` actually withholds it on a past day.
 */

jest.setTimeout(30_000);

const mockFocusCbs: (() => void | (() => void))[] = [];
// Mutable per test, matching `addFoodCatalog.test.tsx`'s own `mockParams`
// convention — `food.tsx` seeds its day stepper from this on the first
// focus, via the SAME `?date=` mechanism N430/#692 already added.
let mockParams: { date?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
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

/** Two entries in ONE slot, on whatever day is asked for — enough for
 *  "Combine" to be OFFERABLE, so the test is about the day gate and nothing
 *  else. */
function entries(on: string) {
  const base = {
    eaten_on: on,
    meal: 'breakfast',
    servings: 1,
    serving_label: '1 serving',
    kcal: 100,
    protein_g: 5,
    carb_g: 10,
    fat_g: 2,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source_food_id: null,
    category: null,
    notes: '',
  };
  return [
    { ...base, id: 'e1', name: 'Milk' },
    { ...base, id: 'e2', name: 'Protein powder' },
  ];
}

const mockLocalEntries = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localEntries: (...a: unknown[]) => mockLocalEntries(...a),
  localLoggedDays: jest.fn(async () => []),
  localTargetView: jest.fn(async () => ({ state: 'none' })),
  cacheTargets: jest.fn(async () => {}),
  removeEntry: jest.fn(async () => {}),
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

const NUTRITION_MODULE: Module = {
  key: 'nutrition',
  label: 'Nutrition',
  is_sport: false,
  default_on: true,
  enabled: true,
  capabilities: {
    catalog: '', facets: [], has_goals: false, has_progression: false,
    has_food_log: true, record_kinds: [],
  },
} as Module;
const mockUseModules = jest.fn(() => (
  { modules: [NUTRITION_MODULE], ready: true, stale: false, apply: jest.fn() }
));
jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => mockUseModules() }));

beforeEach(() => {
  mockFocusCbs.length = 0;
  mockParams = {};
  mockLocalEntries.mockReset().mockImplementation(async (_userId: string, on: string) => entries(on));
});

it('offers "Combine" on TODAY, once a section has two or more entries', async () => {
  render(<FoodScreen />);
  await waitFor(() => expect(screen.getByTestId('food-meal-breakfast-combine-start')).toBeTruthy());
});

it('does NOT offer "Combine" on a day the athlete has stepped back to', async () => {
  // A real past date — `dayOffsetFor` reads it against `new Date()`, so this
  // has to be genuinely before today rather than a fixed literal that will
  // stop being in the past.
  const pastDate = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  mockParams = { date: pastDate };
  render(<FoodScreen />);
  // Give the day-seeding focus effect and the entries reload a turn to settle.
  await waitFor(() => expect(mockLocalEntries).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('food-meal-breakfast-header')).toBeTruthy());
  expect(screen.queryByTestId('food-meal-breakfast-combine-start')).toBeNull();
});
