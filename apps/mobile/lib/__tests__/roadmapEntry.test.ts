import type { Criteria, Curriculum, CurriculumItem, Progress } from '@/lib/curriculum';
import { roadmapMilestone, roadmapToOffer } from '@/lib/roadmapEntry';

/**
 * N96's two decisions, covered here because the screens that make them cannot
 * be reached — Today pulls Clerk, sync, SQLite and half the router through one
 * render, which is exactly why `todayDaySwitcher.test.tsx` covers Today's
 * arithmetic rather than Today.
 *
 * Every case below was mutation-checked against the implementation: the
 * off-by-one, the denominator, `nextStep` versus the first unmastered item, the
 * `official` filter, the enrolled filter and the countable filter each go red
 * when the line they cover is changed. The fixtures are built so that no
 * default IS the guard — the F7 case sets `official` explicitly, and the
 * "counts steps, not reading" case is arranged so a wrong implementation
 * returns a DIFFERENT number rather than the same one by luck.
 */

const CRITERIA: Criteria = {
  target_scored: 10,
  target_defended: null,
  target_sessions: 5,
  min_hit_rate: null,
  target_drilled_sessions: null,
};

const PROGRESS = (mastered: boolean): Progress => ({
  scored: mastered ? 10 : 0,
  defended: 0,
  sessions: mastered ? 5 : 0,
  attempts: mastered ? 10 : 0,
  hit_rate: null,
  drilled_sessions: 0,
  mastered,
});

let n = 0;

/** A countable step: it has criteria, so it can be mastered. */
const step = (phase: number | null, mastered: boolean): CurriculumItem => ({
  kind: 'technique',
  technique_id: `t${(n += 1)}`,
  name: `Technique ${n}`,
  position: 'guard',
  category: 'sweep',
  order: n,
  phase,
  notes: '',
  criteria: CRITERIA,
  progress: PROGRESS(mastered),
});

/**
 * A READING item: criteria null, so nothing can ever complete it.
 *
 * The distinction this file exists to protect. An implementation keyed on "the
 * first item without `progress.mastered`" picks one of these up and pins the
 * athlete to a milestone they finished — the `countable_items` versus
 * `item_count` confusion, one level up.
 */
const reading = (phase: number | null): CurriculumItem => ({
  ...step(phase, false),
  criteria: null,
  progress: null,
});

const roadmap = (over: Partial<Curriculum>): Curriculum =>
  ({
    id: over.id ?? 'r',
    name: over.name ?? 'Roadmap',
    description: '',
    belt: over.belt ?? null,
    track: over.track ?? 'belt',
    editable: false,
    official: over.official ?? true,
    visibility: 'public',
    enrolled: over.enrolled ?? true,
    started_on: '2026-01-01',
    item_count: over.item_count ?? 0,
    countable_items: over.countable_items ?? 0,
    mastered_items: over.mastered_items ?? 0,
    phases: over.phases,
    items: over.items,
  }) as Curriculum;

const phases = (...titles: string[]) =>
  titles.map((title, order) => ({ order, title, description: '' }));

describe('roadmapMilestone', () => {
  it('numbers from one, and against the phase count', () => {
    // Third phase of four. Both halves matter: `phase` is a zero-based index,
    // so returning it raw says "Milestone 2", and the denominator is the
    // phase count rather than the item count, which is 5 here on purpose.
    const got = roadmapMilestone(
      roadmap({
        phases: phases('Stand up', 'Pass', 'Understand guard', 'Escape'),
        items: [
          step(0, true),
          step(0, true),
          step(1, true),
          step(2, false),
          step(3, false),
        ],
      }),
    );
    expect(got).toEqual({ number: 3, of: 4, title: 'Understand guard' });
  });

  it('follows the first unmastered STEP, never the first unmastered item', () => {
    // Phase one is finished: its only countable step is mastered, and the two
    // reading items in it can never be anything else. An implementation that
    // scanned items rather than steps stops here and reports milestone 1.
    const got = roadmapMilestone(
      roadmap({
        phases: phases('Ideas first', 'Now do it'),
        items: [reading(0), step(0, true), reading(0), step(1, false)],
      }),
    );
    expect(got?.number).toBe(2);
    expect(got?.title).toBe('Now do it');
  });

  it('is null once every step is mastered', () => {
    // A finished roadmap has no position in itself. "Milestone 4 of 4" would
    // report the athlete as standing somewhere in something that is over, and
    // the caller has its own sentence for this.
    expect(
      roadmapMilestone(
        roadmap({ phases: phases('a', 'b'), items: [step(0, true), step(1, true)] }),
      ),
    ).toBeNull();
  });

  it('is null on a roadmap with no phases', () => {
    // Every curriculum predating phases is legally unphased. Not a defect, and
    // it must not be given a number.
    expect(roadmapMilestone(roadmap({ phases: [], items: [step(null, false)] }))).toBeNull();
    expect(roadmapMilestone(roadmap({ items: [step(null, false)] }))).toBeNull();
  });

  it('is null when the next step is unphased', () => {
    // A MIXED curriculum: phases exist, and this item was never assigned to
    // one. `groupByPhase` renders it in a leading "Unassigned" group, so there
    // is genuinely no milestone to name.
    expect(
      roadmapMilestone(roadmap({ phases: phases('a', 'b'), items: [step(null, false)] })),
    ).toBeNull();
  });

  it('is null on a phase index outside the array, rather than reporting a wrong one', () => {
    // `phase` is an index into `phases` by contract, and the composite foreign
    // key makes a dangling one impossible today. Load-bearing the day a bug
    // ships one: reading `phases[7]` would throw, and clamping would name the
    // wrong phase with full confidence.
    for (const bad of [7, -1]) {
      expect(
        roadmapMilestone(roadmap({ phases: phases('a', 'b'), items: [step(bad, false)] })),
      ).toBeNull();
    }
  });

  it('reports milestone one for someone who has just enrolled', () => {
    // Nothing mastered, no progress rows at all — the state on the day you
    // take a roadmap on. This is the case Today shows most often.
    const fresh = roadmap({
      phases: phases('Survive first', 'Then attack'),
      items: [
        { ...step(0, false), progress: null },
        { ...step(1, false), progress: null },
      ],
    });
    expect(roadmapMilestone(fresh)).toEqual({
      number: 1,
      of: 2,
      title: 'Survive first',
    });
  });
});

describe('roadmapToOffer', () => {
  const offerable = (over: Partial<Curriculum>) =>
    roadmap({ enrolled: false, countable_items: 10, ...over });

  it('offers nothing at all for a list that has not been read', () => {
    // The distinction Today's `refreshRoadmaps` refuses to collapse: an
    // unreadable answer is not "you are on no roadmap". Offering one on the
    // strength of an offline read is a claim about the athlete.
    expect(roadmapToOffer(null)).toBeNull();
  });

  it('leads with foundations rather than the first belt', () => {
    const got = roadmapToOffer([
      offerable({ id: 'blue', belt: 'blue', track: 'belt' }),
      offerable({ id: 'white', belt: 'white', track: 'belt' }),
      offerable({ id: 'foundations', belt: null, track: 'foundations' }),
    ]);
    expect(got?.id).toBe('foundations');
  });

  it("never offers a stranger's public curriculum wearing a belt word", () => {
    // F7. `track` and `belt` are athlete-writable hints, so anyone can publish
    // a list claiming to be the white belt roadmap. `official` is the server's
    // own answer and the only thing separating the two — and an offer card is
    // a stronger endorsement than a strip tile, so this is the last place to
    // re-derive it by hand.
    const got = roadmapToOffer([
      offerable({ id: 'stranger', belt: 'white', track: 'belt', official: false }),
      offerable({ id: 'vola', belt: 'blue', track: 'belt' }),
    ]);
    expect(got?.id).toBe('vola');
  });

  it('never offers one the athlete is already on', () => {
    // The caller only reaches this with an empty working list, and the two can
    // legitimately disagree: `/curricula/working` drops an enrollment with
    // nothing completable in it, so "not working anything" is not "enrolled in
    // nothing".
    const got = roadmapToOffer([
      offerable({ id: 'started', belt: null, track: 'foundations', enrolled: true }),
      offerable({ id: 'fresh', belt: 'white', track: 'belt' }),
    ]);
    expect(got?.id).toBe('fresh');
  });

  it('never offers a list that finishes nothing', () => {
    // The card promises that logged sessions move it. A curriculum whose items
    // carry no criteria completes nothing, so offering one is the reading-
    // list-as-roadmap confusion `countable_items` exists to prevent.
    const got = roadmapToOffer([
      offerable({ id: 'reading', belt: null, track: 'foundations', countable_items: 0 }),
      offerable({ id: 'real', belt: 'white', track: 'belt' }),
    ]);
    expect(got?.id).toBe('real');
  });

  it('offers nothing when every candidate fails a filter', () => {
    // Not a crash and not a fallback to the least-bad row: the card renders
    // nothing, which is the honest answer on a deployment with no VOLA
    // roadmaps in it.
    expect(
      roadmapToOffer([
        offerable({ id: 'syllabus', belt: 'white', track: 'syllabus' }),
        offerable({ id: 'mine', belt: null, track: null }),
        offerable({ id: 'stranger', belt: 'white', track: 'belt', official: false }),
      ]),
    ).toBeNull();
  });
});
