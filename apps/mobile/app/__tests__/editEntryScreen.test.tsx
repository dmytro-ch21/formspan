import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import EditEntryScreen from '../food/entry/[id]';

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
jest.mock('@/lib/foodLog', () => ({
  localEntry: (...a: unknown[]) => mockLocalEntry(...a),
  editEntry: (...a: unknown[]) => mockEditEntry(...a),
  removeEntry: jest.fn(),
}));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

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
