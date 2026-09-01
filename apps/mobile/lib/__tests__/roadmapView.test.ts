import type { Criteria, Curriculum, CurriculumItem, Progress } from '@/lib/curriculum';
import {
  buildRoadmap,
  evidenceNoteOf,
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
    id: 0,
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
    // A technique's read_at is always null — see Item.Read's doc comment on
    // the Go side. Tests that need a non-null id or a read concept override
    // this explicitly, below.
    read_at: null,
  };
}

function concept(
  order: number,
  phase: number | null,
  title: string,
  opts: { id?: number; readAt?: string | null } = {},
): CurriculumItem {
  return {
    id: opts.id ?? order,
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
    read_at: opts.readAt ?? null,
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
    concept_items: 0,
    read_concepts: 0,
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

  // N123 — "read and understood" is the athlete's own claim, and this is the
  // one place the wire's `read_at` becomes the screen's `read`/`itemID`.
  it('carries the item id through as itemID, for the read toggle to send back', () => {
    const c = curriculum({
      phases,
      items: [concept(1, 1, 'Position before submission', { id: 42 })],
    });
    const lesson = buildRoadmap(c).milestones[1].lessons[0];
    expect(lesson.itemID).toBe(42);
  });

  it('reads a concept as read from a non-null read_at, and unread from null', () => {
    const c = curriculum({
      phases,
      items: [
        concept(1, 0, 'Read this', { readAt: '2026-08-30T12:00:00Z' }),
        concept(2, 0, 'Not yet', { readAt: null }),
      ],
    });
    const [read, unread] = buildRoadmap(c).milestones[0].lessons;
    expect(read.read).toBe(true);
    expect(unread.read).toBe(false);
  });

  it('never reports a technique lesson as read, whatever read_at says', () => {
    // Defence in depth: the backend guarantees a technique's read_at is
    // always null (curriculum_item_reads_concept_only_trg), but this is the
    // one place a malformed payload would surface, and the assertion is
    // cheap insurance against that guarantee ever being read wrong here.
    const malformed: CurriculumItem = {
      ...technique('armbar', 0, { target_scored: 1 }),
      read_at: '2026-08-30T12:00:00Z',
    };
    const c = curriculum({ phases, items: [malformed] });
    const lesson = buildRoadmap(c).milestones[0].lessons[0];
    // `measures` still renders — read state must never gate or replace the
    // technique's own derived progress display.
    expect(lesson.measures).not.toBeNull();
    expect(lesson.read).toBe(false);
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

/**
 * N122 — "I activated a roadmap and added the counts of how many times I have
 * done each, and none got counted towards the roadmap."
 *
 * The backend was measured correct: enrol through the real repository, log
 * `drilled` and `scored` tags, and `GET /v1/curricula/{id}` returns
 * `drilled_sessions: 1, scored: 3` against the right item. What the athlete
 * could not see is the part these cover — 61 of white belt's 81 technique
 * items are measured on LIVE rounds, so drilling them produced evidence the
 * payload carried and the screen drew nowhere, under a state line reading
 * "your record has evidence for this".
 *
 * Each assertion here fails when `evidenceNoteOf` is deleted or its guards are
 * inverted; mutation-checked one at a time.
 */
describe('what would count — the drilled-against-a-live-criterion explanation', () => {
  const phases = [{ order: 0, title: 'Start Standing', description: 'Begin safely.' }];

  it('says what was drilled and what would move a live-measured item', () => {
    const item = technique(
      'armbar',
      0,
      { target_scored: 12, target_sessions: 10, min_hit_rate: 0.3 },
      { drilled_sessions: 9 },
    );
    expect(evidenceNoteOf(item, true)).toBe(
      'Drilled in 9 classes. Drilling is not counted here — to move this one, land it in a live round.',
    );
  });

  it('names both halves when the item also measures defence', () => {
    const item = technique(
      'guard-pull-defence',
      0,
      { target_scored: 12, target_defended: 4 },
      { drilled_sessions: 1 },
    );
    expect(evidenceNoteOf(item, true)).toContain('land it in a live round, or stop theirs');
  });

  it('says "stop theirs" alone where there is no offensive half', () => {
    const item = technique('stop-the-pass', 0, { target_defended: 8 }, { drilled_sessions: 2 });
    expect(evidenceNoteOf(item, true)).toContain('stop theirs in a live round');
  });

  it('singularises one class rather than saying "1 classes"', () => {
    const item = technique('armbar', 0, { target_scored: 12 }, { drilled_sessions: 1 });
    expect(evidenceNoteOf(item, true)).toContain('Drilled in 1 class.');
    expect(evidenceNoteOf(item, true)).not.toContain('1 classes');
  });

  it('stays silent where drilling DOES count — the measure already shows it', () => {
    const item = technique(
      'breakfall',
      0,
      { target_drilled_sessions: 8 },
      { drilled_sessions: 3 },
    );
    // Contradicting "Classes drilled in 3 / 8" directly above it would be worse
    // than saying nothing.
    expect(evidenceNoteOf(item, true)).toBeNull();
  });

  it('explains a drilled-only item worked purely through live evidence (N206)', () => {
    // The bug this covers: a focus technique whose only criterion is
    // `target_drilled_sessions` (a breakfall) is worked exclusively through
    // the live Missed/Landed/Stopped-theirs counters — the drilled-step
    // picker is a separate, slower control nobody has a reason to reach for.
    // Before N206's backfill in `bumpTechniqueOutcome`, that left
    // `drilled_sessions` at 0 forever, with a bare unexplained "0/6" — this is
    // the one case `measuresOf` alone cannot make legible.
    const item = technique(
      'breakfall',
      0,
      { target_drilled_sessions: 6 },
      { drilled_sessions: 0, scored: 5 },
    );
    expect(evidenceNoteOf(item, true)).toBe(
      'You have live evidence for this, but it counts classes drilled — log it on "What did you drill?" to move it.',
    );
  });

  it('also fires from defended-only evidence, not just scored', () => {
    // The note's wording is generic ("live evidence"), not "Landed…" — it
    // has to be true whichever of scored/attempts/defended is what actually
    // moved, and "Stopped theirs" (defended) is a live counter too.
    const item = technique(
      'breakfall',
      0,
      { target_drilled_sessions: 6 },
      { drilled_sessions: 0, defended: 3 },
    );
    expect(evidenceNoteOf(item, true)).toBe(
      'You have live evidence for this, but it counts classes drilled — log it on "What did you drill?" to move it.',
    );
  });

  it('also fires from attempts-only evidence, not just scored or defended', () => {
    // The third of the three live counters — every one of `scored`,
    // `attempts` and `defended` has to independently keep the guard from
    // returning null, or a Missed-only session (attempted but never landed
    // or got stopped) would silently go back to the pre-N206 bare "0/6".
    const item = technique(
      'breakfall',
      0,
      { target_drilled_sessions: 6 },
      { drilled_sessions: 0, attempts: 2 },
    );
    expect(evidenceNoteOf(item, true)).toBe(
      'You have live evidence for this, but it counts classes drilled — log it on "What did you drill?" to move it.',
    );
  });

  it('does not fire the N206 explanation on a mixed-criteria item — it would contradict measuresOf', () => {
    // Guard added as a hardening follow-up to N206: an item that carries
    // `target_drilled_sessions` ALONGSIDE `target_scored` (or `target_defended`
    // / `min_hit_rate`) already has its live evidence counted by `measuresOf`
    // toward that other criterion, one line above this note. Firing the
    // drilled-only explanation here would tell the athlete their scored
    // evidence "counts classes drilled" while the measure right above says it
    // counts toward "Landed live" instead — a direct contradiction. Today's
    // seed data has no such item (58 drilled-criterion items are all
    // drilled-only), but nothing in the schema forbids authoring one via
    // admin `/content`.
    const item = technique(
      'mixed-criteria-item',
      0,
      { target_drilled_sessions: 6, target_scored: 12 },
      { drilled_sessions: 0, scored: 5 },
    );
    expect(evidenceNoteOf(item, true)).toBeNull();
  });

  it('does not invent the N206 explanation with no evidence of any kind', () => {
    const item = technique(
      'breakfall',
      0,
      { target_drilled_sessions: 6 },
      { drilled_sessions: 0, scored: 0, attempts: 0, defended: 0 },
    );
    expect(evidenceNoteOf(item, true)).toBeNull();
  });

  it('does not contradict the measure once drilled evidence exists too, even alongside live evidence (N206)', () => {
    // Not just "drilled_sessions > 0 alone" (the earlier test above covers
    // that) — this is the case N206's fix could have broken: an item with
    // BOTH some drilled evidence AND live evidence. `measuresOf` already
    // draws "Classes drilled in 2 / 6" for this one; the live-evidence
    // explanation firing anyway would contradict the number directly above
    // it, which is exactly what the branch order exists to prevent.
    const item = technique(
      'breakfall',
      0,
      { target_drilled_sessions: 6 },
      { drilled_sessions: 2, scored: 5 },
    );
    expect(evidenceNoteOf(item, true)).toBeNull();
  });

  it('stays silent with no drilled evidence — there is no shortfall to invent', () => {
    const item = technique('armbar', 0, { target_scored: 12 }, { drilled_sessions: 0 });
    expect(evidenceNoteOf(item, true)).toBeNull();
  });

  it('stays silent for a concept, which is not a measurable that failed', () => {
    expect(evidenceNoteOf(concept(0, 0, 'Position before submission'), true)).toBeNull();
  });

  it('stays silent for a MALFORMED concept that somehow carries criteria', () => {
    // The ordinary concept path is covered above and exits on `criteria: null`,
    // so it says nothing about the kind guard. This one has both, which the
    // schema's `curriculum_items_kind_shape` forbids — and that is the point:
    // the guard exists so this function is correct on its own terms rather
    // than only while a constraint in another file holds.
    const malformed: CurriculumItem = {
      ...concept(0, 0, 'Position before submission'),
      criteria: { ...NO_CRITERIA, target_scored: 12 },
      progress: { ...NO_PROGRESS, drilled_sessions: 5 },
    };
    expect(evidenceNoteOf(malformed, true)).toBeNull();
  });

  it('stays silent when not enrolled — nothing is being counted at all', () => {
    const item = technique('armbar', 0, { target_scored: 12 }, { drilled_sessions: 9 });
    expect(evidenceNoteOf(item, false)).toBeNull();
  });

  it('keeps reporting the drilling once live evidence arrives', () => {
    // "Landed live 2 / 12, drilled in 9 classes" is the athlete's real
    // position. Hiding the drilling at the first round would make the note
    // vanish exactly when it starts being encouraging.
    const item = technique(
      'armbar',
      0,
      { target_scored: 12 },
      { drilled_sessions: 9, scored: 2, attempts: 5 },
    );
    expect(evidenceNoteOf(item, true)).toContain('Drilled in 9 classes');
  });

  it('reaches the lesson the screen actually draws', () => {
    const c = curriculum({
      phases,
      items: [technique('armbar', 0, { target_scored: 12 }, { drilled_sessions: 4 })],
    });
    const lesson = buildRoadmap(c).milestones[0].lessons[0];
    expect(lesson.evidenceNote).toContain('Drilled in 4 classes');
    // The measures themselves are untouched: the criteria did not soften and
    // nothing became tickable. This is the invariant migration 000034 states.
    expect(lesson.measures).toEqual([
      { label: 'Landed live', need: '12', have: '0', met: false },
    ]);
    expect(lesson.mastered).toBe(false);
  });
});
