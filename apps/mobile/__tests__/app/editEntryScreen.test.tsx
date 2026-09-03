import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import EditEntryScreen from '../../app/food/entry/[id]';

/**
 * Correcting a logged entry — and the N59 regression review caught here:
 * the servings stepper rescales the four VISIBLE macros from the entry's own
 * per-serving figures, but this screen has no fields at all for the five N52
 * label macros (sat fat, sugar, added sugar, sodium, cholesterol). Sending
 * them back UNSCALED while the visible four ARE rescaled stores an entry
 * that disagrees with itself about how much was eaten — kcal for 1.5
 * servings beside sodium for 1. Found in review before merge; this pins the
 * fix rather than the bug.
 */

const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockLocalEntry = jest.fn();
const mockEditEntry = jest.fn();
const mockLocalFood = jest.fn();
const mockRemoveEntry = jest.fn();
// `splitEntry` is the ATOMIC helper (`foodLog.ts`) that logs the decomposed
// items and removes the combined entry as one transaction — mocked as a
// single call, matching `combineScreen.test.tsx`'s own convention.
const mockSplitEntry = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localEntry: (...a: unknown[]) => mockLocalEntry(...a),
  editEntry: (...a: unknown[]) => mockEditEntry(...a),
  localFood: (...a: unknown[]) => mockLocalFood(...a),
  removeEntry: (...a: unknown[]) => mockRemoveEntry(...a),
  splitEntry: (...a: unknown[]) => mockSplitEntry(...a),
  // N116/#505: unblocked by default — synced, and nothing owed.
  entrySyncState: jest.fn(async () => ({ unsynced: false, owed: false })),
}));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

/** Frozen "now" so `entry.eaten_on === todayString()` is deterministic — the
 *  split feature's whole behaviour hinges on that comparison (N115). */
const TODAY = '2026-09-02';
jest.mock('@/lib/nutrition', () => ({
  ...jest.requireActual('@/lib/nutrition'),
  todayString: () => TODAY,
}));

jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => ({ id: 'e1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

/** A one-serving entry with every N52 field stated, so a scaling bug has
 *  something real to get wrong. */
function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    eaten_on: '2026-08-19',
    meal: 'lunch',
    name: 'Chicken and rice',
    servings: 1,
    serving_label: '1 bowl',
    kcal: 400,
    protein_g: 30,
    carb_g: 40,
    fat_g: 10,
    fibre_g: 4,
    saturated_fat_g: 2,
    sugar_g: 6,
    added_sugar_g: 1,
    sodium_mg: 500,
    cholesterol_mg: 60,
    source_food_id: null,
    notes: '',
    ...over,
  };
}

async function open(e = entry()) {
  mockLocalEntry.mockResolvedValue(e);
  render(<EditEntryScreen />);
  await waitFor(() => expect(screen.getByTestId('edit-save')).toBeTruthy());
}

beforeEach(() => {
  mockLocalEntry.mockReset();
  mockEditEntry.mockReset().mockResolvedValue(undefined);
  // Default: no source food, matching `entry()`'s own `source_food_id: null`
  // — most tests here never touch N115 at all.
  mockLocalFood.mockReset().mockResolvedValue(null);
  mockRemoveEntry.mockReset().mockResolvedValue(undefined);
  mockSplitEntry.mockReset().mockResolvedValue(undefined);
});

it('rescales the five hidden N52 macros exactly as it rescales the visible four', async () => {
  await open();

  fireEvent.changeText(screen.getByTestId('edit-servings'), '1.5');
  await act(async () => {
    fireEvent.press(screen.getByTestId('edit-save'));
  });

  await waitFor(() => expect(mockEditEntry).toHaveBeenCalledTimes(1));
  const [, , saved] = mockEditEntry.mock.calls[0] as [string, string, Record<string, number>];

  // The visible four, scaled 1 -> 1.5 servings.
  expect(saved.kcal).toBeCloseTo(600, 1);
  expect(saved.protein_g).toBeCloseTo(45, 1);
  // The bug: these used to be sent back at their ORIGINAL 1-serving values
  // (500, 2, 6, 1, 60) regardless of what `servings` was changed to.
  expect(saved.sodium_mg).toBeCloseTo(750, 1);
  expect(saved.saturated_fat_g).toBeCloseTo(3, 1);
  expect(saved.sugar_g).toBeCloseTo(9, 1);
  expect(saved.added_sugar_g).toBeCloseTo(1.5, 1);
  expect(saved.cholesterol_mg).toBeCloseTo(90, 1);
});

it('keeps a null N52 field null rather than scaling it into a zero', async () => {
  await open(entry({ sodium_mg: null }));

  fireEvent.changeText(screen.getByTestId('edit-servings'), '2');
  await act(async () => {
    fireEvent.press(screen.getByTestId('edit-save'));
  });

  await waitFor(() => expect(mockEditEntry).toHaveBeenCalledTimes(1));
  const [, , saved] = mockEditEntry.mock.calls[0] as [string, string, Record<string, unknown>];
  expect(saved.sodium_mg).toBeNull();
});

it('leaves the hidden macros at 1x when servings is never touched', async () => {
  await open();

  await act(async () => {
    fireEvent.press(screen.getByTestId('edit-save'));
  });

  await waitFor(() => expect(mockEditEntry).toHaveBeenCalledTimes(1));
  const [, , saved] = mockEditEntry.mock.calls[0] as [string, string, Record<string, number>];
  expect(saved.sodium_mg).toBe(500);
  expect(saved.saturated_fat_g).toBe(2);
});

/**
 * N115 (#504) — "opened back into its parts", and "reversible on the day it
 * happened, or the copy says plainly that it is not". `recipeFood`'s items
 * come from `localFood`, keyed on `source_food_id`, so a recipe fixture is
 * what turns these tests on; the plain-food fixtures above never call it.
 */
function recipeFood(over: Record<string, unknown> = {}) {
  return {
    id: 'shake-food',
    kind: 'recipe',
    name: 'Protein shake',
    brand: '',
    serving_label: '1 serving',
    serving_grams: null,
    kcal: 510,
    protein_g: 36,
    carb_g: 49,
    fat_g: 19,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    yield_servings: 1,
    items: [
      { name: 'Milk', quantity: 1, serving_label: '250 ml', kcal: 150, protein_g: 8, carb_g: 12, fat_g: 8, fibre_g: null, saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null, source_food_id: null },
      { name: 'Protein powder', quantity: 1, serving_label: '1 scoop', kcal: 120, protein_g: 24, carb_g: 3, fat_g: 1, fibre_g: null, saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null, source_food_id: null },
    ],
    ...over,
  };
}

describe('"Made of" and splitting a combined meal back into its parts (N115)', () => {
  it('shows the recipe\'s items when the entry was logged from one', async () => {
    mockLocalFood.mockResolvedValue(recipeFood());
    await open(entry({ eaten_on: TODAY, source_food_id: 'shake-food' }));
    await waitFor(() => expect(screen.getByTestId('entry-made-of')).toBeTruthy());
    expect(screen.getByTestId('entry-made-of-0')).toBeTruthy();
    expect(screen.getByTestId('entry-made-of-1')).toBeTruthy();
  });

  it('shows nothing extra for an entry with no source food', async () => {
    await open(entry({ source_food_id: null }));
    expect(screen.queryByTestId('entry-made-of')).toBeNull();
  });

  /**
   * The blocking correctness gap frontend-review found before merge: a
   * recipe's `items` are the FULL BATCH, and they sum to this entry's own
   * total only when `yield_servings === entry.servings`. An ordinary N87
   * multi-portion recipe (`yield_servings: 4`) logged at ONE serving would
   * otherwise show "Made of" rows summing to 4× this entry's own kcal — the
   * exact "total that cannot be checked against its components" the ticket
   * names. Every OTHER vector in this describe block uses `yield_servings: 1`
   * and `servings: 1`, so nothing here would have caught the bug without
   * this pair.
   */
  it('shows nothing for a multi-portion recipe logged at fewer than its full yield', async () => {
    mockLocalFood.mockResolvedValue(recipeFood({ yield_servings: 4 }));
    await open(entry({ eaten_on: TODAY, servings: 1, source_food_id: 'shake-food' }));
    await waitFor(() => expect(mockLocalFood).toHaveBeenCalled());
    expect(screen.queryByTestId('entry-made-of')).toBeNull();
  });

  it('shows nothing once a combined (yield-1) entry\'s own servings have been edited away from 1', async () => {
    mockLocalFood.mockResolvedValue(recipeFood({ yield_servings: 1 }));
    await open(entry({ eaten_on: TODAY, servings: 2, source_food_id: 'shake-food' }));
    await waitFor(() => expect(mockLocalFood).toHaveBeenCalled());
    expect(screen.queryByTestId('entry-made-of')).toBeNull();
  });

  it('shows nothing extra when the source is a plain food, not a recipe', async () => {
    mockLocalFood.mockResolvedValue({ ...recipeFood(), kind: 'food', items: [], yield_servings: null });
    await open(entry({ source_food_id: 'plain-food' }));
    await waitFor(() => expect(mockLocalFood).toHaveBeenCalled());
    expect(screen.queryByTestId('entry-made-of')).toBeNull();
  });

  it('offers "Split into separate entries" for a combined entry logged TODAY', async () => {
    mockLocalFood.mockResolvedValue(recipeFood());
    await open(entry({ eaten_on: TODAY, source_food_id: 'shake-food' }));
    await waitFor(() => expect(screen.getByTestId('entry-split')).toBeTruthy());
    expect(screen.queryByTestId('entry-split-unavailable')).toBeNull();
  });

  /**
   * The AC this pins directly: "reversible on the day it happened, or the
   * copy says plainly that it is not." A past day gets the plain statement,
   * never the control — splitting it would change a log already used to
   * judge that day.
   */
  it('says plainly it cannot split a PAST day\'s combined entry, and offers no control for it', async () => {
    mockLocalFood.mockResolvedValue(recipeFood());
    await open(entry({ eaten_on: '2026-08-30', source_food_id: 'shake-food' }));
    await waitFor(() => expect(screen.getByTestId('entry-split-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('entry-split')).toBeNull();
  });

  it('asks splitEntry for one entry per item and removal of the combined one', async () => {
    mockLocalFood.mockResolvedValue(recipeFood());
    await open(entry({ id: 'combined-1', eaten_on: TODAY, meal: 'breakfast', source_food_id: 'shake-food' }));
    await waitFor(() => expect(screen.getByTestId('entry-split')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('entry-split'));
    });

    await waitFor(() => expect(mockSplitEntry).toHaveBeenCalledTimes(1));
    const [userIdArg, input] = mockSplitEntry.mock.calls[0] as [
      string,
      { entries: Record<string, unknown>[]; removeId: string },
    ];
    expect(userIdArg).toBe('u1');
    expect(input.entries).toHaveLength(2);
    expect(input.entries.map((r) => r.name)).toEqual(['Milk', 'Protein powder']);
    expect(input.entries.every((r) => r.meal === 'breakfast')).toBe(true);
    expect(input.entries.every((r) => r.eaten_on === TODAY)).toBe(true);
    // The sum of what was relogged equals the combined entry's own total —
    // the same "checkable against its components" property the combine
    // screen pins on the way in.
    expect(input.entries.reduce((sum, r) => sum + (r.kcal as number), 0)).toBe(150 + 120);
    expect(input.removeId).toBe('combined-1');
  });
});
