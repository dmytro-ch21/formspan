import { criteriaChips, hasEvidence } from '@/lib/curriculumRow';
import type { Criteria, CurriculumItem, Progress } from '@/lib/curriculum';

/**
 * The mapping layer, which is where the roadmap's one blocking bug actually
 * lived.
 *
 * `techniqueRow.test.tsx` covers what the row *draws* given an answer. This
 * covers the answer. Review pointed out the gap in so many words: the component
 * test stays green if `hasEvidence` reads `scored` instead of `attempts`,
 * because the row only ever sees a boolean — so the exact class of defect that
 * shipped (a display state derived from the wrong field) had no coverage at
 * all, in either file, until this one existed.
 *
 * ## Mutation record
 *
 * Measured against `lib/curriculumRow.ts`, each applied and reverted.
 *
 * | Mutation                                           | Result |
 * | --------------------------------------------------- | ------ |
 * | `hasEvidence`: `attempts` → `scored` *              | 1 red  |
 * | `hasEvidence`: drop the `defended` clause           | 1 red  |
 * | `hasEvidence`: drop the `sessions` clause           | 1 red  |
 * | `hasEvidence`: `p != null` → `true`                 | 1 red  |
 * | `criteriaChips`: `—` branch → `0%`                  | 1 red  |
 * | `criteriaChips`: `value` ignores `enrolled`         | 2 red  |
 * | `criteriaChips`: `met` ignores `enrolled`           | 1 red  |
 * | `criteriaChips`: `>=` → `>` on a volume target      | 2 red  |
 *
 * \* This is the one review named as undetectable — "swap `attempts` for
 * `scored` and every test stays green". It was true of the component test and
 * is the reason this file exists.
 */

function progress(over: Partial<Progress> = {}): Progress {
  return {
    scored: 0,
    defended: 0,
    sessions: 0,
    attempts: 0,
    hit_rate: null,
    mastered: false,
    ...over,
  };
}

// No `as` casts on either of these, deliberately. The first draft had them,
// and the cast is what let the fixture carry a `sort_order` field that does not
// exist on `CurriculumItem` — a shape the compiler would otherwise have
// rejected outright. A fixture that has to be cast into place is a fixture that
// can drift from the type it claims to be.
function criteria(over: Partial<Criteria> = {}): Criteria {
  return {
    target_scored: null,
    target_defended: null,
    target_sessions: null,
    min_hit_rate: null,
    ...over,
  };
}

function item(c: Criteria | null, p: Progress | null): CurriculumItem {
  return {
    technique_id: 't1',
    name: 'Armbar from closed guard',
    position: 'Closed guard',
    category: 'Submission',
    notes: '',
    order: 1,
    criteria: c,
    progress: p,
  };
}

describe('hasEvidence', () => {
  it('is false for someone not enrolled, whose progress is null', () => {
    expect(hasEvidence(null)).toBe(false);
    expect(hasEvidence(undefined)).toBe(false);
  });

  it('is false on a fresh enrollment with nothing logged', () => {
    expect(hasEvidence(progress())).toBe(false);
  });

  it('counts an attempt that did not land', () => {
    // The case the whole prop exists for. `attempts` is scored + attempted, so
    // going for it and failing is evidence — reading `scored` here would call
    // this athlete untouched.
    expect(hasEvidence(progress({ attempts: 1 }))).toBe(true);
  });

  it('counts defending it, which moves no other counter', () => {
    expect(hasEvidence(progress({ defended: 1 }))).toBe(true);
  });

  it('counts a live session on its own axis', () => {
    expect(hasEvidence(progress({ sessions: 1 }))).toBe(true);
  });

  it('is true for the near-miss that shipped broken', () => {
    // 24/25 landed, 14/15 sessions, 38% against a 40% floor: nothing met,
    // everything moved.
    expect(
      hasEvidence(progress({ scored: 24, attempts: 63, sessions: 14, hit_rate: 0.38 })),
    ).toBe(true);
  });

  it('reads drilled-only training as untouched — a limitation, not a choice', () => {
    // The backend excludes `drilled` from all three counters on purpose, and
    // `Progress` carries no drilled count, so the client has no signal to read.
    // Documented here so the behaviour is deliberate and findable rather than
    // discovered by an athlete who drilled something twenty times.
    expect(hasEvidence(progress())).toBe(false);
  });
});

describe('criteriaChips', () => {
  it('returns nothing for a reading item', () => {
    expect(criteriaChips(item(null, null), true)).toEqual([]);
  });

  it('shows the climb when enrolled', () => {
    const chips = criteriaChips(
      item(criteria({ target_scored: 25 }), progress({ scored: 12 })),
      true,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      icon: 'goal',
      value: '12/25',
      met: false,
      label: 'Landed, 12 of 25',
    });
  });

  it('shows the bar only when browsing, in the value AND the label', () => {
    // Both halves asserted: a correct visible value with a label that leaks
    // "0 of 25" is still a shortfall reported to someone who never enrolled.
    const chips = criteriaChips(item(criteria({ target_scored: 25 }), null), false);
    expect(chips[0].value).toBe('25');
    expect(chips[0].label).toBe('Landed, 25 needed');
    expect(chips[0].met).toBe(false);
    expect(chips[0].label).not.toMatch(/0 of/);
  });

  it('never marks a criterion met for someone browsing', () => {
    // Progress present but not enrolled should not tint anything — enrollment
    // is what makes a number the athlete's.
    const chips = criteriaChips(
      item(criteria({ target_scored: 25 }), progress({ scored: 99 })),
      false,
    );
    expect(chips[0].met).toBe(false);
  });

  it('meets a target exactly at the threshold', () => {
    const chips = criteriaChips(
      item(criteria({ target_scored: 25 }), progress({ scored: 25 })),
      true,
    );
    expect(chips[0].met).toBe(true);
  });

  it('emits one chip per non-null criterion, in reading order', () => {
    const chips = criteriaChips(
      item(
        criteria({ target_scored: 25, target_defended: 10, target_sessions: 15, min_hit_rate: 0.4 }),
        progress({ scored: 25, defended: 3, sessions: 15, attempts: 50, hit_rate: 0.5 }),
      ),
      true,
    );
    expect(chips.map((c) => c.icon)).toEqual(['goal', 'recovery', 'calendar', 'chart']);
    expect(chips.map((c) => c.met)).toEqual([true, false, true, true]);
  });

  it('omits a criterion the curriculum left null', () => {
    const chips = criteriaChips(
      item(criteria({ target_sessions: 15 }), progress({ sessions: 2 })),
      true,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].icon).toBe('calendar');
  });

  describe('the hit rate', () => {
    it('is an em dash before any attempt, never 0%', () => {
      const chips = criteriaChips(
        item(criteria({ min_hit_rate: 0.4 }), progress({ hit_rate: null })),
        true,
      );
      expect(chips[0].value).toBe('—/40%');
      expect(chips[0].value).not.toMatch(/0%\//);
      expect(chips[0].met).toBe(false);
      expect(chips[0].label).toBe('Hit rate, 40 percent needed');
    });

    it('is a real 0% once there are attempts and no scores', () => {
      // The opposite error: a genuine zero from real attempts IS a rate, and
      // hiding it behind a dash would flatter the athlete.
      const chips = criteriaChips(
        item(criteria({ min_hit_rate: 0.4 }), progress({ attempts: 12, hit_rate: 0 })),
        true,
      );
      expect(chips[0].value).toBe('0%/40%');
      expect(chips[0].met).toBe(false);
    });

    it('rounds to whole percent on both sides', () => {
      const chips = criteriaChips(
        item(criteria({ min_hit_rate: 0.425 }), progress({ attempts: 3, hit_rate: 1 / 3 })),
        true,
      );
      expect(chips[0].value).toBe('33%/43%');
      expect(chips[0].label).toBe('Hit rate, 33 percent of 43 needed');
    });
  });
});
