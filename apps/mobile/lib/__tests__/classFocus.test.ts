import type { Criteria, Curriculum, CurriculumItem, Progress } from '../curriculum';
import type { Proficiency } from '../proficiency';
import { classFocus, classHintText, MAX_CLASS_SUGGESTIONS, type ClassFocus } from '../classFocus';

/**
 * #447 — the roadmap focus/suggestion line a scheduled BJJ class card shows.
 *
 * Every negative case below was checked by relaxing the guard it covers and
 * confirming the test goes red, per CLAUDE.md's "verify that a check can
 * fail": the recency filter, the dismissal filter, the `attempts === 0` gate
 * (disjoint from `attempted === 0`, same trap `suggestion.test.ts` guards),
 * the `MIN_DRILLED` threshold, the cap, and both halves of the deterministic
 * order (roadmap `order` first, `technique_id` only as the tiebreak).
 */

const NOW = new Date('2026-08-27T12:00:00Z');
const CUTOFF_OK = '2026-08-01T18:00:00Z'; // inside the 60-day window
const CUTOFF_STALE = '2026-01-01T18:00:00Z'; // well outside it

const CRITERIA: Criteria = {
  target_scored: 25,
  target_defended: 8,
  target_sessions: 12,
  min_hit_rate: 0.35,
  target_drilled_sessions: null,
};

function progress(over: Partial<Progress> = {}): Progress {
  return {
    scored: 0,
    defended: 0,
    sessions: 0,
    attempts: 0,
    hit_rate: null,
    drilled_sessions: 0,
    mastered: false,
    ...over,
  };
}

/** A roadmap step — a technique item carrying criteria. `order` is passed
 *  explicitly by every caller here — determinism-by-order is exactly what
 *  this file tests, so it must never come from an auto-incrementing counter
 *  a test could not see or control. */
function step(id: string, order: number, over: Partial<CurriculumItem> = {}): CurriculumItem {
  return {
    kind: 'technique',
    technique_id: id,
    name: over.name ?? `Technique ${id}`,
    position: 'Guard - Bottom',
    category: 'Sweep',
    order,
    phase: null,
    notes: '',
    criteria: CRITERIA,
    progress: progress(),
    ...over,
  };
}

function roadmap(over: Partial<Curriculum> = {}): Curriculum {
  return {
    id: over.id ?? 'r1',
    editable: false,
    official: true,
    name: over.name ?? 'Blue belt fundamentals',
    description: '',
    belt: null,
    track: 'belt',
    visibility: 'public',
    enrolled: true,
    started_on: '2026-01-01',
    item_count: over.items?.length ?? 0,
    countable_items: over.items?.filter((i) => i.criteria !== null).length ?? 0,
    mastered_items: over.items?.filter((i) => i.progress?.mastered).length ?? 0,
    phases: over.phases,
    items: over.items ?? [],
    ...over,
  };
}

function fun(id: string, over: Partial<Proficiency> = {}): Proficiency {
  return {
    technique_id: id,
    name: `Technique ${id}`,
    position: 'Guard - Bottom',
    category: 'Sweep',
    drilled: 6,
    attempted: 0,
    scored: 0,
    conceded: 0,
    defended: 0,
    sessions: 3,
    last_seen: CUTOFF_OK,
    ...over,
  };
}

const noDismissals = new Set<string>();

describe('classFocus — the focus line', () => {
  it('reports the milestone when the roadmap has phases', () => {
    const c = roadmap({
      phases: [
        { order: 0, title: 'Stand up', description: '' },
        { order: 1, title: 'Pass', description: '' },
      ],
      items: [step('a', 0, { phase: 0, progress: progress({ mastered: true }) }), step('b', 1, { phase: 1 })],
    });
    const got = classFocus([c], null, NOW);
    expect(got?.focusLine).toBe('Milestone 2 of 2 · Pass');
  });

  it('falls back to "Next up" on an unphased roadmap', () => {
    const c = roadmap({ items: [step('a', 0, { name: 'Arm drag' })] });
    const got = classFocus([c], null, NOW);
    expect(got?.focusLine).toBe('Next up: Arm drag');
  });

  it('degrades to null with no working roadmap at all — AC4, no empty scaffolding', () => {
    expect(classFocus([], null, NOW)).toBeNull();
  });

  it('degrades to null when the roadmap is fully mastered — nothing left to focus on', () => {
    const c = roadmap({ items: [step('a', 0, { progress: progress({ mastered: true }) })] });
    expect(classFocus([c], null, NOW)).toBeNull();
  });

  it('skips a finished roadmap ahead of an active one, in list order', () => {
    const done = roadmap({ id: 'done', items: [step('a', 0, { progress: progress({ mastered: true }) })] });
    const active = roadmap({ id: 'active', items: [step('b', 0, { name: 'Triangle' })] });
    const got = classFocus([done, active], null, NOW);
    expect(got?.focusLine).toBe('Next up: Triangle');
  });
});

describe('classFocus — suggestions', () => {
  it('suggests a step drilled enough and never taken live, with a reason', () => {
    const c = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 6, attempts: 0 }) })],
    });
    const got = classFocus([c], { funnel: [fun('a')], dismissed: noDismissals }, NOW);
    expect(got?.suggestions).toEqual([
      { techniqueId: 'a', name: 'Technique a', reason: 'drilled 6 times, never live' },
    ]);
  });

  it('is exactly at the MIN_DRILLED boundary — 5 does not qualify, 6 does', () => {
    const below = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 5, attempts: 0 }) })],
    });
    const at = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 6, attempts: 0 }) })],
    });
    expect(classFocus([below], { funnel: [fun('a')], dismissed: noDismissals }, NOW)?.suggestions).toEqual(
      [],
    );
    expect(
      classFocus([at], { funnel: [fun('a')], dismissed: noDismissals }, NOW)?.suggestions[0]?.reason,
    ).toBe('drilled 6 times, never live');
  });

  it('reports the exact drilled count in the reason, not the threshold', () => {
    const c = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 11, attempts: 0 }) })],
    });
    const got = classFocus([c], { funnel: [fun('a')], dismissed: noDismissals }, NOW);
    expect(got?.suggestions[0]?.reason).toBe('drilled 11 times, never live');
  });

  it('does not suggest a technique already taken live — attempts, not a raw drilled count, gates it', () => {
    // The disjoint trap `suggestion.test.ts` guards, one level up: `attempts`
    // is `scored + attempted`, so a technique landed twice is plainly not
    // "never live" even though nothing here reads `scored` directly.
    const c = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 9, attempts: 2 }) })],
    });
    const got = classFocus([c], { funnel: [fun('a')], dismissed: noDismissals }, NOW);
    expect(got?.suggestions).toEqual([]);
  });

  it('does not suggest a technique below the drilled threshold', () => {
    const c = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 5, attempts: 0 }) })],
    });
    const got = classFocus([c], { funnel: [fun('a')], dismissed: noDismissals }, NOW);
    expect(got?.suggestions).toEqual([]);
  });

  it('does not suggest a mastered step', () => {
    // A second, unmastered item keeps `nextStep` non-null — otherwise the
    // whole roadmap degrades to null (AC4) and the assertion below would be
    // testing "no roadmap" rather than "mastered items are excluded".
    const c = roadmap({
      items: [
        step('a', 0, { progress: progress({ drilled_sessions: 9, attempts: 0, mastered: true }) }),
        step('b', 1),
      ],
    });
    const got = classFocus([c], { funnel: [fun('a')], dismissed: noDismissals }, NOW);
    expect(got?.suggestions).toEqual([]);
  });

  it('does not suggest a reading item — no criteria means nothing evidence could measure', () => {
    const c = roadmap({
      items: [
        {
          ...step('a', 0, { progress: progress({ drilled_sessions: 9, attempts: 0 }) }),
          criteria: null,
          progress: null,
        },
        step('b', 1),
      ],
    });
    const got = classFocus([c], { funnel: [fun('a')], dismissed: noDismissals }, NOW);
    expect(got?.suggestions).toEqual([]);
  });

  it('drops a candidate whose funnel evidence has gone stale', () => {
    const c = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 9, attempts: 0 }) })],
    });
    const got = classFocus(
      [c],
      { funnel: [fun('a', { last_seen: CUTOFF_STALE })], dismissed: noDismissals },
      NOW,
    );
    expect(got?.suggestions).toEqual([]);
  });

  it('drops a candidate with no funnel row at all rather than assuming it is recent', () => {
    const c = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 9, attempts: 0 }) })],
    });
    const got = classFocus([c], { funnel: [], dismissed: noDismissals }, NOW);
    expect(got?.suggestions).toEqual([]);
  });

  it('respects a permanent per-technique dismissal', () => {
    const c = roadmap({
      items: [step('a', 0, { progress: progress({ drilled_sessions: 9, attempts: 0 }) })],
    });
    const got = classFocus([c], { funnel: [fun('a')], dismissed: new Set(['a']) }, NOW);
    expect(got?.suggestions).toEqual([]);
  });

  it('caps at MAX_CLASS_SUGGESTIONS even with more eligible candidates', () => {
    expect(MAX_CLASS_SUGGESTIONS).toBe(2);
    const items = ['a', 'b', 'c'].map((id, i) =>
      step(id, i, { progress: progress({ drilled_sessions: 9, attempts: 0 }) }),
    );
    const c = roadmap({ items });
    const funnel = ['a', 'b', 'c'].map((id) => fun(id));
    const got = classFocus([c], { funnel, dismissed: noDismissals }, NOW);
    expect(got?.suggestions).toHaveLength(2);
    expect(got?.suggestions.map((s) => s.techniqueId)).toEqual(['a', 'b']);
  });

  it('orders by the roadmap\'s own item order, never by evidence strength', () => {
    // `b` has more drilled sessions than `a`, but `a` comes first in the
    // syllabus — the opposite ranking `funnelGap` would produce, and the
    // whole reason this file does not just reuse it.
    const items = [
      step('a', 0, { progress: progress({ drilled_sessions: 6, attempts: 0 }) }),
      step('b', 1, { progress: progress({ drilled_sessions: 20, attempts: 0 }) }),
    ];
    const c = roadmap({ items });
    const funnel = [fun('a'), fun('b')];
    const got = classFocus([c], { funnel, dismissed: noDismissals }, NOW);
    expect(got?.suggestions.map((s) => s.techniqueId)).toEqual(['a', 'b']);
  });

  it('breaks a tied order on technique_id, so the answer is total', () => {
    const items = [
      step('z', 0, { progress: progress({ drilled_sessions: 6, attempts: 0 }) }),
      step('a', 0, { progress: progress({ drilled_sessions: 6, attempts: 0 }) }),
    ];
    const c = roadmap({ items });
    const funnel = [fun('z'), fun('a')];
    const got = classFocus([c], { funnel, dismissed: noDismissals }, NOW);
    expect(got?.suggestions.map((s) => s.techniqueId)).toEqual(['a', 'z']);
  });

  it('is deterministic — same inputs, same output, called twice', () => {
    const items = [
      step('a', 0, { progress: progress({ drilled_sessions: 6, attempts: 0 }) }),
      step('b', 1, { progress: progress({ drilled_sessions: 9, attempts: 0 }) }),
    ];
    const c = roadmap({ items });
    const funnel = [fun('a'), fun('b')];
    const first = classFocus([c], { funnel, dismissed: noDismissals }, NOW);
    const second = classFocus([c], { funnel, dismissed: noDismissals }, NOW);
    expect(first).toEqual(second);
  });

  it('returns the focus line with no suggestions when evidence is withheld', () => {
    // Today withholds evidence when suggestions are off or have not loaded —
    // the focus line, a committed fact rather than a suggestion, still shows.
    const c = roadmap({ items: [step('a', 0, { name: 'Arm drag' })] });
    const got = classFocus([c], null, NOW);
    expect(got).toEqual({ focusLine: 'Next up: Arm drag', suggestions: [] });
  });
});

describe('classHintText', () => {
  it('is just the focus line with no suggestions', () => {
    const focus: ClassFocus = { focusLine: 'Next up: Arm drag', suggestions: [] };
    expect(classHintText(focus)).toBe('Next up: Arm drag');
  });

  it('appends the reasoned suggestions after the focus line', () => {
    const focus: ClassFocus = {
      focusLine: 'Next up: Arm drag',
      suggestions: [{ techniqueId: 'a', name: 'Triangle', reason: 'drilled 6 times, never live' }],
    };
    expect(classHintText(focus)).toBe(
      'Next up: Arm drag. Try: Triangle — drilled 6 times, never live',
    );
  });

  it('joins two suggestions', () => {
    const focus: ClassFocus = {
      focusLine: 'Next up: Arm drag',
      suggestions: [
        { techniqueId: 'a', name: 'Triangle', reason: 'drilled 6 times, never live' },
        { techniqueId: 'b', name: 'Scissor sweep', reason: 'drilled 8 times, never live' },
      ],
    };
    expect(classHintText(focus)).toBe(
      'Next up: Arm drag. Try: Triangle — drilled 6 times, never live; Scissor sweep — drilled 8 times, never live',
    );
  });
});
