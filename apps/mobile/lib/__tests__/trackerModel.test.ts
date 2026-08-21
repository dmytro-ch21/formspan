import {
  MAX_GLYPHS,
  addLabel,
  amountLine,
  footLine,
  formatClock,
  glyphHint,
  glyphLabel,
  glyphSlots,
  glyphState,
  lastLoggedAt,
  loggedAmount,
  loggedCount,
  progress,
  resolveRenderStyle,
  targetCount,
  suggestedNoun,
  unitNoun,
  valueLine,
  type Tracker,
  type TrackerEntry,
} from '../trackerModel';

/**
 * The tracker model, and specifically the parts a SECOND tracker depends on.
 *
 * Most of this file is deliberately not about water. N77 (coffee: a count with
 * no ceiling, and the time of the last cup) and N78 (creatine: one dose, and a
 * thirty-capsule tracker that must not render thirty glyphs) are both expressed
 * here as records rather than as code — and if either of those needs a change
 * to `trackerModel.ts`, the model did not generalise and that is the finding.
 */

/**
 * **`render_style: 'glyphs'`, matching `presets.go`, and that is a FIX.**
 *
 * It said `'auto'` and the seeded preset ships `'glyphs'` — so the assertion
 * that a fifteen-glass day renders as a bar passed against a record no athlete
 * has (F22, #516). Green, covered, and covering something that does not ship.
 * `resolveRenderStyle` now applies the countability cap to a stored style too,
 * so the two agree; this fixture is what stops them silently diverging again.
 */
const water: Tracker = {
  id: 't_water', preset: 'water', name: 'Water', icon: '💧', color_key: 'water',
  unit: 'ml', increment: 250, target: 2000, render_style: 'glyphs', sort_order: 10,
  count_noun: 'cup',
};

/** N77's shape, today, with no coffee tracker anywhere in the app. */
const coffee: Tracker = {
  id: 't_coffee', preset: 'coffee', name: 'Coffee', icon: '☕', color_key: 'coffee',
  unit: 'cup', increment: 1, target: null, render_style: 'auto', sort_order: 20,
  count_noun: 'cup',
};

/**
 * The same coffee, with a limit set — N77's step 2.
 *
 * There is no second column for this. A ceiling and a goal are one `target`
 * read two ways, so this fixture differs from `coffee` by one number and from
 * `water` by its unit, and everything the card says about it has to be true
 * under both readings.
 */
const ceiling: Tracker = { ...coffee, name: 'Coffee', target: 3 };

/** N78's motivating example: 5 g, once a day. */
const creatine: Tracker = {
  id: 't_creatine', preset: '', name: 'Creatine', icon: '🥄', color_key: 'water',
  unit: 'g', increment: 5, target: 5, render_style: 'auto', sort_order: 30,
  count_noun: 'dose',
};

/** N78's other example: the one that must never be a row of glyphs. */
const capsules: Tracker = {
  id: 't_caps', preset: '', name: 'Capsules', icon: '💊', color_key: 'coffee',
  unit: 'dose', increment: 1, target: 30, render_style: 'auto', sort_order: 40,
  count_noun: 'capsule',
};

let seq = 0;
function taps(t: Tracker, n: number, at = '2026-08-20T08:00:00.000Z'): TrackerEntry[] {
  return Array.from({ length: n }, () => ({
    id: `e${++seq}`,
    tracker_id: t.id,
    logged_on: '2026-08-20',
    logged_at: at,
    amount: t.increment,
  }));
}

describe('the target, as a number of taps', () => {
  it('divides the target by the increment', () => {
    expect(targetCount(water)).toBe(8);
    expect(targetCount(creatine)).toBe(1);
    expect(targetCount(capsules)).toBe(30);
  });

  it('rounds UP, because a short day is not a met target', () => {
    // 2000 ml at 300 ml a glass is seven glasses; six leaves you 200 short of
    // the thing you said you wanted.
    expect(targetCount({ ...water, increment: 300 })).toBe(7);
  });

  it('is null when there is no target, never zero', () => {
    // The distinction N77 is built on. A zero here renders as "0 of 0" at an
    // athlete who asked for no ceiling.
    expect(targetCount(coffee)).toBeNull();
  });
});

describe('the render style, chosen from the record', () => {
  it('is a glyph row for a target that fits', () => {
    expect(resolveRenderStyle(water, 0)).toBe('glyphs');
    expect(resolveRenderStyle(water, 4)).toBe('glyphs');
  });

  it('is one large glyph when the target is a single tap', () => {
    // N78's creatine case, and it falls out of the numbers rather than out of a
    // special case for creatine.
    expect(resolveRenderStyle(creatine, 0)).toBe('dose');
  });

  it('is a bar past twelve, so thirty doses never become thirty glyphs', () => {
    expect(resolveRenderStyle(capsules, 0)).toBe('bar');
    expect(glyphSlots(capsules, 0)).toBeGreaterThan(MAX_GLYPHS);
  });

  it('becomes a bar when what was LOGGED would overflow the row', () => {
    // The half a definition cannot answer: an eight-cup target is a glyph row,
    // and an athlete who logs fifteen must not be handed an uncountable block.
    expect(resolveRenderStyle(water, 8)).toBe('glyphs');
    expect(resolveRenderStyle(water, MAX_GLYPHS)).toBe('glyphs');
    expect(resolveRenderStyle(water, MAX_GLYPHS + 1)).toBe('bar');
  });

  it('an explicit style is honoured wherever it is readable', () => {
    // The athlete's override is a decision, not a hint. N78 offers it, and
    // everything that does not lie about the day is theirs to pick.
    expect(resolveRenderStyle({ ...water, render_style: 'bar' }, 0)).toBe('bar');
    expect(resolveRenderStyle({ ...creatine, render_style: 'glyphs' }, 0)).toBe('glyphs');
    expect(resolveRenderStyle({ ...creatine, render_style: 'dose' }, 0)).toBe('dose');
  });

  /*
   * **The cap outranks the override**, and this test is the decision F22 (#516)
   * asked somebody to make.
   *
   * The first case is not hypothetical: the seeded WATER preset ships
   * `render_style: 'glyphs'`, so before this every athlete's real row took the
   * "explicit style wins" early return and a fifteen-glass day drew fifteen
   * identical glyphs — the uncountable block MAX_GLYPHS exists to prevent, on
   * the one tracker everybody has. The old fixture said `'auto'`, so the suite
   * agreed with itself and not with the app.
   *
   * The vectors are chosen to separate "the cap wins" from "auto wins": each
   * one has an EXPLICIT style that a correct implementation must override.
   */
  it('yields to the countability cap, even when the athlete chose glyphs', () => {
    // The shipped water record, past the cap. This is #516.
    expect(water.render_style).toBe('glyphs'); // guards the fixture, not the code
    expect(resolveRenderStyle(water, MAX_GLYPHS + 3)).toBe('bar');
    // A thirty-capsule tracker whose owner asked for glyphs. The ticket's words:
    // "a 30-dose tracker never renders 30 glyphs".
    expect(resolveRenderStyle({ ...capsules, render_style: 'glyphs' }, 0)).toBe('bar');
    // And below the cap the same override IS honoured, so the rule is a ceiling
    // rather than a blanket refusal.
    expect(resolveRenderStyle({ ...capsules, render_style: 'glyphs', target: 6 }, 0))
      .toBe('glyphs');
  });

  /*
   * A single dose glyph SAYS "taken". It may only be drawn when one tap really
   * is the whole day, or the card reports a thirty-capsule course finished
   * after the first capsule — which is a wrong number, not a style.
   */
  it('refuses a single dose glyph for a tracker that is not one dose', () => {
    expect(resolveRenderStyle({ ...capsules, render_style: 'dose' }, 0)).toBe('bar');
    expect(resolveRenderStyle({ ...capsules, render_style: 'dose', target: 4 }, 0))
      .toBe('glyphs');
    // No target at all is not one dose either — it is a count with no ceiling.
    expect(resolveRenderStyle({ ...coffee, render_style: 'dose' }, 3)).toBe('glyphs');
    // The genuine single-dose case still gets its big glyph.
    expect(resolveRenderStyle({ ...creatine, render_style: 'dose' }, 0)).toBe('dose');
  });

  it('a count with no target still draws a row that grows', () => {
    expect(resolveRenderStyle(coffee, 0)).toBe('glyphs');
    expect(glyphSlots(coffee, 0)).toBe(1);
    expect(glyphSlots(coffee, 3)).toBe(3);
  });
});

describe('crossing the target is not an end state', () => {
  it('draws every logged tap, not just the ones up to the target', () => {
    // Stopping at eight would tell the athlete their last two cups did not
    // happen.
    expect(glyphSlots(water, 10)).toBe(10);
  });

  it('says ten of eight, and says it the same way it says four of eight', () => {
    expect(valueLine(water, taps(water, 4))).toBe('4 of 8 cups');
    expect(valueLine(water, taps(water, 10))).toBe('10 of 8 cups');
  });

  it('never praises and never scolds', () => {
    // Read every string this model can produce for a day and check none of them
    // carries a verdict. Enumerated rather than spot-checked because the
    // tempting addition is exactly one cheerful word.
    const JUDGEMENTS = [
      'great', 'well done', 'nice', 'good job', 'amazing', 'keep it up', 'smashed',
      'too much', 'too many', 'over the limit', 'careful', 'warning', 'failed',
      'behind', 'you should', 'try harder', 'only', 'just', '!',
    ];
    const strings: string[] = [];
    for (const t of [water, coffee, creatine, capsules, ceiling]) {
      for (const n of [0, 1, 4, 8, 10, 31]) {
        const e = taps(t, n);
        strings.push(valueLine(t, e), addLabel(t));
        // The foot line is N77's, and it is enumerated here rather than
        // spot-checked because it is where a judgement would actually be
        // tempting: it is the string that knows the athlete went past a target.
        const foot = footLine(t, e);
        if (foot) strings.push(foot);
        // EVERY glyph in the row, not just the first — the over-target label is
        // only reachable at an index past the target, so a loop that read index
        // 0 would never see the one string this ticket added.
        const slots = glyphSlots(t, n);
        for (let i = 0; i < slots; i++) {
          const state = glyphState(t, i, n);
          strings.push(glyphLabel(t, i, slots, state), glyphHint(state));
        }
      }
    }
    // The apparatus, not the subject: an enumeration that produced nothing
    // would pass this test in silence, and so would one that never reached an
    // over-target glyph.
    expect(strings.length).toBeGreaterThan(100);
    expect(strings.some((s) => s.includes('past your target'))).toBe(true);
    for (const s of strings) {
      for (const word of JUDGEMENTS) {
        expect(s.toLowerCase()).not.toContain(word);
      }
    }
  });

  it('the bar is clamped, so over-target does not draw past the end', () => {
    expect(progress(water, taps(water, 4))).toBe(0.5);
    expect(progress(water, taps(water, 10))).toBe(1);
    // No target means no proportion to draw.
    expect(progress(coffee, taps(coffee, 3))).toBe(0);
  });
});

describe('the value line', () => {
  it('names the count when there is no target', () => {
    expect(valueLine(coffee, taps(coffee, 3))).toBe('3 cups');
    expect(valueLine(coffee, [])).toBe('0 cups');
  });

  it('drops the noun for a bare count', () => {
    const sessions: Tracker = { ...coffee, unit: '', name: 'Cold showers', count_noun: '' };
    expect(valueLine(sessions, taps(sessions, 2))).toBe('2');
  });

  it('singularises a target of one', () => {
    expect(valueLine(creatine, [])).toBe('0 of 1 dose');
    expect(valueLine(creatine, taps(creatine, 1))).toBe('1 of 1 dose');
  });

  /*
   * **The noun is READ, not derived** (N78), and these vectors are the ones
   * that tell the two apart.
   *
   * N76 computed it from the unit and recorded the failure in the same comment:
   * 30 g of fibre in 5 g steps read "6 doses", because `g` mapped to `dose`. A
   * bigger table cannot fix that — the noun belongs to the substance, and 5 g
   * of creatine, 5 g of fibre and 30 g of protein are all `g`.
   *
   * So the first case below is the whole ticket: a tracker whose unit is `g`
   * and whose noun is "serving". Any implementation still consulting the unit
   * returns "dose" for it.
   */
  it('reads the athlete\'s own noun rather than deriving one from the unit', () => {
    const fibre: Tracker = {
      ...creatine, name: 'Fibre', unit: 'g', increment: 5, target: 30,
      count_noun: 'serving',
    };
    expect(unitNoun(fibre)).toBe('serving');
    expect(valueLine(fibre, [])).toBe('0 of 6 servings');

    expect(unitNoun(water)).toBe('cup');
    expect(unitNoun(creatine)).toBe('dose');
    // Empty is a real answer and must not fall back to the unit's guess — an
    // athlete who cleared the field asked for "4 of 8".
    expect(unitNoun({ ...creatine, count_noun: '' })).toBe('');
    expect(valueLine({ ...creatine, count_noun: '' }, [])).toBe('0 of 1');
  });

  /*
   * The old derivation survives as the create form's PREFILL, where a wrong
   * guess is one edit away from right — never at render time, where it is a
   * card that lies.
   */
  it('still suggests a sensible noun from the unit while authoring', () => {
    expect(suggestedNoun('ml')).toBe('cup');
    expect(suggestedNoun('cup')).toBe('cup');
    expect(suggestedNoun('g')).toBe('dose');
    expect(suggestedNoun('mg')).toBe('dose');
    expect(suggestedNoun('dose')).toBe('dose');
    expect(suggestedNoun('count')).toBe('');
    expect(suggestedNoun('')).toBe('');
  });
});

describe('the amount line follows the unit preference', () => {
  it('shows millilitres in metric and fluid ounces in imperial', () => {
    // L4 and L8 are both live instances of a unit preference being ignored.
    // The stored number never moves; only the reading does.
    const four = taps(water, 4); // 1000 ml
    expect(amountLine(water, four, 'metric')).toBe('1 L');
    expect(amountLine(water, four, 'imperial')).toBe('33.8 fl oz');
  });

  it('does not promote fluid ounces to pints', () => {
    // An athlete tracking water thinks in fl oz all the way up, and "62.5 fl
    // oz" stays comparable with the 8 fl oz glass beside it.
    expect(amountLine(water, taps(water, 8), 'imperial')).toBe('67.6 fl oz');
  });

  it('leaves grams alone in both systems, because there is no imperial creatine', () => {
    expect(amountLine(creatine, taps(creatine, 1), 'metric')).toBe('5 g');
    expect(amountLine(creatine, taps(creatine, 1), 'imperial')).toBe('5 g');
  });

  it('says nothing when the amount would just repeat the count', () => {
    expect(amountLine(coffee, taps(coffee, 3), 'metric')).toBeNull();
  });

  it('counts entries, not amount over increment', () => {
    // An athlete who logged four cups and then changed the increment has still
    // tapped four times. Dividing the stored total by the NEW increment would
    // say two, and two of their cups would vanish from the row.
    const logged = taps(water, 4); // amount 250 each
    const wider = { ...water, increment: 500 };
    expect(loggedCount(logged)).toBe(4);
    expect(loggedAmount(logged)).toBe(1000);
    expect(glyphSlots(wider, loggedCount(logged))).toBe(4);
  });
});

describe('VoiceOver', () => {
  it('gives every glyph its own position, total, state and tracker', () => {
    // Eight identically-labelled shapes are unusable even though every one of
    // them is technically labelled: somebody swiping the row cannot tell where
    // they are or what a double-tap will change.
    expect(glyphLabel(water, 2, 8, 'filled')).toBe('Water, cup 3 of 8, filled');
    expect(glyphLabel(water, 7, 8, 'empty')).toBe('Water, cup 8 of 8, empty');
  });

  it('names the tracker, so a rotor jump lands somewhere legible', () => {
    // N78's stated format is "creatine, 1 of 1, taken" — the tracker's name
    // first, which is what makes several rows on Today distinguishable by ear.
    expect(glyphLabel(creatine, 0, 1, 'filled')).toContain('Creatine');
    expect(addLabel(water)).toBe('Add a cup of Water');
  });

  it('falls back to a word rather than an empty one for a bare count', () => {
    const bare: Tracker = { ...coffee, unit: '', name: 'Cold showers', count_noun: '' };
    expect(glyphLabel(bare, 0, 1, 'empty')).toBe('Cold showers, item 1 of 1, empty');
  });
});

describe('the last logged time — N77 needs it and water does not', () => {
  it('is the newest entry, whatever order they arrive in', () => {
    const entries: TrackerEntry[] = [
      { id: 'a', tracker_id: 't', logged_on: '2026-08-20', logged_at: '2026-08-20T09:00:00.000Z', amount: 1 },
      { id: 'b', tracker_id: 't', logged_on: '2026-08-20', logged_at: '2026-08-20T23:40:00.000Z', amount: 1 },
      { id: 'c', tracker_id: 't', logged_on: '2026-08-20', logged_at: '2026-08-20T12:00:00.000Z', amount: 1 },
    ];
    const at = lastLoggedAt(entries);
    expect(at).not.toBeNull();
    // Rendered in the DEVICE's zone. The suite runs under
    // TZ=America/Los_Angeles precisely so a UTC-formatted clock shows up as
    // wrong here rather than passing in CI and failing on a phone.
    expect(formatClock(at as Date)).toBe('16:40');
  });

  it('is null for an empty day, and ignores an unparseable timestamp', () => {
    expect(lastLoggedAt([])).toBeNull();
    expect(
      lastLoggedAt([
        { id: 'x', tracker_id: 't', logged_on: '2026-08-20', logged_at: 'not a time', amount: 1 },
      ]),
    ).toBeNull();
  });
});

describe('N77: a count with a ceiling, and the cups past it', () => {
  it('logs past the target rather than refusing, and draws every one', () => {
    // The criterion is "cups past the limit log normally". Nothing in the model
    // may cap, clamp or drop the fifth cup of a three-cup ceiling.
    const five = taps(ceiling, 5);
    expect(loggedCount(five)).toBe(5);
    expect(valueLine(ceiling, five)).toBe('5 of 3 cups');
    expect(glyphSlots(ceiling, 5)).toBe(5);
  });

  it('marks the glyphs past the target and only those', () => {
    // Indices 0..2 are the target; 3 and 4 are past it. An off-by-one here is
    // the difference between "your third cup was over" and the truth.
    const states = Array.from({ length: 5 }, (_, i) => glyphState(ceiling, i, 5));
    expect(states).toEqual(['filled', 'filled', 'filled', 'over', 'over']);
  });

  it('never marks anything over when there is no target at all', () => {
    // Coffee's shipped default. With no ceiling there is nothing to be past,
    // and an athlete who declined a target must not be shown one implicitly.
    expect(Array.from({ length: 4 }, (_, i) => glyphState(coffee, i, 4))).toEqual([
      'filled',
      'filled',
      'filled',
      'filled',
    ]);
    expect(footLine(coffee, taps(coffee, 4))).toBe('last at 01:00');
  });

  it('never draws an empty glyph beside an over one', () => {
    // The whole reason the over-target glyph can be drawn subtractively (a
    // smaller fill) rather than in a warning colour. If this ever stops
    // holding, `OVER_INSET` becomes ambiguous with "not logged".
    let sawOver = false;
    for (const t of [water, ceiling, creatine, capsules]) {
      for (let count = 0; count <= 40; count++) {
        const slots = glyphSlots(t, count);
        const states = Array.from({ length: slots }, (_, i) => glyphState(t, i, count));
        if (states.includes('over')) {
          sawOver = true;
          expect(states).not.toContain('empty');
        }
      }
    }
    // The apparatus: a sweep that never reached an over-target row would pass
    // this test without testing anything.
    expect(sawOver).toBe(true);
  });

  it('an over glyph is still removable, because it is still a logged cup', () => {
    expect(glyphHint(glyphState(ceiling, 4, 5))).toBe('Double tap to remove it');
    expect(glyphHint(glyphState(ceiling, 0, 5))).toBe('Double tap to remove it');
    expect(glyphHint(glyphState(water, 7, 4))).toBe('Double tap to add it');
  });

  it('says how far past, and says it without a verdict', () => {
    expect(footLine(ceiling, taps(ceiling, 5))).toBe('2 past your target of 3 · last at 01:00');
    // Exactly at the target is not "past" it, and not an event either.
    expect(footLine(ceiling, taps(ceiling, 3))).toBe('Target 3 reached · last at 01:00');
    expect(footLine(ceiling, taps(ceiling, 1))).toBe('2 to go · last at 01:00');
  });

  it('names the over state to VoiceOver in the same words the card uses', () => {
    expect(glyphLabel(ceiling, 3, 5, glyphState(ceiling, 3, 5))).toBe(
      'Coffee, cup 4 of 5, filled, past your target',
    );
    // Still announced as filled — a VoiceOver user has to know a double-tap
    // removes something rather than adds it.
    expect(glyphLabel(ceiling, 3, 5, 'over')).toContain('filled');
  });

  it('is silent when there is nothing at all to say', () => {
    // No target, nothing logged: no goal line, no clock, no empty-state prose.
    expect(footLine(coffee, [])).toBeNull();
    // A target with nothing logged still has arithmetic to state.
    expect(footLine(water, [])).toBe('8 to go');
  });

  it('reads the clock in the DEVICE zone, not UTC', () => {
    // 23:58 in Los Angeles is 06:58 the next day in UTC. A card that formatted
    // the stored instant in UTC would show tomorrow morning's time against
    // today's cups, and would pass in a UTC-run suite.
    const late = taps(ceiling, 1, '2026-08-21T06:58:00.000Z');
    expect(footLine(ceiling, late)).toContain('last at 23:58');
  });
});
