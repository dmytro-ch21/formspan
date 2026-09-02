import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import CombineScreen from '../../app/food/combine';

/**
 * N115 (#504) — "select several logged entries and combine them into one
 * named item". What is pinned here is the WIRING: which entries this screen
 * resolves the selected ids to, that it saves a one-serving recipe, logs ONE
 * new entry for it, and deletes every entry it was built from — the replace
 * half of "squash them all in one", not merely a saved template beside four
 * untouched rows. The arithmetic itself (`itemFromEntry`, the sum) is pinned
 * in `lib/__tests__/recipe.test.ts`.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockLocalEntries = jest.fn();
const mockLogFood = jest.fn();
const mockRemoveEntry = jest.fn();
const mockSaveFoodLocally = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localEntries: (...a: unknown[]) => mockLocalEntries(...a),
  logFood: (...a: unknown[]) => mockLogFood(...a),
  removeEntry: (...a: unknown[]) => mockRemoveEntry(...a),
  saveFoodLocally: (...a: unknown[]) => mockSaveFoodLocally(...a),
}));

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

/** See `addFoodCatalog.test.tsx`: a `mock`-prefixed binding rather than a
 *  `require` inside the factory, which the lint ratchet will not absorb. */
const mockUseEffect = useEffect;

const mockBack = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  __esModule: true,
  // `KeyboardAwareScrollView` (this screen's own container) calls this
  // internally — without it every test in this file fails inside that
  // component, not inside anything this screen owns.
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), back: mockBack, replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    eaten_on: '2026-09-01',
    meal: 'breakfast',
    name: 'Whole milk',
    servings: 1,
    serving_label: '250 ml',
    kcal: 150,
    protein_g: 8,
    carb_g: 12,
    fat_g: 8,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source_food_id: null,
    category: null,
    notes: '',
    ...over,
  };
}

const MILK = entry({ id: 'e1', name: 'Whole milk', kcal: 150, protein_g: 8 });
const PROTEIN = entry({ id: 'e2', name: 'Protein powder', kcal: 120, protein_g: 24 });
const BERRIES = entry({ id: 'e3', name: 'Berries', kcal: 40, protein_g: 1 });
const ICE_CREAM = entry({ id: 'e4', name: 'Ice cream', kcal: 200, protein_g: 3 });

async function open(ids = 'e1,e2,e3,e4', rows = [MILK, PROTEIN, BERRIES, ICE_CREAM]) {
  mockParams = { date: '2026-09-01', meal: 'breakfast', ids };
  mockLocalEntries.mockResolvedValue(rows);
  render(<CombineScreen />);
  await waitFor(() => expect(screen.getByTestId('combine-name')).toBeTruthy());
}

beforeEach(() => {
  mockLocalEntries.mockReset();
  mockLogFood.mockReset().mockResolvedValue('new-entry-id');
  mockRemoveEntry.mockReset().mockResolvedValue(undefined);
  mockSaveFoodLocally.mockReset().mockResolvedValue('new-food-id');
  mockBack.mockReset();
});

it('resolves the selected ids against the day and shows only those, with the visible sum', async () => {
  await open();
  expect(screen.getByTestId('combine-item-0')).toBeTruthy();
  expect(screen.getByTestId('combine-item-3')).toBeTruthy();
  expect(screen.getByText('510 kcal')).toBeTruthy(); // 150+120+40+200, the total row.
});

it('refuses to save with no name', async () => {
  await open();
  expect(screen.getByTestId('combine-problem')).toBeTruthy();
  expect(screen.getByTestId('combine-save').props.accessibilityState.disabled).toBe(true);
});

it('says plainly when so much of the selection is gone that combining makes no sense', async () => {
  mockParams = { date: '2026-09-01', meal: 'breakfast', ids: 'e1,e2,e3,e4' };
  // Only ONE of the four resolves — the other three were deleted elsewhere
  // (another device, or the same day screen in another tab). Fewer than two
  // is not "combine one thing with nothing", it is nothing to combine.
  mockLocalEntries.mockResolvedValue([MILK]);
  render(<CombineScreen />);
  await waitFor(() => expect(screen.getByTestId('combine-too-few')).toBeTruthy());
});

describe('saving', () => {
  async function save() {
    await open();
    fireEvent.changeText(screen.getByTestId('combine-name'), 'Protein shake');
    await act(async () => {
      fireEvent.press(screen.getByTestId('combine-save'));
    });
  }

  it('saves a one-serving recipe built from the four entries', async () => {
    await save();
    await waitFor(() => expect(mockSaveFoodLocally).toHaveBeenCalledTimes(1));
    const [, food] = mockSaveFoodLocally.mock.calls[0] as [string, Record<string, unknown>];
    expect(food.kind).toBe('recipe');
    expect(food.yield_servings).toBe(1);
    expect(food.name).toBe('Protein shake');
    expect((food.items as unknown[]).length).toBe(4);
    // One serving of a one-serving recipe IS the sum of its parts — the
    // arithmetic this screen shows has to be the same number that gets saved.
    expect(food.kcal).toBe(510);
  });

  it('logs exactly ONE new entry, pointing at the saved recipe', async () => {
    await save();
    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    const [, logged] = mockLogFood.mock.calls[0] as [string, Record<string, unknown>];
    expect(logged.eaten_on).toBe('2026-09-01');
    expect(logged.meal).toBe('breakfast');
    expect(logged.servings).toBe(1);
    expect(logged.kcal).toBe(510);
    expect(logged.source_food_id).toBe('new-food-id');
  });

  it('removes every entry it was built from — the replace half of "combine"', async () => {
    await save();
    await waitFor(() => expect(mockRemoveEntry).toHaveBeenCalledTimes(4));
    const removedIds = mockRemoveEntry.mock.calls.map((c) => c[1]);
    expect(removedIds.sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('navigates back once combined', async () => {
    await save();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });
});
