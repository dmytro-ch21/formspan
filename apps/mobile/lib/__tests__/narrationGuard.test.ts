import type { DayFact } from '../dayPanel';
import type { NarrationSentence } from '../dayNarration';
import { backedNumbers, guardNarration } from '../narrationGuard';
import { dayTotals } from '../nutrition';
import type { Session } from '../sessions';

/**
 * N570 (#1131): the fabricated-fact guard, against a model that invents.
 *
 * The stub below narrates a real day, and then does the four things the
 * ticket's hard constraint forbids:
 * - it cites a session that does not exist;
 * - it states a number no cited fact backs;
 * - it asserts something resting on no fact;
 * - it quotes a true number under the wrong citation.
 *
 * With the guard, only the two honest sentences survive.
 */

const DAY = '2026-09-12';

const food: DayFact = {
  key: `food-eaten:${DAY}`,
  kind: 'food-eaten',
  totals: { ...dayTotals([]), kcal: 1840.4, protein_g: 121.6 },
  entries: 3,
  refs: [{ table: 'food_entries', id: 'f1' }],
};

const done: DayFact = {
  key: `plan-done:${DAY}`,
  kind: 'plan-done',
  planned: 2,
  refs: [{ table: 'planned_sessions', id: 'p1' }],
};

const FACTS: DayFact[] = [food, done];

const HONEST_FOOD = { text: '1,840 kcal eaten so far, across 3 entries.', cites: [food.key] };
const HONEST_PLAN = { text: 'Both planned sessions are done, 2 of 2.', cites: [done.key] };
const GHOST_RUN = { text: 'You also finished a 45-minute run.', cites: ['logged:ghost-run'] };
const INVENTED_REMAINDER = { text: 'That leaves 860 kcal for dinner.', cites: [food.key] };
const OPINION = { text: 'Great consistency this week.', cites: [] };
const WRONG_CITATION = { text: 'Sessions done: 2, on 1,840 kcal.', cites: [done.key] };

function inventingModel(): NarrationSentence[] {
  return [HONEST_FOOD, HONEST_PLAN, GHOST_RUN, INVENTED_REMAINDER, OPINION, WRONG_CITATION];
}

describe('guardNarration, against a model that invents', () => {
  const verdict = guardNarration(inventingModel(), FACTS);

  it('keeps only the sentences whose every citation and number is backed', () => {
    expect(verdict.kept).toEqual([HONEST_FOOD, HONEST_PLAN]);
  });

  it('drops a session that is not in the facts, naming the invented key', () => {
    expect(verdict.dropped).toContainEqual({
      sentence: GHOST_RUN,
      reason: 'unknown-key',
      detail: 'logged:ghost-run',
    });
  });

  it('drops a number no cited fact states, naming the number', () => {
    expect(verdict.dropped).toContainEqual({
      sentence: INVENTED_REMAINDER,
      reason: 'unbacked-number',
      detail: '860',
    });
  });

  it('drops a sentence that rests on no fact at all', () => {
    expect(verdict.dropped).toContainEqual({ sentence: OPINION, reason: 'no-citation', detail: 'cites no fact' });
  });

  it('backs a number only by the facts the sentence cites, not by the whole day', () => {
    // 1,840 is true today, but this sentence did not point at the food fact.
    expect(verdict.dropped).toContainEqual({
      sentence: WRONG_CITATION,
      reason: 'unbacked-number',
      detail: '1840',
    });
  });

  it('accounts for every sentence it was given, exactly once', () => {
    expect(verdict.kept.length + verdict.dropped.length).toBe(inventingModel().length);
  });
});

describe("a cited fact's own name is not a number", () => {
  const fiveByFive: DayFact = {
    key: 'logged:s9',
    kind: 'logged',
    session: { id: 's9', name: '5x5 Day', sport: 'strength' } as Session,
    refs: [{ table: 'local_sessions', id: 's9' }],
  };

  it('keeps a sentence that quotes a name with digits in it', () => {
    expect(guardNarration([{ text: '5x5 Day logged.', cites: [fiveByFive.key] }], [fiveByFive]).kept).toHaveLength(1);
  });

  it('still drops a number added beside the name', () => {
    const sentence = { text: '5x5 Day logged: 6 sets.', cites: [fiveByFive.key] };
    expect(guardNarration([sentence], [fiveByFive]).dropped).toEqual([
      { sentence, reason: 'unbacked-number', detail: '6' },
    ]);
  });

  it('does not treat a name the sentence only resembles as the cited one', () => {
    const sentence = { text: 'Day 6 logged.', cites: [fiveByFive.key] };
    expect(guardNarration([sentence], [fiveByFive]).dropped[0].detail).toBe('6');
  });

  it("does not excuse a name's digits when that fact is not cited", () => {
    const sentence = { text: '5x5 Day logged.', cites: [food.key] };
    expect(guardNarration([sentence], [food, fiveByFive]).dropped[0]).toMatchObject({
      reason: 'unbacked-number',
      detail: '5, 5',
    });
  });
});

describe('numbers are read the way the panel prints them', () => {
  it('matches kcal and grams as the panel prints them: whole, commas ignored', () => {
    for (const text of ['1,840 kcal', '1840 kcal', '122 g protein']) {
      expect(guardNarration([{ text, cites: [food.key] }], FACTS).kept).toHaveLength(1);
    }
  });

  it('refuses kcal or grams to a decimal, a precision the panel never prints', () => {
    for (const [text, detail] of [['1840.4 kcal', '1840.4'], ['121.6 g protein', '121.6']]) {
      expect(guardNarration([{ text, cites: [food.key] }], FACTS).dropped).toEqual([
        { sentence: { text, cites: [food.key] }, reason: 'unbacked-number', detail },
      ]);
    }
  });

  it('matches a weight to one decimal, because a check-in reads "82.4 kg"', () => {
    const checkin: DayFact = {
      key: 'last-checkin:2026-09-12',
      kind: 'last-checkin',
      checkin: { measured_on: '2026-09-12', weight_kg: 82.43, fetched_at: '2026-09-12T08:00:00Z' },
      refs: [{ table: 'body_checkins_cache', measuredOn: '2026-09-12', fetchedAt: '2026-09-12T08:00:00Z' }],
    };
    const cites = [checkin.key];
    expect(guardNarration([{ text: 'Weighed 82.4 kg.', cites }, { text: 'About 82 kg.', cites }], [checkin]).kept).toHaveLength(2);
    expect(guardNarration([{ text: 'Weighed 82.5 kg.', cites }], [checkin]).dropped[0].detail).toBe('82.5');
  });

  it('refuses a figure one away from the fact', () => {
    expect(guardNarration([{ text: '1,841 kcal', cites: [food.key] }], FACTS).dropped[0].reason).toBe(
      'unbacked-number',
    );
  });

  it('lists what a food fact backs, whole numbers only', () => {
    const backed = [...backedNumbers(food)];
    expect(backed).toEqual(expect.arrayContaining(['1840', '122', '3']));
    expect(backed).not.toContain('1840.4');
  });

  it('keeps a sentence with no numbers when its citation is real', () => {
    expect(guardNarration([{ text: 'Lunch is logged.', cites: [food.key] }], FACTS).kept).toHaveLength(1);
  });

  it('returns nothing for no narration', () => {
    expect(guardNarration([], FACTS)).toEqual({ kept: [], dropped: [] });
  });
});
