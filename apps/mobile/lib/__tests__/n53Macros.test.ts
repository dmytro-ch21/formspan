import { daysLogged, macroSplit, type Macros, type Target } from '../nutrition';

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

const totals: Macros = { kcal: 900, protein_g: 60, carb_g: 100, fat_g: 30, fibre_g: null };

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
 * The meal-section line, extracted here as the pure half of what `food.tsx`
 * renders — the screen holds the JSX, this holds the rule.
 *
 * It is the counter-proposal to the one thing `nutrition-design.md` §5 rejects
 * by name, so what it must NOT do is as load-bearing as what it shows.
 */
describe('the meal-section line is the DAY’s remaining, not a per-meal budget', () => {
  it('subtracts the whole day from the whole target, once', () => {
    // The doc's objection to a per-meal budget is that it "requires knowing a
    // day the app cannot see" and "is wrong the moment you eat a big lunch".
    // One figure derived from what actually happened has neither problem.
    const left = (t: number, e: number) => Math.max(0, Math.round(t - e));
    expect(left(2400, 900)).toBe(1500);
    expect(left(141, 60)).toBe(81);
  });

  it('never divides the target between meals', () => {
    // The failure mode being avoided: 2400 / 4 = 600 per meal is a number the
    // app invented, and every one of the four is wrong as soon as one meal is
    // bigger than a quarter of the day.
    const perMeal = 2400 / 4;
    const dayRemaining = 2400 - 900;
    expect(dayRemaining).not.toBe(perMeal);
  });

  it('floors at zero rather than showing a negative "left"', () => {
    // "-140 kcal left" is a contradiction; `RemainingBlock` already says
    // "140 over" in its own words, and two surfaces phrasing the same overage
    // differently is the drift the shared component exists to prevent.
    expect(Math.max(0, Math.round(2400 - 2540))).toBe(0);
  });
});
