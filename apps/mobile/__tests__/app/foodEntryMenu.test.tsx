import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import FoodScreen from '../../app/(tabs)/food';
import type { Module } from '@/lib/modules';

/**
 * N531/#962 — the food day view's per-row 3-dot menu, end to end at the
 * screen: the control on the row opens the sheet, Duplicate/Remove write
 * through `foodLog` and ask for a push, and Share is gated on the entry's
 * sync state (the gate the entry screen used to hold) before it can open the
 * friend picker. The drag's drop decision is `useEntryDrag.test.ts`; the
 * gesture itself is a device check.
 *
 * Mocks follow `foodCombineGate.test.tsx`, the other screen-level test of
 * this file, with `entrySyncState`/`duplicateEntry`/`moveEntry` added.
 */

jest.setTimeout(30_000);

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const react = jest.requireActual('react') as typeof import('react');
    react.useEffect(() => cb(), [cb]);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function entries() {
  const base = {
    eaten_on: 'today',
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
    { ...base, id: 'e1', name: 'Greek yoghurt' },
    { ...base, id: 'e2', name: 'Oats', meal: 'lunch' },
  ];
}

const mockLocalEntries = jest.fn();
const mockEntrySyncState = jest.fn();
const mockDuplicateEntry = jest.fn();
const mockRemoveEntry = jest.fn();
const mockMoveEntry = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localEntries: (...a: unknown[]) => mockLocalEntries(...a),
  localLoggedDays: jest.fn(async () => []),
  localTargetView: jest.fn(async () => ({ state: 'none' })),
  cacheTargets: jest.fn(async () => {}),
  removeEntry: (...a: unknown[]) => mockRemoveEntry(...a),
  entrySyncState: (...a: unknown[]) => mockEntrySyncState(...a),
  duplicateEntry: (...a: unknown[]) => mockDuplicateEntry(...a),
  moveEntry: (...a: unknown[]) => mockMoveEntry(...a),
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

const mockRequestSync = jest.fn();
jest.mock('@/lib/sync', () => ({
  request: (...a: unknown[]) => mockRequestSync(...a),
  useSyncState: () => ({ lastSyncAt: null }),
}));

jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({ units: 'metric', unitsReady: true, foodUnit: 'g' }),
}));

// The friend picker's own data, so Share can actually open it here.
const mockListFriends = jest.fn(async (..._a: unknown[]) => [
  { username: 'sam', display_name: 'Sam' },
]);
jest.mock('@/lib/friends', () => ({ listFriends: (...a: unknown[]) => mockListFriends(...a) }));
jest.mock('@/lib/sounds', () => ({ playSound: jest.fn() }));
jest.mock('@/lib/shares', () => ({
  ...(jest.requireActual('@/lib/shares') as object),
  shareResource: jest.fn(async () => {}),
}));

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
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: [NUTRITION_MODULE], ready: true, stale: false, apply: jest.fn() }),
}));

beforeEach(() => {
  mockLocalEntries.mockReset().mockImplementation(async () => entries());
  mockEntrySyncState.mockReset().mockResolvedValue({ unsynced: false, owed: false });
  mockDuplicateEntry.mockReset().mockResolvedValue('e1-copy');
  mockRemoveEntry.mockReset().mockResolvedValue(undefined);
  mockMoveEntry.mockReset().mockResolvedValue(undefined);
  mockRequestSync.mockReset();
  mockListFriends.mockClear();
});

async function openMenuFor(id: string) {
  await render(<FoodScreen />);
  const more = await screen.findByTestId(`food-entry-${id}-more`);
  await fireEvent.press(more);
  await screen.findByTestId('entry-menu-duplicate');
}

it('every row carries the 3-dot control, in every section', async () => {
  await render(<FoodScreen />);
  expect((await screen.findByTestId('food-entry-e1-more')).props.accessibilityLabel).toBe(
    'More for Greek yoghurt',
  );
  expect(screen.getByTestId('food-entry-e2-more').props.accessibilityLabel).toBe('More for Oats');
});

it('opens a sheet naming the row, with exactly Duplicate / Remove / Share', async () => {
  await openMenuFor('e1');
  // The row itself says the name too — ask the SHEET.
  expect(within(screen.getByTestId('entry-menu')).getByText('Greek yoghurt')).toBeTruthy();
  expect(screen.getByTestId('entry-menu-remove')).toBeTruthy();
  expect(screen.getByTestId('entry-menu-share')).toBeTruthy();
});

it('Duplicate writes through the outbox for THAT entry, asks for a push, and re-reads the day', async () => {
  await openMenuFor('e1');
  mockLocalEntries.mockClear();
  await fireEvent.press(screen.getByTestId('entry-menu-duplicate'));

  await waitFor(() => expect(mockDuplicateEntry).toHaveBeenCalledWith('user_1', 'e1'));
  await waitFor(() => expect(mockRequestSync).toHaveBeenCalledWith('food duplicated'));
  await waitFor(() => expect(mockLocalEntries).toHaveBeenCalled());
  // No network on the critical path — the write is local and the push is
  // requested, not awaited.
  expect(mockTokenGetter).not.toHaveBeenCalled();
});

it('Remove uses the same removal the swipe does, and asks for a push', async () => {
  await openMenuFor('e2');
  await fireEvent.press(screen.getByTestId('entry-menu-remove'));
  await waitFor(() => expect(mockRemoveEntry).toHaveBeenCalledWith('user_1', 'e2'));
  await waitFor(() => expect(mockRequestSync).toHaveBeenCalledWith('food deleted'));
});

it('Share is refused with the reason while the entry has not reached the server', async () => {
  mockEntrySyncState.mockResolvedValue({ unsynced: true, owed: false });
  await openMenuFor('e1');
  const share = screen.getByTestId('entry-menu-share');
  await waitFor(() =>
    expect(share.props.accessibilityLabel).toMatch(/^Share\. Not synced yet/),
  );
  expect(share.props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(share);
  expect(screen.queryByTestId('share-sheet')).toBeNull();
  expect(mockEntrySyncState).toHaveBeenCalledWith('user_1', 'e1');
});

it('Share is refused with "save first" while this device holds an edit the server has not got', async () => {
  mockEntrySyncState.mockResolvedValue({ unsynced: false, owed: true });
  await openMenuFor('e1');
  const share = screen.getByTestId('entry-menu-share');
  await waitFor(() => expect(share.props.accessibilityLabel).toMatch(/Save your changes first/));
  expect(share.props.accessibilityState).toEqual({ disabled: true });
});

it('Share on a synced entry closes the menu and opens the friend picker for THAT entry', async () => {
  await openMenuFor('e2');
  const share = screen.getByTestId('entry-menu-share');
  await waitFor(() => expect(share.props.accessibilityState).toEqual({ disabled: false }));
  await fireEvent.press(share);

  await screen.findByTestId('share-sheet');
  await waitFor(() => expect(mockListFriends).toHaveBeenCalled());
  expect(screen.queryByTestId('entry-menu-duplicate')).toBeNull();
});
