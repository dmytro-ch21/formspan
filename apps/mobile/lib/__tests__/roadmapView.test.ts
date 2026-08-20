import type { Criteria, Curriculum, CurriculumItem, Progress } from '@/lib/curriculum';
import {
  buildRoadmap,
  goalOf,
  measuresOf,
  percent,
  thesisOf,
  titleOf,
} from '@/lib/roadmapView';

/**
 * The roadmap screen's derivations.
 *
 * Every assertion here fails when the code it covers is deleted — the rule the
 * mobile suite was started for. The three that matter most are the ones a
 * reviewer cannot see by reading the screen:
 *
 *  - a milestone of concepts must have NO progress rather than 0%,
 *  - those milestones must leave BOTH halves of the belt's own fraction,
 *  - and a concept must never produce an empty measure list, which would draw
 *    it as a technique nobody has started.
 */

const NO_CRITERIA: Criteria = {
  target_scored: null,
  target_defended: null,
  target_sessions: null,
  min_hit_rate: null,
  target_drilled_sessions: null,
};

const NO_PROGRESS: Progress = {
  scored: 0,
  defended: 0,
  sessions: 0,
  attempts: 0,
  hit_rate: null,
  drilled_sessions: 0,
  mastered: false,
};

function technique(
  id: string,
  phase: number | null,
  criteria: Partial<Criteria> | null,
  progress?: Partial<Progress>,
): CurriculumItem {
  return {
    kind: 'technique',
    technique_id: id,
    name: id,
    position: 'Guard - Bottom',
    category: 'Sweep',
    order: 0,
    phase,
    notes: '',
    criteria: criteria === null ? null : { ...NO_CRITERIA, ...criteria },
    progress: progress === undefined ? null : { ...NO_PROGRESS, ...progress },
  };
}

function concept(order: number, phase: number | null, title: string): CurriculumItem {
  return {
    kind: 'concept',
    title,
    name: title,
    position: '',
    category: '',
    order,
    phase,
    notes: 'Position before submission.',
    criteria: null,
    progress: null,
  };
}

function curriculum(over: Partial<Curriculum> = {}): Curriculum {
  return {
    id: 'white-belt-basics',
    editable: false,
    official: true,
    name: 'White belt: learn the basic game',
    description:
      'Goal: understand what is actually happening in a BJJ match. The eleven milestones follow a match from its beginning.',
    belt: 'white',
    track: 'belt',
    visibility: 'public',
    enrolled: true,
    started_on: '2026-01-01',
    item_count: 0,
    countable_items: 0,
    mastered_items: 0,
    phases: [],
    items: [],
    ...over,
  };
}

describe('the header', () => {
  it('titles from the belt, not the name — the name is a sentence', () => {
    expect(titleOf(curriculum())).toBe('WHITE BELT');
    expect(titleOf(curriculum({ belt: 'brown' }))).toBe('BROWN BELT');
  });

  it('falls back to the name for a curriculum belonging to no belt', () => {
    expect(titleOf(curriculum({ belt: null, name: 'My leg lock list' }))).toBe('MY LEG LOCK LIST');
  });

  it('takes the thesis from the tail of the name', () => {
    expect(thesisOf(curriculum())).toBe('Learn the basic game');
    expect(thesisOf(curriculum({ name: 'Blue belt: build reliable systems' }))).toBe(
      'Build reliable systems',
    );
  });

  it('falls back to the goal when the name carries no thesis', () => {
    expect(thesisOf(curriculum({ name: 'Leg locks' }))).toBe(
      'Understand what is actually happening in a BJJ match.',
    );
  });

  it('strips the "Goal:" prefix, so the completion card reads as an outcome', () => {
    expect(goalOf(curriculum())).toBe('Understand what is actually happening in a BJJ match.');
  });

  it('does not truncate a first sentence at a decimal or an initial', () => {
    // A naive split on '.' cuts "A-game" prose mid-clause. The real
    // descriptions contain "0.3", arrows and hyphenated terms.
    expect(goalOf(curriculum({ description: 'Land it at a 0.3 rate. Then move on.' }))).toBe(
      'Land it at a 0.3 rate.',
    );
  });

  it('returns a description with no terminator whole rather than empty', () => {
    expect(goalOf(curriculum({ description: 'Everything you need' }))).toBe(
      'Everything you need',
    );
  });
});

describe('measures', () => {
  it('names every threshold, with where the athlete stands', () => {
    const item = technique('x', 0, { target_scored: 12, target_sessions: 8, min_hit_rate: 0.3 }, {
      scored: 5,
      sessions: 8,
      hit_rate: 0.4,
    });
    expect(measuresOf(item, true)).toEqual([
      { label: 'Landed live', need: '12', have: '5', met: false },
      { label: 'Separate live sessions', need: '8', have: '8', met: true },
      { label: 'Hit rate', need: '30%', have: '40%', met: true },
    ]);
  });

  it('reports no standing at all when not enrolled — counting has not started', () => {
    const item = technique('x', 0, { target_scored: 12 }, { scored: 5 });
    expect(measuresOf(item, false)).toEqual([
      { label: 'Landed live', need: '12', have: null, met: false },
    ]);
  });

  it('shows an em dash for a hit rate with no attempts, never 0%', () => {
    const item = technique('x', 0, { min_hit_rate: 0.3 }, { hit_rate: null });
    expect(measuresOf(item, true)?.[0].have).toBe('—');
  });

  it('counts drilled classes, which is the only criterion practice moves', () => {
    const item = technique('x', 0, { target_drilled_sessions: 10 }, { drilled_sessions: 10 });
    expect(measuresOf(item, true)).toEqual([
      { label: 'Classes drilled in', need: '10', have: '10', met: true },
    ]);
  });

  it('returns NULL for a concept — not an empty list', () => {
    // The distinction is the whole point: `[]` would draw a concept as a
    // technique with no thresholds met, which is a claim about the athlete.
    expect(measuresOf(concept(1, 0, 'Position before submission'), true)).toBeNull();
  });

  it('returns null for a technique carrying no criteria at all', () => {
    expect(measuresOf(technique('x', 0, null), true)).toBeNull();
  });

  it('returns null for a criteria object whose every threshold is null', () => {
    expect(measuresOf(technique('x', 0, {}), true)).toBeNull();
  });
});

describe('milestones', () => {
  const phases = [
    { order: 0, title: 'Start Standing', description: 'Begin safely.' },
    { order: 1, title: 'Strategy', description: 'Ideas only.' },
  ];

  it('numbers them 1-based, in phase order, with their lessons', () => {
    const c = curriculum({
      phases,
      items: [technique('a', 0, { target_scored: 1 }), concept(1, 1, 'Think first')],
    });
    const v = buildRoadmap(c);
    expect(v.milestones.map((m) => [m.index, m.title, m.lessons.length])).toEqual([
      [1, 'Start Standing', 1],
      [2, 'Strategy', 1],
    ]);
  });

  it('gives a milestone of concepts NO progress rather than 0%', () => {
    const c = curriculum({ phases, items: [concept(1, 1, 'Think first')] });
    const strategy = buildRoadmap(c).milestones[1];
    expect(strategy.countable).toBe(0);
    expect(strategy.progress).toBeNull();
    // And it is not "complete" either — nothing was completed.
    expect(strategy.complete).toBe(false);
  });

  it('derives progress from the items, mastered over countable', () => {
    const c = curriculum({
      phases,
      items: [
        technique('a', 0, { target_scored: 1 }, { mastered: true }),
        technique('b', 0, { target_scored: 1 }, { mastered: false }),
        // A concept in the same milestone must not dilute the fraction.
        concept(3, 0, 'An idea'),
      ],
    });
    const m = buildRoadmap(c).milestones[0];
    expect([m.mastered, m.countable, m.progress]).toEqual([1, 2, 0.5]);
  });

  it('leaves concept-only milestones out of BOTH halves of the belt fraction', () => {
    // Counted in the denominator, a purple belt is capped below 100% forever;
    // counted as complete, it claims work nobody could have done.
    const c = curriculum({
      phases,
      items: [
        technique('a', 0, { target_scored: 1 }, { mastered: true }),
        concept(2, 1, 'Think first'),
      ],
    });
    const v = buildRoadmap(c);
    expect(v.countableMilestones).toBe(1);
    expect(v.completedMilestones).toBe(1);
    expect(v.progress).toBe(1);
  });

  it('reports no belt progress at all when nothing in it can be completed', () => {
    const c = curriculum({ phases, items: [concept(1, 0, 'A'), concept(2, 1, 'B')] });
    expect(buildRoadmap(c).progress).toBeNull();
  });

  it('keeps unassigned items first, and numbers them as milestone 1', () => {
    // `groupByPhase` puts them first for a reason; numbering them last would
    // disagree with the order they render in.
    const c = curriculum({ phases, items: [technique('loose', null, { target_scored: 1 })] });
    const v = buildRoadmap(c);
    expect(v.milestones[0].title).toBe('Unassigned');
    expect(v.milestones[0].index).toBe(1);
    expect(v.milestones[1].title).toBe('Start Standing');
  });

  it('marks a lesson started on drilled evidence alone', () => {
    const c = curriculum({
      phases,
      items: [technique('a', 0, { target_drilled_sessions: 10 }, { drilled_sessions: 3 })],
    });
    const lesson = buildRoadmap(c).milestones[0].lessons[0];
    expect(lesson.started).toBe(true);
    expect(lesson.mastered).toBe(false);
  });

  it('gives a concept its authored heading rather than its name field', () => {
    const c = curriculum({ phases, items: [concept(1, 1, 'Position before submission')] });
    const lesson = buildRoadmap(c).milestones[1].lessons[0];
    expect(lesson.name).toBe('Position before submission');
    expect(lesson.measures).toBeNull();
    expect(lesson.techniqueID).toBeNull();
  });
});

describe('percent', () => {
  it('rounds off both ends rather than through them', () => {
    // 1 of 93 is 1.07% and rounds to 1 anyway; the guard is for the smaller
    // case — a single lesson out of 200 must not report 0% while it is done,
    // and 199 of 200 must not report 100% while one is left.
    expect(percent(0)).toBe(0);
    expect(percent(1)).toBe(100);
    expect(percent(0.001)).toBe(1);
    expect(percent(0.999)).toBe(99);
    expect(percent(0.5)).toBe(50);
  });
});
