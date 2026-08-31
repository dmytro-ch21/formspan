/**
 * MealCard's one real branch: a populated section states what it ATE, an
 * empty one states what is still AVAILABLE — never a row of zeroes. This is
 * the UI expression of N124/N113's reversal (`docs/decisions/history.md`,
 * 2026-08-31), and `MealCard.tsx`'s own doc comment names the risk of leaving
 * it untested: "a rule in a component is a rule no test can reach."
 *
 * The arithmetic behind `totals`/`available` is already covered in
 * `lib/__tests__/nutrition.test.ts` — this file only asks whether the
 * component picks the right sentence for what it's handed, plus the one
 * genuinely render-only property `ac-verifier` found missing: the food row's
 * amount is unit-aware (#483), not the raw stored label.
 */
import { render, screen } from '@testing-library/react-native';

import { MealCard } from '../MealCard';
import type { Entry, Macros } from '@/lib/nutrition';

jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ foodUnit: 'g' }) }));

const zeroMacros: Macros = {
  kcal: 0,
  protein_g: 0,
  carb_g: 0,
  fat_g: 0,
  fibre_g: null,
  saturated_fat_g: null,
  sugar_g: null,
  added_sugar_g: null,
  sodium_mg: null,
  cholesterol_mg: null,
};

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    eaten_on: '2026-08-18',
    meal: 'breakfast',
    name: 'Oats',
    servings: 1.5,
    serving_label: '100 g',
    kcal: 145,
    protein_g: 11,
    carb_g: 0,
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

function renderCard(over: Partial<React.ComponentProps<typeof MealCard>> = {}) {
  return render(
    <MealCard
      meal="breakfast"
      label="Breakfast"
      entries={[]}
      totals={zeroMacros}
      available={null}
      addColor="#d3ec52"
      onAdd={() => {}}
      onEntryPress={() => {}}
      onDelete={() => {}}
      testID="meal-breakfast"
      {...over}
    />,
  );
}

describe('populated vs. empty — a different sentence, never the same one at zero', () => {
  it('a populated section states what was eaten, in the header', () => {
    renderCard({
      entries: [entry()],
      totals: { ...zeroMacros, kcal: 145, protein_g: 11, carb_g: 0, fat_g: 11 },
    });
    expect(screen.getByText('Breakfast · 145 kcal')).toBeTruthy();
    expect(screen.getByTestId('meal-breakfast-macros')).toBeTruthy();
    expect(screen.queryByTestId('meal-breakfast-available')).toBeNull();
  });

  it('an empty section with a target states what is still AVAILABLE, never a zero row', () => {
    renderCard({
      entries: [],
      available: { ...zeroMacros, kcal: 938, protein_g: 41, carb_g: 74, fat_g: 16 },
    });
    expect(screen.getByTestId('meal-breakfast-header').props.children).toBe('Breakfast');
    expect(screen.getByText('938 kcal now available')).toBeTruthy();
    expect(screen.queryByText(/^0 kcal/)).toBeNull();
  });

  it('an empty section with NO target shows neither an eaten line nor an available one', () => {
    renderCard({ entries: [], available: null });
    expect(screen.queryByTestId('meal-breakfast-macros')).toBeNull();
    expect(screen.queryByTestId('meal-breakfast-available')).toBeNull();
  });
});

describe('food row amounts are unit-aware (#483)', () => {
  it('a gram-basis entry converts through the athlete\'s chosen unit', () => {
    renderCard({ entries: [entry({ servings: 1.5, serving_label: '100 g' })] });
    expect(screen.getByText('150g')).toBeTruthy();
  });

  it('a non-gram label is shown as logged, not relabelled as a weight', () => {
    renderCard({ entries: [entry({ servings: 2, serving_label: '1 Each' })] });
    expect(screen.getByText('2 × 1 Each')).toBeTruthy();
  });
});
