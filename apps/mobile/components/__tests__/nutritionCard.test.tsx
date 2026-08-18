/**
 * The Fuel card's three empty states, and the one colour rule it must not
 * break.
 *
 * A component test rather than a logic one, because these defects live ONLY in
 * the render path: `dayTotals` and `remaining` are already covered in
 * `lib/__tests__/nutrition.test.ts`, and a second opinion about the arithmetic
 * here is how two tests end up disagreeing.
 *
 * What this cannot tell you: whether it looks right. Nothing here measures
 * spacing, contrast or whether the two figures fit side by side on a 4.7"
 * screen — that needs a device, and `L1` already tracks a pile of things
 * typechecked and never looked at.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';

import { NutritionCard } from '../NutritionCard';
import type { Entry, Target } from '@/lib/nutrition';

const target: Target = {
  effective_on: '2026-08-01',
  kcal: 2400,
  protein_g: 180,
  carb_g: 250,
  fat_g: 70,
  fibre_g: 34,
};

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    eaten_on: '2026-08-18',
    meal: 'lunch',
    name: 'Chicken thigh',
    servings: 1,
    serving_label: '100 g',
    kcal: 180,
    protein_g: 25,
    carb_g: 0,
    fat_g: 8,
    fibre_g: null,
    source_food_id: null,
    notes: '',
    ...over,
  };
}

function renderCard(over: Partial<React.ComponentProps<typeof NutritionCard>> = {}) {
  return render(
    <NutritionCard
      entries={[]}
      target={target}
      quickAdd={[]}
      loaded
      onLog={() => {}}
      onOpenDay={() => {}}
      onQuickAdd={() => {}}
      {...over}
    />,
  );
}

describe('the three absent states, which are three different sentences', () => {
  it('not loaded says so, rather than claiming nothing was logged', () => {
    // Asserting "nothing logged yet" while offline is a false claim about the
    // athlete's day — the same distinction CheckinCard makes.
    renderCard({ loaded: false, target: null });
    expect(screen.getByText('Checking…')).toBeTruthy();
  });

  it('no target asks for one rather than inventing a number', () => {
    renderCard({ target: null });
    expect(screen.getByText('Set a target to see what is left')).toBeTruthy();
    // And the figures are dashes, never zeros: zero would read as "you have
    // nothing left", which is the opposite of the truth.
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('—');
  });

  it('a target with nothing logged shows the whole target as remaining', () => {
    renderCard({ entries: [] });
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('2,400');
    expect(screen.getByText('nothing logged yet')).toBeTruthy();
  });
});

describe('remaining, not consumed', () => {
  it('leads with what is left', () => {
    renderCard({ entries: [entry()] });
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('2,220');
    expect(screen.getByTestId('fuel-remaining-protein').props.children).toBe('155 g');
  });

  it('shows eaten once, as context, not as the headline', () => {
    renderCard({ entries: [entry()] });
    expect(screen.getByText('2,400 target · 180 eaten')).toBeTruthy();
  });

  it('says "over" past the target rather than a negative number', () => {
    renderCard({ entries: [entry({ kcal: 2500 })] });
    expect(screen.getByText('kcal over')).toBeTruthy();
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('100');
  });
});

describe('what it does not show', () => {
  it('shows no carbs, fat, fibre or percentage', () => {
    renderCard({ entries: [entry()] });
    // Two numbers answer "what do I eat next". Everything else is a dashboard
    // you admire and do not act on.
    expect(screen.queryByText(/carb/i)).toBeNull();
    expect(screen.queryByText(/fat/i)).toBeNull();
    expect(screen.queryByText(/fibre/i)).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('shows no streak', () => {
    renderCard({ entries: [entry()] });
    expect(screen.queryByText(/streak/i)).toBeNull();
  });
});

describe('quick add', () => {
  const oats = {
    id: 'f1',
    kind: 'food' as const,
    name: 'Porridge',
    brand: '',
    serving_label: '100 g',
    serving_grams: 100,
    kcal: 380,
    protein_g: 13,
    carb_g: 60,
    fat_g: 8,
    fibre_g: 10,
  };

  it('offers the ranked foods as one-tap chips', () => {
    const onQuickAdd = jest.fn();
    renderCard({ quickAdd: [oats], onQuickAdd });
    fireEvent.press(screen.getByTestId('fuel-quick-f1'));
    expect(onQuickAdd).toHaveBeenCalledWith(oats);
  });

  it('renders no chip row at all when there is nothing to offer', () => {
    renderCard({ quickAdd: [] });
    expect(screen.queryByTestId(/fuel-quick-/)).toBeNull();
  });
});

describe('the primary action', () => {
  it('opens the log directly, which is the design doc’s one-tap quick log', () => {
    const onLog = jest.fn();
    renderCard({ onLog });
    fireEvent.press(screen.getByTestId('fuel-log'));
    expect(onLog).toHaveBeenCalled();
  });
});
