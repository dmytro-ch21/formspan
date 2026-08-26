/**
 * The quantity control (N90).
 *
 * The logic is covered in `lib/__tests__/foodQuantity.test.ts`; this covers the
 * part only a rendered component can get wrong — that the g/oz toggle CONVERTS
 * the number rather than relabelling it, and that a portion tap fills the field
 * rather than bypassing it.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

import { FoodQuantity } from '../FoodQuantity';
import type { CatalogFood } from '@/lib/catalogApi';

const mockSetFoodUnit = jest.fn();
let mockUnit: 'g' | 'oz' = 'g';

jest.mock('@/lib/UnitsProvider', () => ({
  useUnits: () => ({
    units: 'metric',
    unitsReady: true,
    setUnits: jest.fn(),
    unsynced: false,
    foodUnit: mockUnit,
    setFoodUnit: mockSetFoodUnit,
  }),
}));

const egg: CatalogFood = {
  id: 'egg-whole',
  name: 'Egg',
  brand: '',
  category: 'egg',
  serving_label: '100 g',
  serving_grams: 100,
  kcal: 143,
  protein_g: 12.6,
  carb_g: 0.7,
  fat_g: 9.5,
  fibre_g: null,
  saturated_fat_g: null,
  sugar_g: null,
  added_sugar_g: null,
  sodium_mg: null,
  cholesterol_mg: null,
  portions: [
    { seq: 1, label: '1 large', grams: 50 },
    { seq: 2, label: '1 jumbo', grams: 63 },
  ],
};

beforeEach(() => {
  mockUnit = 'g';
  mockSetFoodUnit.mockClear();
});

test('logs the grams the athlete chose, not one 100 g serving', () => {
  const onLog = jest.fn();
  render(<FoodQuantity food={egg} onLog={onLog} />);

  fireEvent.changeText(screen.getByTestId('food-quantity-input'), '150');
  fireEvent.press(screen.getByTestId('food-quantity-log'));

  expect(onLog).toHaveBeenCalledWith(150);
});

test('tapping a portion fills the field rather than bypassing it', () => {
  const onLog = jest.fn();
  render(<FoodQuantity food={egg} onLog={onLog} />);

  fireEvent.press(screen.getByTestId('food-portion-63'));
  // The field must SHOW the change — a portion that logged straight through
  // would leave the athlete unable to nudge it to 65.
  expect(screen.getByTestId('food-quantity-input').props.value).toBe('63');

  fireEvent.press(screen.getByTestId('food-quantity-log'));
  expect(onLog).toHaveBeenCalledWith(63);
});

test('switching to oz CONVERTS the displayed number', () => {
  // The failure this exists for: a toggle that relabels turns 150 grams into
  // 150 ounces — a 28x overcount, with nothing on screen changing but two
  // letters.
  render(<FoodQuantity food={egg} onLog={jest.fn()} />);

  fireEvent.changeText(screen.getByTestId('food-quantity-input'), '150');
  fireEvent.press(screen.getByTestId('food-unit-oz'));

  expect(screen.getByTestId('food-quantity-input').props.value).toBe('5.29');
  expect(mockSetFoodUnit).toHaveBeenCalledWith('oz');
});

test('a quantity typed in oz logs the equivalent GRAMS', () => {
  mockUnit = 'oz';
  const onLog = jest.fn();
  render(<FoodQuantity food={egg} onLog={onLog} />);

  fireEvent.changeText(screen.getByTestId('food-quantity-input'), '4');
  fireEvent.press(screen.getByTestId('food-quantity-log'));

  // 4 oz = 113.4 g. Storage is always grams.
  expect(onLog.mock.calls[0][0]).toBeCloseTo(113.4, 1);
});

test('the macros shown update before anything is logged', () => {
  render(<FoodQuantity food={egg} onLog={jest.fn()} />);
  fireEvent.press(screen.getByTestId('food-portion-50'));
  // Half of 143 kcal.
  expect(screen.getByTestId('food-quantity-macros').props.children).toContain('71.5 kcal');
});

test('an unusable quantity cannot be logged', () => {
  const onLog = jest.fn();
  render(<FoodQuantity food={egg} onLog={onLog} />);

  for (const bad of ['', '0', 'abc']) {
    fireEvent.changeText(screen.getByTestId('food-quantity-input'), bad);
    fireEvent.press(screen.getByTestId('food-quantity-log'));
  }
  // servings CHECKs > 0 server-side; a zero would be a 500, not an empty meal.
  expect(onLog).not.toHaveBeenCalled();
});

test('a food with no portions still offers 100 g', () => {
  render(<FoodQuantity food={{ ...egg, portions: [] }} onLog={jest.fn()} />);
  expect(screen.getByTestId('food-portion-100')).toBeTruthy();
});

/**
 * The unit changing from OUTSIDE the component (raised in review).
 *
 * `switchUnit` is not the only way `foodUnit` moves: the provider adopts the
 * server's value after the profile read resolves, which can land while this
 * sheet is open. Before the fix, the toggle highlight and the input's
 * accessibility label flipped while the number did not — a relabel nobody
 * touched, and editing the field then committed a ~28x quantity.
 */
test('a unit change from the provider re-renders the field, it does not relabel it', () => {
  const { rerender } = render(<FoodQuantity food={egg} onLog={jest.fn()} />);
  fireEvent.changeText(screen.getByTestId('food-quantity-input'), '150');
  expect(screen.getByTestId('food-quantity-input').props.value).toBe('150');

  // The provider adopts 'oz' from the server. Nothing in this component was
  // touched.
  mockUnit = 'oz';
  rerender(<FoodQuantity food={egg} onLog={jest.fn()} />);

  expect(screen.getByTestId('food-quantity-input').props.value).toBe('5.29');
});

test('an outside unit change does not fight the athlete mid-keystroke', () => {
  // The effect is keyed on the unit alone. Keyed on grams too, it would rewrite
  // the field on every edit and make "10" un-typeable on the way to "100".
  render(<FoodQuantity food={egg} onLog={jest.fn()} />);
  fireEvent.changeText(screen.getByTestId('food-quantity-input'), '1');
  fireEvent.changeText(screen.getByTestId('food-quantity-input'), '10');
  expect(screen.getByTestId('food-quantity-input').props.value).toBe('10');
});
