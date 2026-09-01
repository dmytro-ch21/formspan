import { proposeFocus, proposeOneFocus } from '../roadmapFocus';
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
  id: n,
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
  read_at: null,
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

/** `curriculumIds` defaults to unclaimed — the ordinary hand-picked row, and
 *  also what a roadmap-matched row looks like BEFORE it has ever been
 *  applied. Pass the claiming curriculum id(s) to model a row `SetFocus` has
 *  already attributed. */
const focus = (id: string, curriculumIds: string[] = []): Focus => ({
  technique_id: id,
  name: id,
  position: 'Guard - Bottom',
  category: 'Sweep',
  started_on: '2026-01-01',
  curriculum_ids: curriculumIds,
});

/** A concept — authored text, no technique behind it at all. */
const concept = (title: string): CurriculumItem => ({
  id: n,
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
  read_at: null,
});

/** The roadmap under test throughout — a fixed id so `unchanged`'s claim
 *  check has something concrete to check against. A second, DIFFERENT id
 *  (ROADMAP_B) is what the N100 cases need. */
const ROADMAP_A = 'roadmap-a';
const ROADMAP_B = 'roadmap-b';

describe('what the roadmap puts in focus', () => {
  it('never proposes a concept — an idea cannot be a focus row', () => {
    const p = proposeFocus([concept('Position before submission'), step('a', false)], [], ROADMAP_A);
    expect(p.next).toEqual(['a']);
  });

  it('brings in unmastered steps, in roadmap order', () => {
    const p = proposeFocus([step('a', false), step('b', false)], [], ROADMAP_A);
    expect(p.next).toEqual(['a', 'b']);
    expect(p.added.map((i) => i.technique_id)).toEqual(['a', 'b']);
    expect(p.dropped).toEqual([]);
  });

  it('includes defence-only steps', () => {
    // Most of the brown syllabus. Keyed on `target_scored` rather than on
    // `criteria !== null`, the rule would drop every one of them and the belt
    // this feature was extended for would put nothing in focus.
    const p = proposeFocus([defenceOnly('guard-pull', false)], [], ROADMAP_A);
    expect(p.next).toEqual(['guard-pull']);
  });

  it('leaves reading items out', () => {
    const p = proposeFocus([reading('book'), step('a', false)], [], ROADMAP_A);
    expect(p.next).toEqual(['a']);
  });

  it('drops a mastered technique to make room for the next', () => {
    // The advance. Without it the loop never turns over.
    const p = proposeFocus([step('done', true), step('next', false)], [focus('done')], ROADMAP_A);
    expect(p.next).toEqual(['next']);
    expect(p.dropped).toEqual([{ focus: focus('done'), reason: 'mastered' }]);
  });
});

describe("what the athlete already had", () => {
  it('keeps hand-set techniques the roadmap has nothing to say about', () => {
    const p = proposeFocus([step('a', false)], [focus('mine')], ROADMAP_A);
    expect(p.next).toEqual(['a', 'mine']);
    expect(p.dropped).toEqual([]);
  });

  it('does not re-add an unmastered roadmap technique already in focus', () => {
    const p = proposeFocus([step('a', false)], [focus('a')], ROADMAP_A);
    expect(p.next).toEqual(['a']);
    expect(p.added).toEqual([]);
  });

  it('evicts the athlete’s own entries only when the cap forces it, and names them', () => {
    // The one case that destroys something they chose, so it has to be
    // reported rather than done quietly.
    const p = proposeFocus(
      [step('r1', false), step('r2', false), step('r3', false)],
      [focus('m1'), focus('m2'), focus('m3'), focus('m4'), focus('m5')],
      ROADMAP_A,
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
    const p = proposeFocus(many, [], ROADMAP_A, 5);
    expect(p.next).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('does not spend two slots on one technique', () => {
    // Without the `seen` guard this yields ['a','a'] — two of five slots on one
    // technique, and a list the server's own uniqueness would reject.
    const p = proposeFocus([step('a', false), step('b', false)], [focus('a')], ROADMAP_A, 2);
    expect(p.next).toEqual(['a', 'b']);
  });
});

describe('fromRoadmap', () => {
  // What the server attributes to this roadmap, and therefore what deactivating
  // it is allowed to delete. Getting this wrong in either direction is a bug
  // with a face: too wide deletes the athlete's own choices, too narrow leaves
  // the roadmap's techniques in the wizard after they switch it off (N95).
  it('names the roadmap steps and never the athlete-held entries beside them', () => {
    // `x` is the athlete's own, unrelated to the roadmap, kept by rule 3.
    const p = proposeFocus([step('a', false), step('b', false)], [focus('x')], ROADMAP_A);
    expect(p.next).toEqual(['a', 'b', 'x']);
    expect(p.fromRoadmap).toEqual(['a', 'b']);
  });

  it('claims a technique the athlete already held, so the roadmap can be one of its reasons', () => {
    // The both-sources case. The client names it; the SERVER is what refuses to
    // take ownership of a row already marked as the athlete's, so naming it here
    // is safe — and necessary, because a second roadmap wanting the same
    // technique must be able to register its own claim or deactivating the first
    // takes the technique away from it.
    const p = proposeFocus([step('a', false)], [focus('a'), focus('x')], ROADMAP_A);
    expect(p.fromRoadmap).toEqual(['a']);
  });

  it('is always a subset of next, so the cap cannot let it name an unsent id', () => {
    // The server rejects a fromRoadmap id that is not in technique_ids, so an
    // implementation reading the roadmap's items rather than `next` would 400
    // the moment the cap trimmed one.
    const many = Array.from({ length: 9 }, (_, i) => step(`t${i}`, false));
    const p = proposeFocus(many, [], ROADMAP_A, 5);
    expect(p.fromRoadmap).toEqual(p.next);
    expect(p.fromRoadmap).toHaveLength(5);
  });

  it('excludes a mastered roadmap technique, which is leaving rather than arriving', () => {
    const p = proposeFocus([step('a', true), step('b', false)], [focus('a')], ROADMAP_A);
    expect(p.next).toEqual(['b']);
    expect(p.fromRoadmap).toEqual(['b']);
  });
});

describe('unchanged', () => {
  it('is true only when the order matches too, not just the members', () => {
    // The wizard renders chips in this order, so a reshuffle is a real change.
    // Both entries already carry ROADMAP_A's claim — otherwise this would be
    // false for the claim reason covered below, not the order reason this
    // test is actually about.
    const items = [step('a', false), step('b', false)];
    const claimed = [focus('a', [ROADMAP_A]), focus('b', [ROADMAP_A])];
    const reordered = [focus('b', [ROADMAP_A]), focus('a', [ROADMAP_A])];
    expect(proposeFocus(items, claimed, ROADMAP_A).unchanged).toBe(true);
    expect(proposeFocus(items, reordered, ROADMAP_A).unchanged).toBe(false);
  });

  it('is true for a roadmap with nothing left to work and an empty list', () => {
    expect(proposeFocus([step('a', true)], [], ROADMAP_A).unchanged).toBe(true);
  });

  /**
   * N100. A technique already in focus is not by itself "nothing to do" —
   * only a technique already CLAIMED BY THIS ROADMAP is. Without this
   * distinction, a second roadmap whose techniques are already all in focus
   * (via a first roadmap, or by hand) reads as unchanged and its apply
   * control never appears, so it can never register its own claim — and a
   * later deactivation of whichever roadmap DID claim the technique takes it
   * out of focus while this one is still working it.
   */
  describe('claim awareness', () => {
    it('is false when the technique is in focus but claimed only by a DIFFERENT roadmap', () => {
      // 'a' is already in focus, claimed by ROADMAP_B, and ROADMAP_A's own
      // step for it is unmastered. The list would not change, but applying
      // still WRITES — it registers ROADMAP_A's own claim, which is a real
      // and grantable claim (a 'roadmap'-origin row can always gain a second
      // source) — so this must not read as unchanged.
      const p = proposeFocus([step('a', false)], [focus('a', [ROADMAP_B])], ROADMAP_A);
      expect(p.next).toEqual(['a']);
      expect(p.fromRoadmap).toEqual(['a']);
      expect(p.unchanged).toBe(false);
    });

    /**
     * N100.1. The case `alreadyClaims` alone gets wrong: 'a' is hand-picked
     * (or pre-provenance) — `curriculum_ids: []` — and ROADMAP_A's own step
     * for it overlaps. The server's claim INSERT is guarded by
     * `origin = 'roadmap'`, so it will REFUSE this claim on every single
     * apply, forever. Before `isUnclaimable`, this read as unchanged:false
     * permanently: the apply control never went away, applying it never
     * changed anything, and a fresh GET still showed `curriculum_ids: []`.
     * That is the exact bug frontend-reviewer found in this file's
     * `unchanged` clause — this test is the regression guard for it.
     */
    it('is true (not permanent noise) when the overlapping technique is hand-picked and unclaimable', () => {
      const p = proposeFocus([step('a', false)], [focus('a')], ROADMAP_A);
      expect(p.next).toEqual(['a']);
      expect(p.fromRoadmap).toEqual(['a']);
      expect(p.unchanged).toBe(true);
    });

    it("is true once this roadmap's own claim is registered", () => {
      const p = proposeFocus([step('a', false)], [focus('a', [ROADMAP_A])], ROADMAP_A);
      expect(p.unchanged).toBe(true);
    });

    it('the second of two overlapping roadmaps sees unchanged:false until it applies, then true', () => {
      // The product scenario, end to end. Roadmap A is already applied and
      // claims 'a'; roadmap B wants the same technique and has never claimed
      // it — B must be offered the apply control...
      const beforeB = proposeFocus([step('a', false)], [focus('a', [ROADMAP_A])], ROADMAP_B);
      expect(beforeB.unchanged).toBe(false);
      expect(beforeB.fromRoadmap).toEqual(['a']);

      // ...and once B applies (the server attributes `fromRoadmap` to B, per
      // the SAME `next`), a fresh read carries BOTH claims, and B now agrees
      // nothing is left to do — the control does not become permanent noise.
      const afterB = proposeFocus(
        [step('a', false)],
        [focus('a', [ROADMAP_A, ROADMAP_B])],
        ROADMAP_B,
      );
      expect(afterB.unchanged).toBe(true);

      // And A still agrees nothing is left to do either — applying B never
      // disturbed A's own claim.
      const stillA = proposeFocus(
        [step('a', false)],
        [focus('a', [ROADMAP_A, ROADMAP_B])],
        ROADMAP_A,
      );
      expect(stillA.unchanged).toBe(true);
    });

    // `focus('a')` above (default `curriculum_ids: []`) stands in for BOTH
    // 'athlete'-origin (hand-picked) and 'unknown'-origin (pre-provenance,
    // predating the `origin` column) rows — the client cannot tell those two
    // apart and does not need to: both give `curriculum_ids: []`, and the
    // server refuses a roadmap claim on either one identically (its guard is
    // `origin = 'roadmap'`, and neither 'athlete' nor 'unknown' is that). So
    // this one case covers both provenances by construction, not by omission.

    it('a hand-picked entry outside the roadmap is never required to carry a claim', () => {
      // 'x' is not part of ROADMAP_A's items at all (rule 3 — it is kept, not
      // claimed), so its empty curriculum_ids must never make this false.
      const p = proposeFocus([step('a', false)], [focus('a', [ROADMAP_A]), focus('x')], ROADMAP_A);
      expect(p.unchanged).toBe(true);
      expect(p.fromRoadmap).toEqual(['a']);
    });
  });

  /**
   * A server that has not yet deployed this field is a real rollout skew,
   * not a hypothetical — `fetchFocus` normalises the top-level `focus`
   * array (`?? []`) but not this per-row one. Without the `?? []` guards in
   * `alreadyClaims`/`isUnclaimable`, a missing `curriculum_ids` throws
   * `TypeError: Cannot read properties of undefined` the moment the athlete
   * opens the overflow menu on a roadmap that overlaps ANY existing focus
   * row — not a rare path.
   */
  describe('a curriculum_ids the server has not started sending yet', () => {
    it('does not throw, and treats the row as unclaimable rather than already claimed', () => {
      const undocumented = { ...focus('a') } as Focus;
      // @ts-expect-error — simulating a server response older than this field.
      delete undocumented.curriculum_ids;
      expect(() => proposeFocus([step('a', false)], [undocumented], ROADMAP_A)).not.toThrow();
      const p = proposeFocus([step('a', false)], [undocumented], ROADMAP_A);
      expect(p.unchanged).toBe(true);
    });
  });
});

/**
 * The single-technique form — what "work on this" does from an expanded lesson.
 *
 * The distinction from `proposeFocus` is the whole reason it exists: the
 * athlete named ONE thing, so nothing else may ride in behind it, and nothing
 * is retired for being mastered either. Same wholesale-replacement endpoint, so
 * the same stakes.
 */
describe('proposeOneFocus', () => {
  it('adds only the one named, and keeps everything already there', () => {
    const items = [step('a', false), step('b', false), step('c', false)];
    const p = proposeOneFocus(items, [focus('z')], ROADMAP_A, 'b');
    expect(p.next).toEqual(['b', 'z']);
    expect(p.added.map((i) => i.technique_id)).toEqual(['b']);
    // 'a' and 'c' are unmastered roadmap steps and are still NOT pulled in.
    expect(p.next).not.toContain('a');
  });

  it('puts the chosen technique first, so the cap cannot silently refuse it', () => {
    // Appended, a sixth pick is the one dropped — the button would report
    // success and change nothing.
    const held = ['v', 'w', 'x', 'y', 'z'].map((id) => focus(id));
    const p = proposeOneFocus([step('a', false)], held, ROADMAP_A, 'a');
    expect(p.next[0]).toBe('a');
    expect(p.next).toHaveLength(5);
    expect(p.dropped.map((d) => d.focus.technique_id)).toEqual(['z']);
  });

  it('calls anything it displaces evicted, never mastered', () => {
    // Nothing is being retired for being finished here, so `mastered` would be
    // a false explanation of a loss the athlete should be asked about.
    const held = ['v', 'w', 'x', 'y', 'z'].map((id) => focus(id));
    const p = proposeOneFocus([step('a', false)], held, ROADMAP_A, 'a');
    expect(p.dropped.every((d) => d.reason === 'evicted')).toBe(true);
  });

  it('moves it to the front when it is in focus lower down', () => {
    const p = proposeOneFocus([step('b', false)], [focus('a'), focus('b')], ROADMAP_A, 'b');
    expect(p.next).toEqual(['b', 'a']);
    expect(p.unchanged).toBe(false);
    // Already held, so this is a reorder rather than an addition.
    expect(p.added).toEqual([]);
  });

  it('attributes only the roadmap ids, never the athlete\'s own', () => {
    // `fromRoadmap` is what the roadmap may later take back. Naming a
    // hand-picked technique here would let deactivating this roadmap delete it.
    const p = proposeOneFocus([step('a', false)], [focus('mine')], ROADMAP_A, 'a');
    expect(p.next).toEqual(['a', 'mine']);
    expect(p.fromRoadmap).toEqual(['a']);
  });

  /** N100, single-technique form. Same claim-awareness rule as `proposeFocus`. */
  describe('claim awareness', () => {
    it('is false when it is already in focus, claimed only by a DIFFERENT roadmap', () => {
      const p = proposeOneFocus(
        [step('a', false)],
        [focus('a', [ROADMAP_B]), focus('b')],
        ROADMAP_A,
        'a',
      );
      expect(p.unchanged).toBe(false);
      expect(p.added).toEqual([]);
      expect(p.fromRoadmap).toEqual(['a']);
    });

    it('is true once this roadmap already claims it, in the same place', () => {
      const p = proposeOneFocus(
        [step('a', false)],
        [focus('a', [ROADMAP_A]), focus('b')],
        ROADMAP_A,
        'a',
      );
      expect(p.unchanged).toBe(true);
      expect(p.added).toEqual([]);
    });

    /** N100.1, single-technique form. Same regression as `proposeFocus`'s
     *  "hand-picked and unclaimable" case above — 'a' is already in focus
     *  in the right place, but hand-picked (`curriculum_ids: []`), so the
     *  server will never grant ROADMAP_A a claim on it. Without
     *  `isUnclaimable` this is `unchanged: false` forever, and "Work on
     *  this" from the lesson never stops offering a write that does
     *  nothing. */
    it('is true (not permanent noise) when it is already in focus, in the same place, but hand-picked', () => {
      const p = proposeOneFocus([step('a', false)], [focus('a'), focus('b')], ROADMAP_A, 'a');
      expect(p.unchanged).toBe(true);
      expect(p.added).toEqual([]);
      expect(p.fromRoadmap).toEqual(['a']);
    });
  });
});
