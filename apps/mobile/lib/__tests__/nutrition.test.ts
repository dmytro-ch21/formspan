/**
 * The arithmetic behind the two numbers on the Fuel card.
 *
 * What is deliberately NOT tested here: anything about rendering, and anything
 * about the outbox. Those are `components/__tests__` and `foodLog.test.ts`
 * respectively, and a second opinion about them in this file is how two tests
 * end up disagreeing about one rule.
 *
 * No test reads a clock. `today` and `at` are always parameters — the suite
 * runs under TZ=America/Los_Angeles precisely so a date bug that renders as the
 * previous day west of Greenwich can fail, and a test that called `new Date()`
 * would be asserting against whatever today happens to be.
 */

import {
  ATWATER_TOLERANCE,
  atwater,
  bySlot,
  dayTotals,
  daysBetween,
  kcalLooksOff,
  MEALS,
  rankRecents,
  remaining,
  scale,
  slotForClock,
  type Entry,
  type Food,
  type Target,
} from '../nutrition';

const TODAY = '2026-08-18';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    eaten_on: TODAY,
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

function food(over: Partial<Food> = {}): Food {
  return {
    id: 'f1',
    kind: 'food',
    name: 'Chicken thigh',
    brand: '',
    serving_label: '100 g',
    serving_grams: 100,
    kcal: 180,
    protein_g: 25,
    carb_g: 0,
    fat_g: 8,
    fibre_g: null,
    ...over,
  };
}

const target: Target = {
  effective_on: '2026-08-01',
  kcal: 2400,
  protein_g: 180,
  carb_g: 250,
  fat_g: 70,
  fibre_g: 34,
};

describe('dayTotals', () => {
  it('sums a day', () => {
    const t = dayTotals([entry(), entry({ id: 'e2', kcal: 300, protein_g: 10 })]);
    expect(t.kcal).toBe(480);
    expect(t.protein_g).toBe(35);
  });

  it('reports fibre as null when nothing stated it, rather than zero', () => {
    // A day nobody recorded fibre for is not a zero-fibre day, and averaging
    // unstated as zero drags every fibre figure down.
    expect(dayTotals([entry(), entry({ id: 'e2' })]).fibre_g).toBeNull();
  });

  it('sums fibre once anything states it', () => {
    expect(dayTotals([entry({ fibre_g: 3 }), entry({ id: 'e2' })]).fibre_g).toBe(3);
  });

  it('an empty day is zero, not null', () => {
    expect(dayTotals([]).kcal).toBe(0);
  });
});

describe('remaining', () => {
  it('is what is left, not what was eaten', () => {
    const r = remaining(dayTotals([entry()]), target)!;
    expect(r.kcal).toBe(2220);
    expect(r.protein_g).toBe(155);
  });

  it('goes negative past the target rather than clamping', () => {
    // "240 over" is the honest figure. Clamping at zero would say "you have
    // nothing left" on a day 800 over, which is a different and softer claim.
    const r = remaining(dayTotals([entry({ kcal: 2500 })]), target)!;
    expect(r.kcal).toBe(-100);
    expect(r.over).toBe(true);
  });

  it('is null with no target, never zero', () => {
    // Logging without a target is a legitimate state — eaten totals, no
    // remaining. Zero would read as "you have nothing left", the opposite of
    // the truth, and it is what gates the feature behind homework.
    expect(remaining(dayTotals([entry()]), null)).toBeNull();
  });

  it('a full target with nothing logged is the whole target', () => {
    expect(remaining(dayTotals([]), target)!.kcal).toBe(2400);
  });
});

/**
 * THE INVARIANT THIS FEATURE'S POSTURE RESTS ON.
 *
 * Training does not give calories back. It is already inside the derived
 * target, and a budget that moved with yesterday's session would make the
 * observed weekly rate unreadable — you could no longer tell a bad week of
 * eating from a moved goalpost.
 *
 * There is no session parameter anywhere in this module, which is the real
 * guarantee; this test exists because adding one is a one-line change at any
 * point and nothing else in the suite would notice.
 */
describe('training is stated, not spent', () => {
  it('remaining depends only on what was eaten and the target', () => {
    const totals = dayTotals([entry()]);
    const before = remaining(totals, target)!;

    // Whatever a session cost, it reaches this calculation through no argument.
    // If a future signature takes one, this test stops compiling — which is the
    // point at which somebody has to justify it.
    const after = remaining(totals, target)!;

    expect(after).toEqual(before);
    expect(remaining.length).toBe(2);
  });
});

describe('slotForClock', () => {
  it.each([
    [6, 'breakfast'],
    [10, 'breakfast'],
    [11, 'lunch'],
    [14, 'lunch'],
    [15, 'dinner'],
    [20, 'dinner'],
    [21, 'snack'],
    [23, 'snack'],
    [0, 'breakfast'],
  ])('%i:00 is %s', (hour, want) => {
    expect(slotForClock(new Date(2026, 7, 18, hour as number))).toBe(want);
  });
});

describe('bySlot', () => {
  it('returns every slot in day order, including empty ones', () => {
    const groups = bySlot([entry({ meal: 'dinner' })]);
    expect(groups.map((g) => g.meal)).toEqual([...MEALS]);
    expect(groups.find((g) => g.meal === 'dinner')!.entries).toHaveLength(1);
    expect(groups.find((g) => g.meal === 'breakfast')!.entries).toHaveLength(0);
  });

  it('is day order, not alphabetical', () => {
    // Sorted, these become breakfast, dinner, lunch, snack — which reads as a
    // bug to every athlete who sees it.
    expect(bySlot([]).map((g) => g.meal)).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
  });

  it('totals each slot', () => {
    const groups = bySlot([entry(), entry({ id: 'e2', kcal: 20 })]);
    expect(groups.find((g) => g.meal === 'lunch')!.kcal).toBe(200);
  });
});

describe('atwater', () => {
  it('is a hint, never a correction', () => {
    expect(atwater({ protein_g: 25, carb_g: 0, fat_g: 8 })).toBe(172);
  });

  it('does not flag an ordinary label rounding difference', () => {
    // Real labels sit a few percent off the 4/4/9 sum. Flagging every one of
    // them teaches people to ignore the flag that matters.
    expect(kcalLooksOff(180, { protein_g: 25, carb_g: 0, fat_g: 8 })).toBe(false);
  });

  it('flags a figure that cannot be rounding', () => {
    expect(kcalLooksOff(400, { protein_g: 25, carb_g: 0, fat_g: 8 })).toBe(true);
  });

  it('says nothing when there is nothing to compare', () => {
    expect(kcalLooksOff(0, { protein_g: 0, carb_g: 0, fat_g: 0 })).toBe(false);
  });

  it('the tolerance is a fraction, not a percentage', () => {
    // 0.1 meaning 10%. Stored as 10 it would never fire.
    expect(ATWATER_TOLERANCE).toBeLessThan(1);
  });
});

describe('rankRecents', () => {
  const porridge = food({ id: 'p', name: 'Porridge' });
  const chicken = food({ id: 'c', name: 'Chicken thigh' });
  const rare = food({ id: 'r', name: 'Rare thing' });

  it('puts the frequent, recent food first', () => {
    const got = rankRecents(
      [
        { food: rare, uses: 1, lastUsedOn: TODAY },
        { food: porridge, uses: 20, lastUsedOn: TODAY },
      ],
      TODAY,
    );
    expect(got[0].id).toBe('p');
  });

  it('a staple eaten daily but not today still outranks a one-off eaten today', () => {
    // Recency alone loses the staple; this is the half that frequency supplies.
    const got = rankRecents(
      [
        { food: rare, uses: 1, lastUsedOn: TODAY },
        { food: porridge, uses: 30, lastUsedOn: '2026-08-14' },
      ],
      TODAY,
    );
    expect(got[0].id).toBe('p');
  });

  it('a stale food ranks below a current one of equal frequency', () => {
    // Frequency alone pins whatever somebody ate in their first fortnight to
    // the top forever; this is the half that recency supplies.
    const got = rankRecents(
      [
        { food: chicken, uses: 10, lastUsedOn: '2026-05-01' },
        { food: porridge, uses: 10, lastUsedOn: TODAY },
      ],
      TODAY,
    );
    expect(got[0].id).toBe('p');
  });

  it('never returns a food that was never used', () => {
    expect(rankRecents([{ food: rare, uses: 0, lastUsedOn: null }], TODAY)).toEqual([]);
  });

  it('caps the list, because the first three rows are the whole feature', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      food: food({ id: String(i), name: `F${i}` }),
      uses: 10 - i,
      lastUsedOn: TODAY,
    }));
    expect(rankRecents(many, TODAY)).toHaveLength(3);
  });

  it('breaks ties by name so the order cannot flicker between renders', () => {
    const a = food({ id: 'a', name: 'Apple' });
    const b = food({ id: 'b', name: 'Banana' });
    const got = rankRecents(
      [
        { food: b, uses: 5, lastUsedOn: TODAY },
        { food: a, uses: 5, lastUsedOn: TODAY },
      ],
      TODAY,
    );
    expect(got.map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-08-01', '2026-08-18')).toBe(17);
  });

  it('is negative backwards', () => {
    expect(daysBetween('2026-08-18', '2026-08-01')).toBe(-17);
  });

  it('crosses a DST boundary without losing a day', () => {
    // US DST ends 2026-11-01. Computed in local time this straddle comes back
    // as 0.958 of a day and rounds wrong; both sides are UTC for that reason.
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1);
  });
});

describe('scale', () => {
  it('multiplies on the client, because the server never does', () => {
    const m = scale(food(), 1.5);
    expect(m.kcal).toBe(270);
    expect(m.protein_g).toBe(37.5);
  });

  it('keeps unstated fibre unstated rather than scaling a zero into existence', () => {
    expect(scale(food(), 2).fibre_g).toBeNull();
    expect(scale(food({ fibre_g: 3 }), 2).fibre_g).toBe(6);
  });
});
