import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SavedFoodsScreen from '../../app/food/saved/index';
import type { Food } from '@/lib/nutrition';

/**
 * N79 — the phone-impossible audit's "saved-food management is web-only" gap.
 *
 * Editing and building are already someone else's screens (`food/saved/[id]`,
 * `food/recipe/[id]`, `food/add.tsx`); what is pinned HERE is that this screen
 * finds the right one for a row's `kind` (N87's split), and that deleting goes
 * through `removeFood` — the local-first tombstone `lib/foodLog.ts`'s `push()`
 * now owes to the server — rather than doing anything of its own.
 */
jest.setTimeout(30_000);

const mockUseEffect = useEffect;

const mockLocalFoods = jest.fn();
const mockRemoveFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localFoods: (...a: unknown[]) => mockLocalFoods(...a),
  removeFood: (...a: unknown[]) => mockRemoveFood(...a),
}));

const mockRequestSync = jest.fn();
jest.mock('@/lib/sync', () => ({ request: (...a: unknown[]) => mockRequestSync(...a) }));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

// The hold gesture has its own suite (`holdToConfirm.test.tsx`); this stands in
// a plain button that fires `onConfirm` on press, the same substitution
// `curriculumBuilderScreens.test.tsx` and `trackers/archived.tsx`'s own
// (untested) delete would use.
jest.mock('@/components/HoldToConfirm', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    HoldToConfirm: ({
      label,
      onConfirm,
      testID,
    }: {
      label: string;
      onConfirm: () => void;
      testID?: string;
    }) =>
      React.createElement(Pressable, { onPress: onConfirm, testID }, React.createElement(Text, null, label)),
  };
});

function food(over: Partial<Food> = {}): Food {
  return {
    id: 'f1',
    kind: 'food',
    name: 'Chicken thigh',
    brand: '',
    serving_label: '100 g',
    serving_grams: 100,
    kcal: 250,
    protein_g: 22,
    carb_g: 0,
    fat_g: 18,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source: 'user',
    yield_servings: null,
    items: [],
    ...over,
  };
}

beforeEach(() => {
  mockLocalFoods.mockReset().mockResolvedValue([]);
  mockRemoveFood.mockReset().mockResolvedValue(undefined);
  mockRequestSync.mockReset();
  mockPush.mockReset();
});

it('lists a saved food with its per-serving macros', async () => {
  mockLocalFoods.mockResolvedValue([food({ name: 'Chicken thigh', kcal: 250, protein_g: 22 })]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByText('Chicken thigh')).toBeTruthy());
  expect(screen.getByText(/250 kcal/)).toBeTruthy();
  expect(screen.getByText(/22P/)).toBeTruthy();
});

it('marks a recipe distinctly from a plain food', async () => {
  mockLocalFoods.mockResolvedValue([
    food({ id: 'r1', kind: 'recipe', name: 'Sunday traybake', yield_servings: 4, items: [] }),
  ]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByText('Sunday traybake')).toBeTruthy());
  expect(screen.getByText('Recipe')).toBeTruthy();
  expect(screen.getByText(/Makes 4/)).toBeTruthy();
});

it('shows the empty state when nothing is saved, not a spinner forever', async () => {
  mockLocalFoods.mockResolvedValue([]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-empty')).toBeTruthy());
});

it('searches by re-reading the local list rather than filtering in memory', async () => {
  mockLocalFoods.mockResolvedValue([]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', ''));

  mockLocalFoods.mockClear();
  fireEvent.changeText(screen.getByTestId('saved-foods-search'), 'chick');
  await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', 'chick'));
});

/**
 * **N87, the same guard `food/add.tsx`'s own Edit button carries.** A recipe
 * opened through the plain-food editor writes an empty `items` and a null
 * `yield_servings` on save, which the server refuses as a permanent 400 — and
 * the athlete's ingredient list is gone with nothing saying so. This screen
 * must route each `kind` to its own editor rather than guessing one for both.
 */
it('opens the plain-food editor for a food and the recipe editor for a recipe', async () => {
  mockLocalFoods.mockResolvedValue([
    food({ id: 'plain', name: 'Oats', kind: 'food' }),
    food({ id: 'rec', name: 'Traybake', kind: 'recipe', yield_servings: 4 }),
  ]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-edit-plain')).toBeTruthy());

  fireEvent.press(screen.getByTestId('saved-foods-edit-plain'));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/food/saved/[id]', params: { id: 'plain' } });

  fireEvent.press(screen.getByTestId('saved-foods-edit-rec'));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/food/recipe/[id]', params: { id: 'rec' } });
});

it('deletes through removeFood, requests a sync, and reloads the list', async () => {
  mockLocalFoods.mockResolvedValueOnce([food({ id: 'f1', name: 'Chicken thigh' })]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-delete-f1')).toBeTruthy());

  mockLocalFoods.mockResolvedValueOnce([]);
  await act(async () => {
    fireEvent.press(screen.getByTestId('saved-foods-delete-f1'));
  });

  expect(mockRemoveFood).toHaveBeenCalledWith('u1', 'f1');
  expect(mockRequestSync).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByTestId('saved-foods-empty')).toBeTruthy());
});

it('shows an error and keeps the row when the delete fails, rather than pretending it worked', async () => {
  mockLocalFoods.mockResolvedValue([food({ id: 'f1', name: 'Chicken thigh' })]);
  mockRemoveFood.mockRejectedValue(new Error('offline'));
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-delete-f1')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByTestId('saved-foods-delete-f1'));
  });

  expect(screen.getByTestId('saved-foods-error')).toHaveTextContent('offline');
  expect(screen.getByText('Chicken thigh')).toBeTruthy();
});

it('shows the load error rather than a silently empty list', async () => {
  mockLocalFoods.mockRejectedValue(new Error('could not read the database'));
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-error')).toBeTruthy());
});
