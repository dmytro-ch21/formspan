import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DescribeMealScreen from '../../app/food/describe';

/**
 * N472 — the totals footer and "compile into one meal".
 *
 * A description that comes back as several ingredients (a Chipotle-style
 * order is the ticket's own example) used to have no aggregate figure and no
 * way to log it as anything but N separate entries. This pins both additions:
 * a live totals footer that reflects the CURRENT rows (edits and removals,
 * not the original estimate), and a compile toggle that logs one combined
 * entry under an AI-suggested, editable name instead of looping per row.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockDescribe = jest.fn();
jest.mock('@/lib/estimateApi', () => {
  const real = jest.requireActual('@/lib/estimateApi');
  return {
    ...real,
    describeMeal: (...a: unknown[]) => mockDescribe(...a),
    photographMeal: jest.fn(),
  };
});

const mockLogFood = jest.fn();
const mockSaveFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  logFood: (...a: unknown[]) => mockLogFood(...a),
  saveFoodLocally: (...a: unknown[]) => mockSaveFood(...a),
}));
const mockRequestSync = jest.fn();
jest.mock('@/lib/sync', () => ({ request: (...a: unknown[]) => mockRequestSync(...a) }));
jest.mock('@/lib/barcodeCache', () => ({ rememberBarcode: jest.fn(), cachedBarcode: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({ SaveFormat: { JPEG: 'jpeg' } }));

const mockUseEffect = useEffect;
const mockBack = jest.fn();

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), back: () => mockBack(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

function item(over: Record<string, unknown> = {}) {
  return {
    name: 'Pollo Asado',
    serving_label: '1 standard serving',
    servings: 1,
    portion_confidence: 'medium',
    assumption: '',
    kcal: 180,
    protein_g: 32,
    carb_g: 2,
    fat_g: 5,
    fibre_g: 0,
    ...over,
  };
}

const CHIPOTLE_ITEMS = [
  item({ name: 'Pollo Asado', kcal: 180, protein_g: 32, carb_g: 2, fat_g: 5 }),
  item({ name: 'Brown rice', kcal: 105, protein_g: 2, carb_g: 22, fat_g: 1 }),
  item({ name: 'Fajita veggies', kcal: 10, protein_g: 1, carb_g: 1, fat_g: 0 }),
];

function response(items = CHIPOTLE_ITEMS, mealName = 'Chipotle chicken bowl') {
  return {
    estimate: { items, note: '', meal_name: mealName, model: 'test-model', source: 'text' },
    quota: { used: 1, limit: 25, remaining: 24, resets_at: null },
  };
}

beforeEach(() => {
  mockParams = { meal: 'lunch', date: '2026-08-19' };
  mockDescribe.mockReset();
  mockLogFood.mockReset().mockResolvedValue('entry-1');
  mockSaveFood.mockReset().mockResolvedValue('food-new');
  mockRequestSync.mockReset();
  mockBack.mockReset();
});

async function describeOnce(res = response()) {
  mockDescribe.mockResolvedValue(res);
  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'chipotle bowl');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
}

describe('the totals footer', () => {
  it('is absent for a single-item draft — the fields above already state its totals', async () => {
    await describeOnce(response([item()]));
    expect(screen.queryByTestId('describe-totals')).toBeNull();
  });

  it('sums kcal/protein/carb/fat across every row for a multi-item draft', async () => {
    await describeOnce();
    // 180+105+10 = 295 kcal, 32+2+1 = 35g protein, 2+22+1 = 25g carb, 5+1+0 = 6g fat.
    expect(screen.getByTestId('describe-totals')).toHaveTextContent(
      /295 kcal.*35g protein.*25g carb.*6g fat/,
    );
  });

  it('updates live when a row is removed', async () => {
    await describeOnce();
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-remove-2')); // Fajita veggies
    });
    // 180+105 = 285 kcal, 32+2 = 34g protein.
    expect(screen.getByTestId('describe-totals')).toHaveTextContent(/285 kcal.*34g protein/);
  });

  it('updates live when a field is hand-edited', async () => {
    await describeOnce();
    fireEvent.changeText(screen.getByTestId('describe-kcal-0'), '300');
    // 300+105+10 = 415, replacing the original 295.
    expect(screen.getByTestId('describe-totals')).toHaveTextContent(/415 kcal/);
  });

  it('does not appear once removals leave exactly one row', async () => {
    await describeOnce();
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-remove-2'));
      fireEvent.press(screen.getByTestId('describe-remove-1'));
    });
    expect(screen.queryByTestId('describe-totals')).toBeNull();
  });
});

describe('compiling into one meal', () => {
  it('offers the toggle only when there is more than one row', async () => {
    await describeOnce(response([item()]));
    expect(screen.queryByTestId('describe-compile-toggle')).toBeNull();
  });

  it('seeds the editable name from the model\'s own meal_name', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    expect(screen.getByTestId('describe-meal-name').props.value).toBe('Chipotle chicken bowl');
  });

  it('logs ONE combined entry with the summed macros and the (possibly edited) name', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    fireEvent.changeText(screen.getByTestId('describe-meal-name'), 'My chipotle order');

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    expect(mockSaveFood).toHaveBeenCalledTimes(1);
    const logged = mockLogFood.mock.calls[0][1];
    expect(logged.name).toBe('My chipotle order');
    expect(logged.kcal).toBe(295);
    expect(logged.protein_g).toBe(35);
    expect(logged.carb_g).toBe(25);
    expect(logged.fat_g).toBe(6);
    expect(logged.meal).toBe('lunch');
    expect(logged.eaten_on).toBe('2026-08-19');
    // The combined food it was saved under, threaded as provenance.
    expect(logged.source_food_id).toBe('food-new');

    // The saveFoodLocally contract savedFoodFrom promises — not just that it
    // was called, but called with the shape this feature actually depends
    // on: `ai` provenance (nobody measured a compiled meal either), the
    // edited name, and the same summed totals as the entry itself.
    const saved = mockSaveFood.mock.calls[0][1];
    expect(saved.source).toBe('ai');
    expect(saved.name).toBe('My chipotle order');
    expect(saved.serving_label).toBe('1 meal');
    expect(saved.kcal).toBe(295);

    expect(mockRequestSync).toHaveBeenCalled();
    expect(mockBack).toHaveBeenCalled();
  });

  it('reflects a hand-edited field, not the original estimate', async () => {
    await describeOnce();
    fireEvent.changeText(screen.getByTestId('describe-kcal-0'), '300');
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    // 300+105+10 = 415, not the original 295 — the same number the totals
    // footer itself would have shown at the moment of logging.
    expect(mockLogFood.mock.calls[0][1].kcal).toBe(415);
  });

  it('reflects a removed row, not the original three items', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-remove-2')); // Fajita veggies
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    // 180+105 = 285, not 295 — the removed row must not still be counted.
    expect(mockLogFood.mock.calls[0][1].kcal).toBe(285);
    expect(mockLogFood.mock.calls[0][1].protein_g).toBe(34);
  });

  it('the Log button states the compiled name, before and after a tap', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    fireEvent.changeText(screen.getByTestId('describe-meal-name'), 'My chipotle order');

    const button = screen.getByTestId('describe-log');
    expect(button.props.accessibilityLabel).toBe('Log My chipotle order');
    expect(button).toHaveTextContent('Log “My chipotle order”');
  });

  it('leaves every row on screen, and logs nothing, when the save fails', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    mockLogFood.mockRejectedValueOnce(new Error('offline'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    // Unlike `logAll`'s land-as-you-go loop, a failed compile drops nothing —
    // there is only one write, and it did not land.
    expect(screen.getByTestId('describe-error')).toHaveTextContent(/nothing was logged/i);
    expect(screen.queryByTestId('describe-remove-0')).toBeTruthy();
    expect(screen.queryByTestId('describe-remove-1')).toBeTruthy();
    expect(screen.queryByTestId('describe-remove-2')).toBeTruthy();
    expect(mockRequestSync).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('a retry after a failed log reuses the same saved-food id, rather than minting a duplicate', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    mockLogFood.mockRejectedValueOnce(new Error('offline'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });
    expect(screen.getByTestId('describe-error')).toBeTruthy();

    mockLogFood.mockResolvedValueOnce('entry-2');
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(2));
    expect(mockSaveFood).toHaveBeenCalledTimes(2);
    const firstId = mockSaveFood.mock.calls[0][1].id;
    const secondId = mockSaveFood.mock.calls[1][1].id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBe(firstId);
  });

  it('falls back to a joined-names default when the athlete clears the name field', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    fireEvent.changeText(screen.getByTestId('describe-meal-name'), '');

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    const logged = mockLogFood.mock.calls[0][1];
    expect(logged.name).toBe('Pollo Asado, Brown rice + 1 more');
  });

  it('unticking the toggle returns to logging every row separately', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    fireEvent.press(screen.getByTestId('describe-compile-toggle')); // back off

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(3));
  });

  it('a fresh estimate starts uncompiled, even after a previous draft was compiled', async () => {
    await describeOnce();
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    expect(screen.getByTestId('describe-meal-name').props.value).toBe('Chipotle chicken bowl');

    // A DIFFERENT meal_name, so re-seeding is actually observable — reusing
    // the same name would let a version that dropped `setMealName` from
    // `receive` pass this test by coincidence.
    mockDescribe.mockResolvedValue(response(CHIPOTLE_ITEMS, 'Bacon and eggs'));
    fireEvent.changeText(screen.getByTestId('describe-input'), 'bacon and eggs');
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-submit'));
    });
    await waitFor(() => expect(mockDescribe).toHaveBeenCalledTimes(2));

    expect(screen.queryByTestId('describe-meal-name')).toBeNull();
  });
});
