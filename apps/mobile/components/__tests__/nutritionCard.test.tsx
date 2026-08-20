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
import { eatenFrom, type Entry, type Target } from '@/lib/nutrition';

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
      eaten={eatenFrom([])}
      logged={null}
      view={{ state: 'set', target }}
      quickAdd={[]}
      onLog={() => {}}
      onOpenDay={() => {}}
      onQuickAdd={() => {}}
      {...over}
    />,
  );
}

describe('the four absent states, which are four different sentences', () => {
  it('not loaded says so, rather than claiming nothing was logged', () => {
    // Asserting "nothing logged yet" while offline is a false claim about the
    // athlete's day — the same distinction CheckinCard makes.
    renderCard({ view: { state: 'checking' } });
    expect(screen.getByText('Checking your target…')).toBeTruthy();
  });

  it('an unreachable target is NOT reported as no target', () => {
    // The pair that matters. "Set a target" is an instruction to go and do
    // homework; saying it to somebody who set one on web because this phone is
    // in a basement is the app being wrong rather than uninformed.
    renderCard({ view: { state: 'unknown' } });
    expect(screen.queryByText('Set a target to see what is left')).toBeNull();
    expect(screen.getByText('Cannot check your target from here — logging still works')).toBeTruthy();
  });

  it('no target asks for one rather than inventing a number', () => {
    renderCard({ view: { state: 'none' } });
    expect(screen.getByText('Set a target to see what is left')).toBeTruthy();
    // And the figures are dashes, never zeros: zero would read as "you have
    // nothing left", which is the opposite of the truth.
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('—');
  });

  it('a target with nothing logged shows the whole target as remaining', () => {
    renderCard({ eaten: eatenFrom([]) });
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('2,400');
    expect(screen.getByText('nothing logged yet')).toBeTruthy();
  });
});

describe('the day total, which is what N54 reported missing', () => {
  it('shows what was eaten even with NO target', () => {
    // The reported bug, exactly. The eaten figure used to live only in the
    // caption of the has-a-target branch, so an athlete who had not set one saw
    // per-meal subtotals and no day total anywhere — the number they said did
    // not add up was simply never drawn. What you ate does not depend on
    // whether you have a goal.
    renderCard({ eaten: eatenFrom([entry()]), view: { state: 'none' } });
    expect(screen.getByText('180 eaten · 1 entry')).toBeTruthy();
  });

  it('shows what was eaten when the target could not be checked', () => {
    renderCard({ eaten: eatenFrom([entry()]), view: { state: 'unknown' } });
    expect(screen.getByText('180 eaten · 1 entry')).toBeTruthy();
  });

  it('shows what was eaten while the target is still loading', () => {
    renderCard({ eaten: eatenFrom([entry()]), view: { state: 'checking' } });
    expect(screen.getByText('180 eaten · 1 entry')).toBeTruthy();
  });

  it('labels the total with how many entries it came from', () => {
    // N28's honesty rule, which applies to a total exactly as to an average.
    renderCard({ eaten: eatenFrom([entry(), entry()]) });
    expect(screen.getByText('360 eaten · 2 entries')).toBeTruthy();
  });
});

describe('a failed read is not a day nobody ate on', () => {
  it('says it could not read, rather than claiming nothing was logged', () => {
    // The N28 failure on the phone: an empty list means BOTH "nothing logged"
    // and "the read failed", and the screen used to render the second as the
    // first. `.catch(() => {})` in both callers is what produced it.
    renderCard({ eaten: { state: 'unavailable' } });
    expect(screen.queryByText('nothing logged yet')).toBeNull();
    expect(screen.getByText('Could not read today’s food from this device')).toBeTruthy();
  });

  it('shows dashes, not zeros, when the read failed', () => {
    // A zero here reads as "you have your whole target left", which is a
    // confident claim built on a read that never happened.
    renderCard({ eaten: { state: 'unavailable' } });
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('—');
  });

  it('does not claim nothing was logged while still loading', () => {
    renderCard({ eaten: { state: 'loading' } });
    expect(screen.queryByText('nothing logged yet')).toBeNull();
    expect(screen.getByText('Loading your day…')).toBeTruthy();
  });

  it('a genuine zero is still reported as a zero', () => {
    // The case that must NOT be swept up by the two above: an athlete who has
    // logged nothing has logged nothing, and saying so is correct.
    renderCard({ eaten: eatenFrom([]) });
    expect(screen.getByText('nothing logged yet')).toBeTruthy();
  });
});

describe('remaining, not consumed', () => {
  it('leads with what is left', () => {
    renderCard({ eaten: eatenFrom([entry()]) });
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('2,220');
    expect(screen.getByTestId('fuel-remaining-protein').props.children).toBe('155 g');
  });

  it('shows eaten once, as context, not as the headline', () => {
    renderCard({ eaten: eatenFrom([entry()]) });
    expect(screen.getByText('2,400 target')).toBeTruthy();
    expect(screen.getByText('180 eaten · 1 entry')).toBeTruthy();
  });

  it('says "over" past the target rather than a negative number', () => {
    renderCard({ eaten: eatenFrom([entry({ kcal: 2500 })]) });
    expect(screen.getByText('kcal over')).toBeTruthy();
    expect(screen.getByTestId('fuel-remaining-kcal').props.children).toBe('100');
  });
});

describe('what it does not show', () => {
  /**
   * **This assertion changed in N53, and the change was a decision rather than
   * a repair.**
   *
   * It used to be "shows no carbs, fat, fibre or percentage", on the ground
   * that two numbers answer "what do I eat next" and everything else is a
   * dashboard you admire and do not act on. The user then asked directly for a
   * macro split, with a reference screenshot. That ask was put to them
   * alongside `nutrition-design.md` §5's rejection of "six stacked
   * ring-and-bar cards", and they chose the counter-proposal: the three macros,
   * on ONE row, rather than the stack.
   *
   * So the boundary moved, and this test now guards where it moved TO. Deleting
   * it would have thrown away the guard along with the old position — and the
   * thing being guarded (no dashboard) was never the thing that changed.
   */
  it('shows the three macros on one row, and refuses the dashboard beyond them', () => {
    renderCard({ eaten: eatenFrom([entry()]) });

    // The approved split: three macros, each against its goal.
    expect(screen.getByTestId('macro-protein_g')).toBeTruthy();
    expect(screen.getByTestId('macro-carb_g')).toBeTruthy();
    expect(screen.getByTestId('macro-fat_g')).toBeTruthy();

    // And nothing beyond them. N52 landed saturated fat, sugar, sodium, added
    // sugar and cholesterol on the entry; putting those here is exactly how
    // three figures becomes the six stacked cards the doc refuses, and it is
    // the likeliest next edit now that the data exists.
    expect(screen.queryByText(/fibre/i)).toBeNull();
    expect(screen.queryByText(/sodium/i)).toBeNull();
    expect(screen.queryByText(/sugar/i)).toBeNull();
    expect(screen.queryByText(/saturated/i)).toBeNull();
    expect(screen.queryByText(/cholesterol/i)).toBeNull();

    // Still no percentages: a percentage of a goal invites optimising the
    // number rather than the eating.
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('shows a macro goal only when there is a target', () => {
    renderCard({ eaten: eatenFrom([entry()]), view: { state: 'none' } });
    // `60 / 0g` reads as being over a limit nobody set.
    expect(screen.queryByText(/\/ 0g/)).toBeNull();
  });

  it('says nothing about the week until the count has been read', () => {
    // Null, not zero. "0 of 7 days logged" from a query that has not run is a
    // claim about the athlete's week — and a discouraging one, which is the
    // shape the no-shame rule exists to avoid.
    renderCard({ logged: null });
    expect(screen.queryByTestId('fuel-days-logged')).toBeNull();
  });

  it('labels the logged-day count with its denominator', () => {
    renderCard({ logged: { logged: 5, considered: 7 } });
    expect(screen.getByText('5 of 7 days logged this week')).toBeTruthy();
  });

  it('shows no streak', () => {
    renderCard({ eaten: eatenFrom([entry()]) });
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
