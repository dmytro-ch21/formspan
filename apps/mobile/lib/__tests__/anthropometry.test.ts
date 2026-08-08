import {
  GIRTH_INTERVAL_DAYS,
  MIN_TREND_READINGS,
  RATE_TARGETS,
  daysBetween,
  girthsDue,
  judgeRate,
  makingWeightPlan,
  navyBodyFat,
  recompSignal,
  shiftDate,
  trendWeight,
  waistToHeight,
  waistToHip,
  weeklyRate,
  type Measured,
} from '../anthropometry';

/**
 * The arithmetic behind the check-in card.
 *
 * The property most of these defend: **no answer is ever computed from a single
 * weight.** Scale mass swings 1-2kg a day, so a rate taken from two readings
 * reports whatever the water did — including "gaining" in the middle of a
 * working cut. Every test that feeds noisy days and expects a stable answer is
 * pinning that.
 */

const day = (measured_on: string, weight_kg: number | null, over: Partial<Measured> = {}): Measured => ({
  measured_on,
  weight_kg,
  ...over,
});

/** N consecutive days ending at `end`, oldest first. */
const run = (end: string, weights: number[]): Measured[] =>
  weights.map((w, i) => day(shiftDate(end, -(weights.length - 1 - i)), w));

describe('dates', () => {
  it('counts whole days and does not drift across a month', () => {
    expect(daysBetween('2026-08-01', '2026-08-08')).toBe(7);
    expect(daysBetween('2026-07-28', '2026-08-04')).toBe(7);
    expect(daysBetween('2026-08-08', '2026-08-01')).toBe(-7);
  });

  it('shifts in UTC, so it cannot land on the previous day west of Greenwich', () => {
    // The suite runs under TZ=America/Los_Angeles precisely to catch this.
    expect(shiftDate('2026-08-08', -7)).toBe('2026-08-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('trend weight', () => {
  it('averages the window rather than trusting the newest reading', () => {
    // A real week: 82.0 with a 1.4kg swing on it. The newest day says 83.0,
    // which is the number that makes somebody quit a working cut.
    const c = run('2026-08-08', [82.0, 81.6, 82.4, 81.8, 82.2, 81.7, 83.0]);
    const t = trendWeight(c, '2026-08-08');
    expect(t).toBeCloseTo(82.1, 1);
    expect(t).toBeLessThan(83.0);
  });

  it('refuses to call two readings a trend', () => {
    // Two can be two halves of one water swing.
    expect(trendWeight(run('2026-08-08', [82, 81]), '2026-08-08')).toBeNull();
    expect(trendWeight(run('2026-08-08', [82, 81, 82]), '2026-08-08')).not.toBeNull();
    expect(MIN_TREND_READINGS).toBe(3);
  });

  it('is anchored on the DATE, so a gap does not average across it', () => {
    // Three readings from a month ago must not be reported as this week's
    // trend — that is a stale number presented as current.
    const stale = run('2026-07-01', [90, 90, 90]);
    expect(trendWeight(stale, '2026-08-08')).toBeNull();
  });

  it('window is exactly TREND_DAYS, and excludes the day beyond it', () => {
    // Pins `age < TREND_DAYS` against `<=`: without an eighth-day reading that
    // would shift the mean, an off-by-one window survived. Caught by mutation.
    const eight = run('2026-08-08', [70, 82, 82, 82, 82, 82, 82, 82]);
    // The 70 is 7 days back — outside a 7-day window, inside an 8-day one.
    expect(trendWeight(eight, '2026-08-08')).toBeCloseTo(82, 2);
  });

  it('excludes readings dated in the future', () => {
    const c = [
      ...run('2026-08-08', [82, 82, 82]),
      day('2026-08-20', 60),
    ];
    expect(trendWeight(c, '2026-08-08')).toBeCloseTo(82, 2);
  });

  it('ignores days with no weight rather than counting them as zero', () => {
    const c = [
      day('2026-08-06', 82),
      day('2026-08-07', null, { waist_cm: 81 }), // a girth-only check-in
      day('2026-08-08', 82),
      day('2026-08-05', 82),
    ];
    expect(trendWeight(c, '2026-08-08')).toBeCloseTo(82, 2);
  });
});

describe('weekly rate', () => {
  it('is computed between two TRENDS, not two readings', () => {
    // Two weeks, each noisy, trending 82.0 -> 81.2. That is ~0.49%/week down.
    const c = [
      ...run('2026-07-25', [82.3, 81.7, 82.0, 81.9, 82.1]),
      ...run('2026-08-08', [81.4, 81.0, 81.3, 81.1, 81.2]),
    ];
    const r = weeklyRate(c, '2026-08-08', 14);
    expect(r).not.toBeNull();
    expect(r!).toBeLessThan(0);
    expect(Math.abs(r!)).toBeGreaterThan(0.002);
    expect(Math.abs(r!)).toBeLessThan(0.008);
  });

  it('is null when either end has no trend', () => {
    expect(weeklyRate(run('2026-08-08', [82, 82, 82]), '2026-08-08', 14)).toBeNull();
  });

  it('refuses a span too short for the signal to beat the noise', () => {
    // Both ends have a real trend here — this is the SPAN guard, not the trend
    // guard, and without it a three-day "rate" reports whatever the water did.
    // (Caught by mutation: the earlier test passed because the trend was null.)
    // Fourteen days, so BOTH ends have a full window at either span — the
    // difference between them is then only the span guard.
    const c = run('2026-08-08', [
      82.4, 81.8, 82.2, 81.9, 82.3, 81.7, 82.1,
      82.0, 81.9, 82.2, 81.8, 82.1, 81.9, 82.0,
    ]);
    expect(trendWeight(c, '2026-08-08')).not.toBeNull();
    expect(trendWeight(c, shiftDate('2026-08-08', -3))).not.toBeNull();
    expect(trendWeight(c, shiftDate('2026-08-08', -7))).not.toBeNull();
    expect(weeklyRate(c, '2026-08-08', 3)).toBeNull();
    // Seven days apart is enough.
    expect(weeklyRate(c, '2026-08-08', 7)).not.toBeNull();
  });
});

describe('judging a rate against the phase', () => {
  /*
    The sign is the trap, and it is why this lives in one function.

    A cut's rate is NEGATIVE, so "too fast" is BELOW -max and "too slow" is
    ABOVE -min. Written inline at a call site that comparison gets inverted, and
    the card then congratulates somebody who is crash-dieting.
  */
  it('reads a fast cut as too fast, not as excellent', () => {
    expect(judgeRate('cut', -0.02)).toBe('too_fast');
  });

  it('reads a barely-moving cut as too slow', () => {
    expect(judgeRate('cut', -0.001)).toBe('too_slow');
    // Including one going the wrong way entirely.
    expect(judgeRate('cut', +0.01)).toBe('too_slow');
  });

  it('accepts a cut inside the evidence-based band', () => {
    expect(judgeRate('cut', -0.007)).toBe('on_target');
    expect(RATE_TARGETS.cut).toEqual({ min: 0.005, max: 0.01 });
  });

  it('has the opposite sign convention for a bulk', () => {
    expect(judgeRate('lean_bulk', +0.01)).toBe('too_fast');
    expect(judgeRate('lean_bulk', +0.004)).toBe('on_target');
    expect(judgeRate('lean_bulk', -0.004)).toBe('too_slow');
  });

  it('treats drift either way as too fast when the target is flat', () => {
    for (const kind of ['recomposition', 'maintenance'] as const) {
      expect(judgeRate(kind, 0)).toBe('on_target');
      expect(judgeRate(kind, +0.01)).toBe('too_fast');
      expect(judgeRate(kind, -0.01)).toBe('too_fast');
    }
  });

  it('treats the band edges as inside it', () => {
    // Pins `<`/`>` against `<=`/`>=`. A cut at exactly 1%/wk is the ceiling,
    // not over it.
    expect(judgeRate('cut', -0.01)).toBe('on_target');
    expect(judgeRate('cut', -0.005)).toBe('on_target');
    expect(judgeRate('lean_bulk', 0.005)).toBe('on_target');
    expect(judgeRate('lean_bulk', 0.0025)).toBe('on_target');
  });

  it('says unknown rather than guessing when there is no rate yet', () => {
    expect(judgeRate('cut', null)).toBe('unknown');
  });

  it('has no prescribed band for making weight — the deadline sets it', () => {
    expect(judgeRate('making_weight', -0.02)).toBe('no_target');
  });
});

describe('recomposition', () => {
  it('reports working when the waist falls and a limb grows', () => {
    // The case the scale cannot see: weight flat, body changed.
    expect(recompSignal(-1.5, +0.8)).toBe('working');
  });

  it('reports the wrong way when the waist grows and a limb shrinks', () => {
    expect(recompSignal(+1.5, -0.8)).toBe('wrong_way');
  });

  it('calls tape-error-sized movement stalled rather than progress', () => {
    // Half a centimetre is about where self-measurement error stops dominating.
    expect(recompSignal(-0.2, +0.2)).toBe('stalled');
  });

  it('reads one good signal with the other flat as working', () => {
    expect(recompSignal(-1.5, 0)).toBe('working');
    expect(recompSignal(0, +0.8)).toBe('working');
  });

  it('never calls a growing waist or a shrinking limb progress', () => {
    // The first version did both: `waistDown || limbUp` fired on `limbUp`
    // alone, so a growing waist beside a growing limb read as 'working', and a
    // shrinking limb beside a shrinking waist — losing muscle — did too.
    expect(recompSignal(+1.5, +0.8)).toBe('wrong_way');
    expect(recompSignal(-1.5, -0.8)).toBe('wrong_way');
    expect(recompSignal(+1.5, 0)).toBe('wrong_way');
    expect(recompSignal(0, -0.8)).toBe('wrong_way');
  });

  it('says unknown without girths rather than inventing a verdict', () => {
    expect(recompSignal(null, +1)).toBe('unknown');
    expect(recompSignal(-1, null)).toBe('unknown');
  });
});

describe('ratios', () => {
  it('computes waist-to-height around the 0.5 rule of thumb', () => {
    expect(waistToHeight(90, 180)).toBe(0.5);
    expect(waistToHeight(81, 180)).toBe(0.45);
  });

  it('computes waist-to-hip', () => {
    expect(waistToHip(85, 100)).toBe(0.85);
  });

  it('returns null rather than zero or Infinity on missing inputs', () => {
    // Zero would render as a real ratio; Infinity renders as "Infinity".
    expect(waistToHeight(null, 180)).toBeNull();
    expect(waistToHeight(90, null)).toBeNull();
    expect(waistToHeight(90, 0)).toBeNull();
    expect(waistToHip(85, 0)).toBeNull();
  });
});

describe('navy body fat', () => {
  it('estimates a male athlete in a plausible range', () => {
    const pct = navyBodyFat({ sex: 'male', heightCM: 180, neckCM: 39, waistCM: 85 });
    expect(pct).not.toBeNull();
    expect(pct!).toBeGreaterThan(10);
    expect(pct!).toBeLessThan(25);
  });

  it('uses a different formula for women and needs hips for it', () => {
    const withHips = navyBodyFat({
      sex: 'female', heightCM: 168, neckCM: 32, waistCM: 72, hipsCM: 96,
    });
    expect(withHips).not.toBeNull();
    // Without hips the female regression has no input — a number here would
    // mean the male formula had been applied to a woman.
    expect(navyBodyFat({ sex: 'female', heightCM: 168, neckCM: 32, waistCM: 72 })).toBeNull();
  });

  it('refuses to guess when sex is unknown', () => {
    // Defaulting would silently apply the wrong regression and produce a
    // confident wrong number.
    //
    // HIPS ARE SUPPLIED deliberately. Without them this passed for the wrong
    // reason — the female branch returned null for want of a hip measurement
    // rather than because sex was missing, so deleting the `!sex` guard left
    // the test green. Caught by mutation.
    expect(navyBodyFat({
      sex: null, heightCM: 180, neckCM: 39, waistCM: 85, hipsCM: 98,
    })).toBeNull();
    expect(navyBodyFat({
      sex: undefined, heightCM: 180, neckCM: 39, waistCM: 85, hipsCM: 98,
    })).toBeNull();
    // And with a sex, the same inputs DO produce a number — so the null above
    // is the guard talking and not a missing input.
    expect(navyBodyFat({
      sex: 'female', heightCM: 180, neckCM: 39, waistCM: 85, hipsCM: 98,
    })).not.toBeNull();
  });

  it('returns null rather than NaN when the girths are mis-typed', () => {
    // waist <= neck makes log10 of a non-positive number; "NaN%" on screen is
    // worse than nothing.
    expect(navyBodyFat({ sex: 'male', heightCM: 180, neckCM: 90, waistCM: 40 })).toBeNull();
  });

  it('moves down as the waist comes in, which is the part that is reliable', () => {
    const before = navyBodyFat({ sex: 'male', heightCM: 180, neckCM: 39, waistCM: 90 })!;
    const after = navyBodyFat({ sex: 'male', heightCM: 180, neckCM: 39, waistCM: 84 })!;
    expect(after).toBeLessThan(before);
  });
});

describe('making weight', () => {
  it('computes the rate the remaining days actually demand', () => {
    // 84kg, needs 77.1 in 28 days: 6.9kg, ~2.05%/week — well past safe.
    const plan = makingWeightPlan(84, {
      kind: 'making_weight', started_on: '2026-08-01',
      target_on: '2026-09-05', target_weight_kg: 77.1,
    }, '2026-08-08')!;
    expect(plan.daysLeft).toBe(28);
    expect(plan.kilosToGo).toBeCloseTo(6.9, 1);
    expect(plan.requiredWeeklyRate).toBeGreaterThan(0.02);
    expect(plan.safe).toBe(false);
  });

  it('calls a gentle cut to the deadline safe', () => {
    const plan = makingWeightPlan(79, {
      kind: 'making_weight', started_on: '2026-08-01',
      target_on: '2026-09-19', target_weight_kg: 77.1,
    }, '2026-08-08')!;
    expect(plan.safe).toBe(true);
  });

  it('reports made once the athlete is at or under the target', () => {
    const plan = makingWeightPlan(77.0, {
      kind: 'making_weight', started_on: '2026-08-01',
      target_on: '2026-09-05', target_weight_kg: 77.1,
    }, '2026-08-08')!;
    expect(plan.made).toBe(true);
    expect(plan.kilosToGo).toBe(0);
    expect(plan.safe).toBe(true);
  });

  it('does not divide by a deadline that has passed', () => {
    // Infinity is the honest answer for the rate, but `safe` must be false and
    // nothing may produce NaN.
    const plan = makingWeightPlan(80, {
      kind: 'making_weight', started_on: '2026-07-01',
      target_on: '2026-08-01', target_weight_kg: 77,
    }, '2026-08-08')!;
    expect(plan.daysLeft).toBeLessThan(0);
    expect(plan.safe).toBe(false);
    expect(Number.isNaN(plan.requiredWeeklyRate)).toBe(false);
  });

  it('is null without a date or a target, which is why the API demands both', () => {
    expect(makingWeightPlan(80, { kind: 'making_weight', started_on: '2026-08-01' }, '2026-08-08')).toBeNull();
    expect(makingWeightPlan(null, {
      kind: 'making_weight', started_on: '2026-08-01',
      target_on: '2026-09-05', target_weight_kg: 77,
    }, '2026-08-08')).toBeNull();
  });
});

describe('when the girth set is due', () => {
  it('is due when none has ever been taken', () => {
    expect(girthsDue([], '2026-08-08')).toBe(true);
    expect(girthsDue(run('2026-08-08', [82, 82, 82]), '2026-08-08')).toBe(true);
  });

  it('is not due the day after one was taken', () => {
    const c = [day('2026-08-07', 82, { waist_cm: 81 })];
    expect(girthsDue(c, '2026-08-08')).toBe(false);
  });

  it('comes due again a week later, and no sooner', () => {
    const c = [day('2026-08-01', 82, { waist_cm: 81 })];
    expect(girthsDue(c, shiftDate('2026-08-01', GIRTH_INTERVAL_DAYS - 1))).toBe(false);
    expect(girthsDue(c, shiftDate('2026-08-01', GIRTH_INTERVAL_DAYS))).toBe(true);
  });

  it('reads the most recent girth day, not the first one in the list', () => {
    // The RECENT day first: the earlier fixture was already sorted, so `.pop()`
    // gave the right answer with or without the sort inside `girthsDue`.
    // Caught by mutation.
    const c = [
      day('2026-08-07', 82, { waist_cm: 81 }),
      day('2026-07-01', 82, { waist_cm: 84 }),
    ];
    expect(girthsDue(c, '2026-08-08')).toBe(false);
  });
});
