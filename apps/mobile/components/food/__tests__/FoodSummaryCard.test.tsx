/**
 * N468/#792 §2 — the day's summary card: item count, total calories and the
 * macro split consumed so far, distinct from `RemainingBlock`'s
 * remaining-focused figures.
 */
import { render, screen } from '@testing-library/react-native';

import { FoodSummaryCard } from '../FoodSummaryCard';
import type { EatenView, Entry } from '@/lib/nutrition';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    eaten_on: '2026-08-18',
    meal: 'breakfast',
    name: 'Oats',
    servings: 1,
    serving_label: '100 g',
    kcal: 145,
    protein_g: 11,
    carb_g: 20,
    fat_g: 11,
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

describe('FoodSummaryCard', () => {
  it('states the item count, total calories and macro split for a real day', () => {
    const eaten: EatenView = {
      state: 'ready',
      rows: [entry(), entry({ id: 'e2', kcal: 300, protein_g: 20, carb_g: 30, fat_g: 5 })],
      totals: { kcal: 445, protein_g: 31, carb_g: 50, fat_g: 16, fibre_g: null, saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null },
    };
    render(<FoodSummaryCard eaten={eaten} testID="food-summary" />);
    expect(screen.getByText('2 items logged · 445 kcal')).toBeTruthy();
    expect(screen.getByText('31g protein')).toBeTruthy();
    expect(screen.getByText('50g carbs')).toBeTruthy();
    expect(screen.getByText('16g fat')).toBeTruthy();
  });

  it('a genuine zero — nobody has logged yet — is a real, honest answer, not hidden', () => {
    const eaten: EatenView = {
      state: 'ready',
      rows: [],
      totals: { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fibre_g: null, saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null },
    };
    render(<FoodSummaryCard eaten={eaten} testID="food-summary" />);
    expect(screen.getByText('0 items logged · 0 kcal')).toBeTruthy();
  });

  it('singular "item" for exactly one entry', () => {
    const eaten: EatenView = {
      state: 'ready',
      rows: [entry()],
      totals: { kcal: 145, protein_g: 11, carb_g: 20, fat_g: 11, fibre_g: null, saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null },
    };
    render(<FoodSummaryCard eaten={eaten} testID="food-summary" />);
    expect(screen.getByText('1 item logged · 145 kcal')).toBeTruthy();
  });

  it('renders nothing while loading or unavailable — a read that has not happened is not a zero', () => {
    render(<FoodSummaryCard eaten={{ state: 'loading' }} testID="food-summary" />);
    expect(screen.queryByTestId('food-summary')).toBeNull();

    render(<FoodSummaryCard eaten={{ state: 'unavailable' }} testID="food-summary" />);
    expect(screen.queryByTestId('food-summary')).toBeNull();
  });
});
