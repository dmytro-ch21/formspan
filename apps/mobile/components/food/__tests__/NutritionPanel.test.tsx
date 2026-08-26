/**
 * The N59 nutrition panel's one load-bearing rule: `n/a`, never `0`, for a
 * value this food does not state — and that a stated value renders as a
 * number, not as the same `n/a`.
 */
import { render, screen } from '@testing-library/react-native';

import { NutritionPanel } from '../NutritionPanel';
import type { Macros } from '@/lib/nutrition';

function macros(over: Partial<Macros> = {}): Macros {
  return {
    kcal: 250,
    protein_g: 20,
    carb_g: 30,
    fat_g: 8,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    ...over,
  };
}

describe('the nutrition panel', () => {
  it('shows the calorie total, rounded', () => {
    render(<NutritionPanel macros={macros({ kcal: 247.6 })} />);
    expect(screen.getByTestId('nutrition-panel-kcal').props.children).toBe(248);
  });

  it('shows n/a for every value this food does not state, never a zero', () => {
    render(<NutritionPanel macros={macros()} />);
    // A zero would read as "this food has no sodium" — a claim the data does
    // not support. `n/a` is the only honest rendering of an absence.
    expect(screen.getByTestId('nutrition-panel-saturated_fat_g-value')).toHaveTextContent('n/a');
    expect(screen.getByTestId('nutrition-panel-cholesterol_mg-value')).toHaveTextContent('n/a');
    expect(screen.getByTestId('nutrition-panel-sodium_mg-value')).toHaveTextContent('n/a');
    expect(screen.getByTestId('nutrition-panel-fibre_g-value')).toHaveTextContent('n/a');
    expect(screen.getByTestId('nutrition-panel-sugar_g-value')).toHaveTextContent('n/a');
    expect(screen.getByTestId('nutrition-panel-added_sugar_g-value')).toHaveTextContent('n/a');
  });

  it('renders a genuine zero as a zero, not as n/a', () => {
    // The case the n/a rule must not sweep up: a food that states zero sodium
    // has stated zero sodium, and that is a fact worth showing as one.
    render(<NutritionPanel macros={macros({ sodium_mg: 0 })} />);
    expect(screen.getByTestId('nutrition-panel-sodium_mg-value')).toHaveTextContent('0mg');
  });

  it('renders every stated N52 label macro with its unit', () => {
    render(
      <NutritionPanel
        macros={macros({
          saturated_fat_g: 2.5,
          sugar_g: 12,
          added_sugar_g: 5,
          sodium_mg: 430,
          cholesterol_mg: 65,
        })}
      />,
    );
    expect(screen.getByTestId('nutrition-panel-saturated_fat_g-value')).toHaveTextContent('2.5g');
    expect(screen.getByTestId('nutrition-panel-sugar_g-value')).toHaveTextContent('12g');
    expect(screen.getByTestId('nutrition-panel-added_sugar_g-value')).toHaveTextContent('5g');
    expect(screen.getByTestId('nutrition-panel-sodium_mg-value')).toHaveTextContent('430mg');
    expect(screen.getByTestId('nutrition-panel-cholesterol_mg-value')).toHaveTextContent('65mg');
  });

  it('recalculates as the amount changes — a re-render with new macros shows the new figures', () => {
    const { rerender } = render(<NutritionPanel macros={macros({ kcal: 100, sodium_mg: 50 })} />);
    expect(screen.getByTestId('nutrition-panel-kcal').props.children).toBe(100);
    rerender(<NutritionPanel macros={macros({ kcal: 200, sodium_mg: 100 })} />);
    expect(screen.getByTestId('nutrition-panel-kcal').props.children).toBe(200);
    expect(screen.getByTestId('nutrition-panel-sodium_mg-value')).toHaveTextContent('100mg');
  });

  // Refused deliberately — see the component's own doc comment. Asserted here
  // so the refusal cannot be quietly reversed by somebody restoring the
  // button from the design reference without re-reading why it isn't there.
  it('offers no "View Full Nutrition Label" button', () => {
    render(<NutritionPanel macros={macros()} />);
    expect(screen.queryByText(/view full nutrition label/i)).toBeNull();
  });
});
