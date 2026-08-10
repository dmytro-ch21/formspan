import { proposeFocus } from '../roadmapFocus';
import type { Focus } from '../bjjFocus';
import type { CurriculumItem } from '../curriculum';

/**
 * The roadmap→focus bridge, mobile copy.
 *
 * **Why it is tested twice.** `apps/web` holds the same rule against the same
 * endpoint, with its own test. Duplicating the test alongside the duplicated
 * rule is the only thing that keeps the two honest: a fix applied to one copy
 * and not the other is the exact drift the Brand components produced, and there
 * it took a checker to catch. Here the two files cannot be byte-compared —
 * different type names, different imports — so the guard has to be behavioural.
 *
 * Every case was checked by breaking the rule it covers and confirming it went
 * red. What is at stake: `PUT /v1/bjj/focus` replaces the list wholesale, so a
 * wrong branch deletes an athlete's own working set, and a shorter focus list
 * looks exactly like a focus list.
 */

let n = 0;

const step = (id: string, mastered: boolean): CurriculumItem => ({
  kind: 'technique',
  technique_id: id,
  name: id,
  position: 'Guard - Bottom',
  category: 'Sweep',
  order: n++,
  phase: null,
  notes: '',
  criteria: {
    target_scored: 25,
    target_defended: 8,
    target_sessions: 12,
    min_hit_rate: 0.35,
    target_drilled_sessions: null,
  },
  progress: {
    scored: 0,
    defended: 0,
    sessions: 0,
    attempts: 0,
    hit_rate: null,
    drilled_sessions: 0,
    mastered,
  },
});

/** No criteria — reading, not a roadmap step. */
const reading = (id: string): CurriculumItem => ({
  ...step(id, false),
  criteria: null,
  progress: null,
});

/** A defence-only step, which is six of the fourteen brown-belt items — so
 *  this is not an edge case, it is most of a syllabus. */
const defenceOnly = (id: string, mastered: boolean): CurriculumItem => ({
  ...step(id, mastered),
  criteria: {
    target_scored: null,
    target_defended: 18,
    target_sessions: 16,
    min_hit_rate: null,
    target_drilled_sessions: null,
  },
});

const focus = (id: string): Focus => ({
  technique_id: id,
  name: id,
  position: 'Guard - Bottom',
  category: 'Sweep',
  started_on: '2026-01-01',
});

/** A concept — authored text, no technique behind it at all. */
const concept = (title: string): CurriculumItem => ({
  kind: 'concept',
  title,
  name: '',
  position: '',
  category: '',
  order: n++,
  phase: null,
  notes: '',
  criteria: null,
  progress: null,
});

describe('what the roadmap puts in focus', () => {
  it('never proposes a concept — an idea cannot be a focus row', () => {
    const p = proposeFocus([concept('Position before submission'), step('a', false)], []);
    expect(p.next).toEqual(['a']);
  });

  it('brings in unmastered steps, in roadmap order', () => {
    const p = proposeFocus([step('a', false), step('b', false)], []);
    expect(p.next).toEqual(['a', 'b']);
    expect(p.added.map((i) => i.technique_id)).toEqual(['a', 'b']);
    expect(p.dropped).toEqual([]);
  });

  it('includes defence-only steps', () => {
    // Most of the brown syllabus. Keyed on `target_scored` rather than on
    // `criteria !== null`, the rule would drop every one of them and the belt
    // this feature was extended for would put nothing in focus.
    const p = proposeFocus([defenceOnly('guard-pull', false)], []);
    expect(p.next).toEqual(['guard-pull']);
  });

  it('leaves reading items out', () => {
    const p = proposeFocus([reading('book'), step('a', false)], []);
    expect(p.next).toEqual(['a']);
  });

  it('drops a mastered technique to make room for the next', () => {
    // The advance. Without it the loop never turns over.
    const p = proposeFocus([step('done', true), step('next', false)], [focus('done')]);
    expect(p.next).toEqual(['next']);
    expect(p.dropped).toEqual([{ focus: focus('done'), reason: 'mastered' }]);
  });
});

describe("what the athlete already had", () => {
  it('keeps hand-set techniques the roadmap has nothing to say about', () => {
    const p = proposeFocus([step('a', false)], [focus('mine')]);
    expect(p.next).toEqual(['a', 'mine']);
    expect(p.dropped).toEqual([]);
  });

  it('does not re-add an unmastered roadmap technique already in focus', () => {
    const p = proposeFocus([step('a', false)], [focus('a')]);
    expect(p.next).toEqual(['a']);
    expect(p.added).toEqual([]);
    expect(p.unchanged).toBe(true);
  });

  it('evicts the athlete’s own entries only when the cap forces it, and names them', () => {
    // The one case that destroys something they chose, so it has to be
    // reported rather than done quietly.
    const p = proposeFocus(
      [step('r1', false), step('r2', false), step('r3', false)],
      [focus('m1'), focus('m2'), focus('m3'), focus('m4'), focus('m5')],
      5,
    );
    expect(p.next).toEqual(['r1', 'r2', 'r3', 'm1', 'm2']);
    expect(p.dropped.map((d) => d.focus.technique_id)).toEqual(['m3', 'm4', 'm5']);
    expect(p.dropped.every((d) => d.reason === 'evicted')).toBe(true);
  });
});

describe('the cap', () => {
  it('never proposes more than the maximum', () => {
    const many = Array.from({ length: 9 }, (_, i) => step(`t${i}`, false));
    const p = proposeFocus(many, [], 5);
    expect(p.next).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('does not spend two slots on one technique', () => {
    // Without the `seen` guard this yields ['a','a'] — two of five slots on one
    // technique, and a list the server's own uniqueness would reject.
    const p = proposeFocus([step('a', false), step('b', false)], [focus('a')], 2);
    expect(p.next).toEqual(['a', 'b']);
  });
});

describe('unchanged', () => {
  it('is true only when the order matches too, not just the members', () => {
    // The wizard renders chips in this order, so a reshuffle is a real change.
    const items = [step('a', false), step('b', false)];
    expect(proposeFocus(items, [focus('a'), focus('b')]).unchanged).toBe(true);
    expect(proposeFocus(items, [focus('b'), focus('a')]).unchanged).toBe(false);
  });

  it('is true for a roadmap with nothing left to work and an empty list', () => {
    expect(proposeFocus([step('a', true)], []).unchanged).toBe(true);
  });
});
