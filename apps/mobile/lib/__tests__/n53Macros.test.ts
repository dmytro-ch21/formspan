import {
  daysLogged,
  macroSplit,
  mealBudgetLine,
  type EatenView,
  type Macros,
  type Target,
  type TargetView,
} from '../nutrition';

/**
 * The two pieces of N53 that are arithmetic rather than layout.
 *
 * Both exist as counter-proposals to something `nutrition-design.md` §5
 * explicitly rejected, so the tests are as much about what they must NOT do as
 * about what they compute:
 *
 *  - `macroSplit` answers the user's macro-ring ask **without** becoming the
 *    six stacked cards the doc calls the dashboard graveyard.
 *  - `daysLogged` answers their streak ask **without** a chain that can be
 *    lost, which is the thing the no-shame rule refuses.
 */

const target: Target = {
  effective_on: '2026-08-19',
  kcal: 2400,
  // The exact numbers from the user's reference screenshot, so the shape the
  // row renders is the shape they asked for.
  protein_g: 141,
  carb_g: 238,
  fat_g: 63,
  fibre_g: 30,
};

const totals: Macros = {
  kcal: 900,
  protein_g: 60,
  carb_g: 100,
  fat_g: 30,
  fibre_g: null,
  saturated_fat_g: null,
  sugar_g: null,
  added_sugar_g: null,
  sodium_mg: null,
  cholesterol_mg: null,
};

describe('the macro split', () => {
  it('is three macros in the order a label lists them', () => {
    expect(macroSplit(totals, target).map((m) => m.key)).toEqual(['protein_g', 'carb_g', 'fat_g']);
  });

  it('pairs each with its goal, which is the shape the user asked for', () => {
    const [p, c, f] = macroSplit(totals, target);
    expect([p.eaten, p.goal]).toEqual([60, 141]);
    expect([c.eaten, c.goal]).toEqual([100, 238]);
    expect([f.eaten, f.goal]).toEqual([30, 63]);
  });

  it('has a NULL goal with no target, never a zero one', () => {
    // "12 / 0g" reads as being over a limit nobody set. Same refusal
    // `viewTotals` makes one level up, for the same reason.
    for (const m of macroSplit(totals, null)) expect(m.goal).toBeNull();
  });

  it('reports zero eaten when nothing is loaded, and no goal', () => {
    for (const m of macroSplit(null, null)) {
      expect(m.eaten).toBe(0);
      expect(m.goal).toBeNull();
    }
  });

  it('does NOT include calories', () => {
    // `RemainingBlock` already leads with them; repeating them here is the
    // stacking the design doc refuses.
    expect(macroSplit(totals, target).map((m) => m.key)).not.toContain('kcal');
  });

  it('stays at three even though N52 landed five more macros', () => {
    // Saturated fat, sugar, sodium, added sugar and cholesterol now exist on
    // the entry. They are label detail for one food, not a daily split — and
    // adding them is exactly how three figures becomes the six stacked cards
    // `nutrition-design.md` §5 rejects.
    expect(macroSplit(totals, target)).toHaveLength(3);
  });
});

describe('days logged — a count, not a streak', () => {
  it('counts days with entries inside the window', () => {
    expect(daysLogged(['2026-08-19', '2026-08-18', '2026-08-16'], '2026-08-19', 7)).toEqual({
      logged: 3,
      considered: 7,
    });
  });

  it('carries its denominator, so 5 is never shown without of 7', () => {
    expect(daysLogged(['2026-08-19'], '2026-08-19', 7).considered).toBe(7);
  });

  it('CANNOT be broken by a gap, which is the whole difference from a streak', () => {
    // A chain of 3 with a gap in the middle is a streak of 1 and a count of 3.
    // A streak rewards logging a fake day to save it; a count has nothing to
    // save, which is what makes it survive the no-shame rule.
    const withGap = daysLogged(['2026-08-19', '2026-08-17', '2026-08-15'], '2026-08-19', 7);
    expect(withGap.logged).toBe(3);
  });

  it('ignores days outside the window rather than inflating the count', () => {
    expect(daysLogged(['2026-08-01', '2026-08-19'], '2026-08-19', 7).logged).toBe(1);
  });

  it('ignores future days', () => {
    expect(daysLogged(['2026-08-25'], '2026-08-19', 7).logged).toBe(0);
  });

  it('counts a day once however many entries it has', () => {
    expect(daysLogged(['2026-08-19', '2026-08-19', '2026-08-19'], '2026-08-19', 7).logged).toBe(1);
  });

  it('is zero of seven when nothing is logged, not an empty answer', () => {
    // Zero logged days is a real and honest answer — unlike a zero TOTAL,
    // which claims somebody ate nothing. The denominator is what keeps it
    // readable as "you have not logged this week" rather than as a failure.
    expect(daysLogged([], '2026-08-19', 7)).toEqual({ logged: 0, considered: 7 });
  });

  it('crosses a month boundary', () => {
    expect(daysLogged(['2026-08-01', '2026-07-31', '2026-07-30'], '2026-08-01', 7).logged).toBe(3);
  });
});

/**
 * The meal-section line — the REAL function this time.
 *
 * The first version of this block was three tautologies. `mealBudgetLine` lived
 * in `food.tsx` and was not exported, so the tests re-declared a local `left`
 * lambda and asserted on hand-written literals: "never divides the target
 * between meals" was `expect(1500).not.toBe(600)`. Deleting the shipped
 * function, or changing it to divide by four, left all three green — and the
 * commit message counted them among its test total.
 *
 * That is the exact failure this suite was founded on ("every assertion here
 * should fail when the code it covers is deleted"), and it is why the function
 * moved into `lib/`: a rule inside a component is a rule no test can reach.
 * Found in review.
 */
describe('the meal-section line is the DAY’s remaining, not a per-meal budget', () => {
  const view: TargetView = { state: 'set', target };
  const ready = (m: Partial<Macros> = {}): EatenView => ({
    state: 'ready',
    rows: [],
    totals: { ...totals, ...m },
  });

  it('subtracts the whole day from the whole target', () => {
    expect(mealBudgetLine(ready(), view)).toBe(
      '1500 kcal left today · 81g protein · 138g carbs · 33g fat',
    );
  });

  it('never divides the target between meals', () => {
    // The failure the design doc names: 2400 / 4 = 600 per meal is a number the
    // app invented, and each of the four is wrong the moment one meal is bigger
    // than a quarter of the day. Asserted against the SHIPPED string, so
    // changing the function to divide turns this red.
    const line = mealBudgetLine(ready(), view);
    expect(line).toContain('1500 kcal');
    expect(line).not.toContain('600 kcal');
  });

  it('floors at zero rather than showing a negative "left"', () => {
    expect(mealBudgetLine(ready({ kcal: 2540, protein_g: 200 }), view)).toBe(
      '0 kcal left today · 0g protein · 138g carbs · 33g fat',
    );
  });

  it('is NULL with no target, not a line with no denominator', () => {
    expect(mealBudgetLine(ready(), { state: 'none' })).toBeNull();
    expect(mealBudgetLine(ready(), { state: 'unknown' })).toBeNull();
    expect(mealBudgetLine(ready(), { state: 'checking' })).toBeNull();
  });

  it('is NULL when the day has not been read, not a line from the target alone', () => {
    // The half-an-answer case. Without the eaten half this would print the
    // whole target as "left", which is a confident claim from a read that
    // never happened.
    expect(mealBudgetLine({ state: 'loading' }, view)).toBeNull();
    expect(mealBudgetLine({ state: 'unavailable' }, view)).toBeNull();
  });

  it('says "left today", which the caller only renders on today', () => {
    // The words are load-bearing: the Food screen has a day stepper, and this
    // sentence is false on any other day. `food.tsx` gates on `isToday`; this
    // pins the wording that gate exists for.
    expect(mealBudgetLine(ready(), view)).toContain('left today');
  });

  it('carries exactly the four macros, not N52’s five new ones', () => {
    const line = mealBudgetLine(ready(), view) ?? '';
    expect(line).toContain('protein');
    expect(line).toContain('carbs');
    expect(line).toContain('fat');
    for (const later of ['sodium', 'sugar', 'saturated', 'cholesterol', 'fibre']) {
      expect(line).not.toContain(later);
    }
  });
});
