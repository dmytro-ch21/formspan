import type { DayFact } from '../dayPanel';
import { guardNarration } from '../narrationGuard';
import { changedFacts, decideNarration, MODEL_WHEN_CHANGED_AT_LEAST } from '../narrationPolicy';
import { dayTotals } from '../nutrition';
import type { PlannedOffer } from '../trainBoard';
import type { Session } from '../sessions';
import type { Tracker } from '../trackerModel';

/**
 * N570 (#1131): when narration is said plainly, and when a model earns the
 * call. Every deterministic result is also run through the fabricated-fact
 * guard, because a plain sentence still has to cite what it says.
 */

const DAY = '2026-09-12';

const eaten = (kcal: number, entries: number): DayFact => ({
  key: `food-eaten:${DAY}`,
  kind: 'food-eaten',
  totals: { ...dayTotals([]), kcal },
  entries,
  refs: [{ table: 'food_entries', id: `f${entries}` }],
});

const targetOf = (protein_g: number, carb_g: number): DayFact => ({
  key: 'nutrition-target:2026-09-01',
  kind: 'nutrition-target',
  target: { effective_on: '2026-09-01', kcal: 2700, protein_g, carb_g, fat_g: 80, fibre_g: null },
  refs: [{ table: 'nutrition_targets', effectiveOn: '2026-09-01' }],
});

const target = targetOf(180, 300);

const water = (logged: number): DayFact => ({
  key: 'tracker:water',
  kind: 'tracker',
  tracker: { id: 'water', name: 'Water' } as Tracker,
  entries: [],
  logged,
  target: 8,
  refs: [{ table: 'daily_trackers', id: 'water' }],
});

const logged = (name: string): DayFact => ({
  key: 'logged:s1',
  kind: 'logged',
  session: { id: 's1', name, sport: 'strength' } as Session,
  refs: [{ table: 'local_sessions', id: 's1' }],
});

// Minimal on purpose: nothing under test reads `fact.plan`. A plain sentence that
// starts to must fill in this fixture, or the cast will hide a real type error.
const owed: DayFact = {
  key: 'planned:p1',
  kind: 'planned',
  plan: { id: 'p1' } as PlannedOffer,
  refs: [{ table: 'planned_sessions', id: 'p1' }],
};

function expectGuardKeepsAll(facts: DayFact[], previous: DayFact[] | null) {
  const decision = decideNarration(facts, previous);
  if (decision.kind !== 'deterministic') throw new Error(`expected deterministic, got ${decision.kind}`);
  const verdict = guardNarration(decision.sentences, facts);
  expect(verdict.dropped).toEqual([]);
  return decision.sentences;
}

describe('the plain case: said without a model', () => {
  it('states lunch against the target, citing both facts it rests on', () => {
    const before = [eaten(900, 1), target];
    const after = [eaten(1840, 3), target];
    expect(expectGuardKeepsAll(after, before)).toEqual([
      { text: '1,840 of 2,700 kcal eaten today.', cites: [`food-eaten:${DAY}`, 'nutrition-target:2026-09-01'] },
    ]);
  });

  it('states what was eaten alone when no target is set', () => {
    expect(expectGuardKeepsAll([eaten(1840, 3)], [eaten(900, 1)])).toEqual([
      { text: '1,840 kcal eaten today.', cites: [`food-eaten:${DAY}`] },
    ]);
  });

  it('names a finished session, or says a session was logged when it has no name', () => {
    expect(expectGuardKeepsAll([eaten(900, 1), logged('Push day')], [eaten(900, 1)])).toEqual([
      { text: 'Push day logged.', cites: ['logged:s1'] },
    ]);
    expect(expectGuardKeepsAll([eaten(900, 1), logged('')], [eaten(900, 1)])).toEqual([
      { text: 'A session was logged.', cites: ['logged:s1'] },
    ]);
  });

  it('names a session whose name has digits in it, and the guard keeps it', () => {
    expect(expectGuardKeepsAll([eaten(900, 1), logged('5x5 Day')], [eaten(900, 1)])).toEqual([
      { text: '5x5 Day logged.', cites: ['logged:s1'] },
    ]);
  });

  it('sees a target edited only in its macro split, and states all four figures', () => {
    expect(expectGuardKeepsAll([targetOf(200, 280)], [targetOf(180, 300)])).toEqual([
      { text: 'Target: 2,700 kcal, 200 g protein, 280 g carbs, 80 g fat a day.', cites: ['nutrition-target:2026-09-01'] },
    ]);
  });

  it('stays plain for a meal logged while a plan is owed: that is not a prioritisation question', () => {
    expect(expectGuardKeepsAll([owed, eaten(1840, 3)], [owed, eaten(900, 1)])).toEqual([
      { text: '1,840 kcal eaten today.', cites: [`food-eaten:${DAY}`] },
    ]);
  });

  it('states two changes as two sentences, under the model threshold', () => {
    const sentences = expectGuardKeepsAll([eaten(1840, 3), water(5)], [eaten(900, 1), water(4)]);
    expect(sentences.map((s) => s.text)).toEqual(['1,840 kcal eaten today.', 'Water: 5 of 8.']);
  });
});

describe('when a model earns the call', () => {
  it('on the first event of the day, since there is nothing to compare with', () => {
    expect(decideNarration([eaten(900, 1)], null)).toEqual({
      kind: 'model',
      reason: 'first-of-day',
      changed: [`food-eaten:${DAY}`],
    });
  });

  it(`when ${MODEL_WHEN_CHANGED_AT_LEAST} facts changed at once, and not at one fewer`, () => {
    const before = [eaten(900, 1), water(4)];
    expect(decideNarration([eaten(1840, 3), water(5)], before).kind).toBe('deterministic');
    expect(decideNarration([eaten(1840, 3), water(5), logged('Push day')], before)).toEqual({
      kind: 'model',
      reason: 'many-changes',
      changed: [`food-eaten:${DAY}`, 'tracker:water', 'logged:s1'],
    });
  });

  it('when a session is logged while another planned session is still owed', () => {
    expect(decideNarration([owed, logged('Push day'), eaten(900, 1)], [owed, eaten(900, 1)])).toEqual({
      kind: 'model',
      reason: 'plan-owed',
      changed: ['logged:s1'],
    });
  });
});

describe('when nothing is said', () => {
  it('when no fact changed', () => {
    expect(decideNarration([eaten(900, 1), target], [eaten(900, 1), target])).toEqual({ kind: 'none' });
  });

  it('when the only change is a fact going away: removing the last meal spends nothing', () => {
    expect(decideNarration([target], [eaten(900, 1), target])).toEqual({ kind: 'none' });
  });

  it('when the changed fact has no plain sentence of its own', () => {
    expect(decideNarration([eaten(900, 1), owed], [eaten(900, 1)]).kind).toBe('model');
    const checkin: DayFact = {
      key: 'last-checkin:2026-09-12',
      kind: 'last-checkin',
      checkin: { measured_on: '2026-09-12', weight_kg: 82.4, fetched_at: '2026-09-12T08:00:00Z' },
      refs: [{ table: 'body_checkins_cache', measuredOn: '2026-09-12', fetchedAt: '2026-09-12T08:00:00Z' }],
    };
    expect(decideNarration([eaten(900, 1), checkin], [eaten(900, 1)])).toEqual({ kind: 'none' });
  });
});

describe('changedFacts', () => {
  it('sees a moved figure, a new fact, and ignores an unchanged one', () => {
    const changed = changedFacts([eaten(1840, 3), target, water(4)], [eaten(900, 1), target]);
    expect(changed.map((f) => f.key)).toEqual([`food-eaten:${DAY}`, 'tracker:water']);
  });

  it('does not count a rounding-only difference in kcal as a change', () => {
    expect(changedFacts([eaten(900.4, 1)], [eaten(899.6, 1)])).toEqual([]);
  });
});
