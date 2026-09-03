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
import { fireEvent, render, screen } from '@testing-library/react-native';

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
    expect(screen.getByText('Breakfast · 1 item · 145 kcal')).toBeTruthy();
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

/**
 * N484 — the header's entry count. Found from a user report: a collapsed
 * section (the header is the only thing still visible, see "collapsible
 * sections" below) used to state the kcal total and nothing else, so
 * "was this one big thing or four small ones" required expanding every
 * card to answer. `FoodSummaryCard`'s "N items logged · kcal" phrasing is
 * reused rather than invented fresh, so the day-level card and every
 * per-meal card agree on how they count.
 */
describe('the header counts entries — N484', () => {
  it('pluralises for more than one entry', () => {
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' })],
      totals: { ...zeroMacros, kcal: 290 },
    });
    expect(screen.getByText('Breakfast · 2 items · 290 kcal')).toBeTruthy();
  });

  it('stays singular for exactly one entry', () => {
    renderCard({ entries: [entry()], totals: { ...zeroMacros, kcal: 145 } });
    expect(screen.getByText('Breakfast · 1 item · 145 kcal')).toBeTruthy();
  });

  it('an empty section states no count at all — nothing to count yet', () => {
    renderCard({ entries: [], available: null });
    expect(screen.queryByText(/item/)).toBeNull();
    expect(screen.getByTestId('meal-breakfast-header').props.children).toBe('Breakfast');
  });

  it('the count stays visible when the section is collapsed — it is the whole point', () => {
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' })],
      totals: { ...zeroMacros, kcal: 290 },
    });
    fireEvent.press(screen.getByTestId('meal-breakfast-toggle'));
    expect(screen.getByText('Breakfast · 2 items · 290 kcal')).toBeTruthy();
  });

  /**
   * `accessibilityLabel` on an accessible `Pressable` REPLACES its visible
   * children's text for VoiceOver rather than supplementing it — so adding
   * the count to the on-screen `Text` alone would have widened the existing
   * gap `accessibilityLabel={label}` already left (the kcal total was never
   * announced either; see the toggle's own doc comment for why the label
   * carries no STATE). Sighted-only progress is exactly what this feature
   * exists to fix, so the label has to carry the same content as the text.
   */
  it('announces the count and total to VoiceOver too, not only sighted athletes', () => {
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' })],
      totals: { ...zeroMacros, kcal: 290 },
    });
    expect(screen.getByTestId('meal-breakfast-toggle').props.accessibilityLabel).toBe(
      'Breakfast, 2 items, 290 calories',
    );
  });

  it('an empty section\'s label stays the bare name — nothing to announce a count of', () => {
    renderCard({ entries: [], available: null });
    expect(screen.getByTestId('meal-breakfast-toggle').props.accessibilityLabel).toBe('Breakfast');
  });
});

describe('collapsible sections — N468/#792', () => {
  it('defaults expanded regardless of whether the slot has entries', () => {
    renderCard({ entries: [entry()], totals: { ...zeroMacros, kcal: 145 } });
    expect(screen.getByTestId('meal-breakfast-macros')).toBeTruthy();

    renderCard({ entries: [], available: { ...zeroMacros, kcal: 938 } });
    expect(screen.getByTestId('meal-breakfast-available')).toBeTruthy();
  });

  it('collapsing hides the macro line and the logged rows, without losing or resetting anything', () => {
    const e = entry();
    renderCard({
      entries: [e],
      totals: { ...zeroMacros, kcal: 145, protein_g: 11, carb_g: 0, fat_g: 11 },
    });

    // Expanded: the macro row and the logged item are both visible.
    expect(screen.getByTestId('meal-breakfast-macros')).toBeTruthy();
    expect(screen.getByText('Oats')).toBeTruthy();

    fireEvent.press(screen.getByTestId('meal-breakfast-toggle'));

    // Collapsed: gone from the tree — but the header (which already states
    // the slot's own total) and the Add button both stay reachable.
    expect(screen.queryByTestId('meal-breakfast-macros')).toBeNull();
    expect(screen.queryByText('Oats')).toBeNull();
    expect(screen.getByText('Breakfast · 1 item · 145 kcal')).toBeTruthy();
    expect(screen.getByTestId('food-add-breakfast')).toBeTruthy();

    // Expanding again shows the SAME entry, unaffected by the toggle —
    // collapsing is purely a display state, never a data mutation.
    fireEvent.press(screen.getByTestId('meal-breakfast-toggle'));
    expect(screen.getByTestId('meal-breakfast-macros')).toBeTruthy();
    expect(screen.getByText('Oats')).toBeTruthy();
  });

  it('reflects its state in accessibility so a collapsed section reads as collapsed', () => {
    renderCard({ entries: [entry()] });
    const toggle = screen.getByTestId('meal-breakfast-toggle');
    expect(toggle.props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));

    fireEvent.press(toggle);
    expect(toggle.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
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

/**
 * N115 — combine-select. `MealCard.tsx`'s own doc comment states the scope
 * rule ("select entries IN A SECTION") and the reason `enabled={!selecting}`
 * replaces unmounting `SwipeToDelete` rather than swapping it out; these tests
 * are about what a caller sees, not how the gesture conflict is avoided.
 */
describe('combine-select mode (N115)', () => {
  it('offers "Combine" once a section has two or more entries', () => {
    renderCard({ entries: [entry({ id: 'a' }), entry({ id: 'b' })], onStartCombine: () => {} });
    expect(screen.getByTestId('meal-breakfast-combine-start')).toBeTruthy();
  });

  it('does not offer it for a single entry — nothing to combine with', () => {
    renderCard({ entries: [entry({ id: 'a' })], onStartCombine: () => {} });
    expect(screen.queryByTestId('meal-breakfast-combine-start')).toBeNull();
  });

  it('does not offer it when the caller has no combine handler at all', () => {
    renderCard({ entries: [entry({ id: 'a' }), entry({ id: 'b' })] });
    expect(screen.queryByTestId('meal-breakfast-combine-start')).toBeNull();
  });

  it('tapping "Combine" tells the caller to start selecting', () => {
    const onStartCombine = jest.fn();
    renderCard({ entries: [entry({ id: 'a' }), entry({ id: 'b' })], onStartCombine });
    fireEvent.press(screen.getByTestId('meal-breakfast-combine-start'));
    expect(onStartCombine).toHaveBeenCalledTimes(1);
  });

  it('while selecting, tapping a row toggles selection instead of opening it', () => {
    const onToggleSelect = jest.fn();
    const onEntryPress = jest.fn();
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' })],
      selecting: true,
      selectedIds: new Set(),
      onToggleSelect,
      onEntryPress,
    });
    fireEvent.press(screen.getByTestId('food-entry-a-select'));
    expect(onToggleSelect).toHaveBeenCalledWith('a');
    expect(onEntryPress).not.toHaveBeenCalled();
  });

  it('marks a selected row as a checked checkbox for assistive tech', () => {
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' })],
      selecting: true,
      selectedIds: new Set(['a']),
    });
    expect(screen.getByTestId('food-entry-a-select').props.accessibilityRole).toBe('checkbox');
    expect(screen.getByTestId('food-entry-a-select').props.accessibilityState).toEqual({
      checked: true,
    });
    expect(screen.getByTestId('food-entry-b-select').props.accessibilityState).toEqual({
      checked: false,
    });
  });

  it('the confirm button is disabled with fewer than two selected', () => {
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })],
      selecting: true,
      selectedIds: new Set(['a']),
    });
    expect(
      screen.getByTestId('meal-breakfast-combine-confirm').props.accessibilityState.disabled,
    ).toBe(true);
  });

  it('confirming with two or more selected calls back with nothing else required', () => {
    const onConfirmCombine = jest.fn();
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })],
      selecting: true,
      selectedIds: new Set(['a', 'b']),
      onConfirmCombine,
    });
    const confirm = screen.getByTestId('meal-breakfast-combine-confirm');
    expect(confirm.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(confirm);
    expect(onConfirmCombine).toHaveBeenCalledTimes(1);
  });

  it('cancelling tells the caller to leave selecting mode', () => {
    const onCancelCombine = jest.fn();
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' })],
      selecting: true,
      selectedIds: new Set(),
      onCancelCombine,
    });
    fireEvent.press(screen.getByTestId('meal-breakfast-combine-cancel'));
    expect(onCancelCombine).toHaveBeenCalledTimes(1);
  });

  it('hides "Add Food" while selecting — the combine bar replaces it', () => {
    renderCard({
      entries: [entry({ id: 'a' }), entry({ id: 'b' })],
      selecting: true,
      selectedIds: new Set(),
    });
    expect(screen.queryByTestId('food-add-breakfast')).toBeNull();
    expect(screen.getByTestId('meal-breakfast-combine-bar')).toBeTruthy();
  });
});
