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
  rescale,
  remaining,
  scale,
  slotForClock,
  type Entry,
  type Food,
  type Target,
  profileGap,
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

describe('rescale', () => {
  /** An entry as logged: two servings of the 180 kcal food. */
  const logged = () => ({ ...food(), servings: 2, kcal: 360, protein_g: 50, carb_g: 20, fat_g: 8 });

  it('divides back out of the stored absolutes, not out of what is displayed', () => {
    const m = rescale(logged(), 3);
    expect(m.kcal).toBe(540);
    expect(m.protein_g).toBe(75);
  });

  it('treats the stored macros as ABSOLUTE, not as per-serving', () => {
    // The mutation this exists for: dropping the divide reads a two-serving
    // row's 360 kcal as 360 PER serving and doubles the entry the moment the
    // editor opens on it. Rescaling to the count it already has must be
    // identity.
    expect(rescale(logged(), 2).kcal).toBe(360);
    expect(rescale(logged(), 1).kcal).toBe(180);
  });

  it('does not compound its rounding beyond a tenth across a round trip', () => {
    // Deliberately a value that does NOT divide evenly — an exact one passes
    // whatever the arithmetic does. The bound is one rounding step rather than
    // equality: 355 at two servings is 266.3 at 1.5 and returns 355.1. The
    // 0.11 rather than 0.1 is float representation, not slack in the claim.
    const start = { ...logged(), kcal: 355 };
    const down = rescale(start, 1.5);
    const back = rescale({ ...down, servings: 1.5 }, 2);
    expect(Math.abs(back.kcal - 355)).toBeLessThan(0.11);
  });

  it('reads a zero-serving row as one rather than dividing by it', () => {
    const m = rescale({ ...logged(), servings: 0 }, 2);
    expect(Number.isFinite(m.kcal)).toBe(true);
    expect(m.kcal).toBe(720);
  });

  it('keeps unstated fibre unstated', () => {
    expect(rescale(logged(), 4).fibre_g).toBeNull();
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

/*
 * Where "fix this first" sends you.
 *
 * The bug this replaces: the button went to `/profile`, a route the app has
 * never had, so the one action on a screen explaining why it cannot answer led
 * to the not-found screen. **Nothing could have caught it.** Expo Router's
 * typed routes are generated by Metro into a gitignored `.expo/`, so CI's
 * `tsc` sees a loose `Href` and passes; it only surfaced locally, in a worktree
 * that happened to have the generated file.
 *
 * The guard for that class lives in `routes.test.ts`, which checks every
 * navigation literal in the app against the real route tree. This file covers
 * only the RULE — which screen a given set of missing fields should send you
 * to — and deliberately says nothing about routes, so the two cannot drift into
 * disagreeing about the same thing.
 */
describe('profileGap', () => {
  it('says nothing when the target is already derivable', () => {
    // No missing fields means no button; otherwise a screen with a working
    // target still offers to go and fix something.
    expect(profileGap([])).toBeNull();
  });

  it('sends you to the profile for the three fields the profile form edits', () => {
    for (const field of ['height_cm', 'date_of_birth', 'sex']) {
      expect(profileGap([field])).toEqual({ kind: 'profile', label: 'Open profile' });
    }
  });

  it('sends you to a check-in when only the weigh-in is missing', () => {
    // The case that made "just point it at /profile/edit" a half-fix: a weight
    // is not on the profile form, so a complete profile with no weigh-in would
    // have been sent to a screen with nothing on it to fill in. The server
    // returns this alone — `Suggest` appends each of the four independently.
    expect(profileGap(['weight_kg'])).toEqual({
      kind: 'weigh-in',
      label: 'Record a weigh-in',
    });
  });

  it('prefers the profile when both kinds are missing', () => {
    // You have to go there anyway, and the weigh-in is one tap from Today
    // afterwards — the reverse order strands you a second time.
    expect(profileGap(['weight_kg', 'sex'])?.kind).toBe('profile');
  });

  it('offers nothing for a field this build does not know', () => {
    // Server vocabulary can lead the app, and an unknown field has no screen we
    // can honestly send anyone to. Routing it to the check-in — which the first
    // version did — is the same silent mis-send as routing it to the profile:
    // the athlete records a weigh-in, nothing changes, and nothing says why.
    // The screen still names the field; only the button is withheld.
    expect(profileGap(['galaxy_brain_index'])).toBeNull();
  });

  it('still answers when a known field arrives beside an unknown one', () => {
    // The mixed case must not be swallowed by the unknown-field rule.
    expect(profileGap(['galaxy_brain_index', 'sex'])?.kind).toBe('profile');
    expect(profileGap(['galaxy_brain_index', 'weight_kg'])?.kind).toBe('weigh-in');
  });
});
