import { describe, expect, it } from "vitest";

import type { BjjFocus, CurriculumItem } from "../api";
import { proposeFocus } from "../roadmapFocus";

/**
 * The roadmap→focus bridge.
 *
 * **Why this is the first test in `apps/web`.** `PUT /v1/bjj/focus` replaces the
 * list wholesale, so every branch here decides whether an athlete's own,
 * hand-picked working set survives. Getting the eviction rule wrong deletes
 * data the app never asked permission for — and the failure is silent, because
 * a shorter focus list looks exactly like a focus list.
 *
 * Every case below was checked by breaking the rule it covers and confirming it
 * went red. Where a case would pass against a mutation, it says so.
 */

let n = 0;

/** A roadmap step. `criteria` non-null is what makes it a step rather than
 *  reading — the distinction the whole feature turns on. */
const step = (id: string, mastered: boolean): CurriculumItem => ({
  kind: "technique",
  technique_id: id,
  name: id,
  position: "Guard - Bottom",
  category: "Sweep",
  order: n++,
  phase: null,
  notes: "",
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

/** An item with no criteria — something to study, not to work. */
const reading = (id: string): CurriculumItem => ({
  ...step(id, false),
  criteria: null,
  progress: null,
});

/** A concept — authored text, no technique behind it at all. */
const concept = (title: string): CurriculumItem => ({
  kind: "concept",
  title,
  name: "",
  position: "",
  category: "",
  order: n++,
  phase: null,
  notes: "",
  criteria: null,
  progress: null,
});

/** `curriculumIds` defaults to unclaimed — the ordinary hand-picked row, and
 *  also what a roadmap-matched row looks like BEFORE it has ever been
 *  applied. Pass the claiming curriculum id(s) to model a row `SetFocus` has
 *  already attributed. */
const focus = (id: string, curriculumIds: string[] = []): BjjFocus => ({
  technique_id: id,
  name: id,
  position: "Guard - Bottom",
  category: "Sweep",
  started_on: "2026-01-01",
  curriculum_ids: curriculumIds,
});

const ids = (list: { technique_id?: string }[]) => list.map((x) => x.technique_id);

/** The roadmap under test throughout — a fixed id so `unchanged`'s claim
 *  check has something concrete to check against. Which id it is never
 *  matters to any assertion; a second, DIFFERENT id (ROADMAP_B) is what the
 *  N100 cases below need. */
const ROADMAP_A = "roadmap-a";
const ROADMAP_B = "roadmap-b";

describe("what the roadmap puts in focus", () => {
  it("never proposes a concept — an idea cannot be a focus row", () => {
    const p = proposeFocus(
      [concept("Position before submission"), step("a", false)],
      [],
      ROADMAP_A,
    );
    expect(p.next).toEqual(["a"]);
    expect(ids(p.added)).toEqual(["a"]);
  });


  it("brings in unmastered steps, in roadmap order", () => {
    // Order is the content of a syllabus — someone put the retention before the
    // sweep on purpose — so this asserts the sequence, not the set.
    const p = proposeFocus([step("a", false), step("b", false)], [], ROADMAP_A);
    expect(p.next).toEqual(["a", "b"]);
    expect(ids(p.added)).toEqual(["a", "b"]);
    expect(p.dropped).toEqual([]);
  });

  it("leaves reading items out entirely", () => {
    // An item with no criteria is something to study. Focus exists to capture
    // live outcomes, so putting a reading entry there is a category error — and
    // it would spend one of five slots on something nothing can complete.
    const p = proposeFocus([reading("book"), step("a", false)], [], ROADMAP_A);
    expect(p.next).toEqual(["a"]);
  });

  it("drops a mastered technique to make room for the next", () => {
    // THE ADVANCE. Without this the loop never turns over: a finished technique
    // holds its slot forever and the roadmap stops feeding the wizard.
    const p = proposeFocus(
      [step("done", true), step("next", false)],
      [focus("done")],
      ROADMAP_A,
    );
    expect(p.next).toEqual(["next"]);
    expect(p.dropped).toEqual([{ focus: focus("done"), reason: "mastered" }]);
  });
});

describe("what the athlete already had", () => {
  it("keeps hand-set techniques the roadmap has nothing to say about", () => {
    // The roadmap is not entitled to the whole list. Someone working an armbar
    // alongside a syllabus keeps the armbar.
    const p = proposeFocus([step("a", false)], [focus("mine")], ROADMAP_A);
    expect(p.next).toEqual(["a", "mine"]);
    expect(p.dropped).toEqual([]);
  });

  it("keeps an unmastered roadmap technique already in focus, without re-adding it", () => {
    const p = proposeFocus([step("a", false)], [focus("a")], ROADMAP_A);
    expect(p.next).toEqual(["a"]);
    // Not "added" — it was already there, and reporting it as new would make
    // the UI claim it did something it did not.
    expect(p.added).toEqual([]);
  });

  it("evicts the athlete's own entries only when the cap forces it, and names them", () => {
    // The one case that destroys something the athlete chose. It has to be
    // reported so the UI can say which, rather than quietly doing it.
    const p = proposeFocus(
      [step("r1", false), step("r2", false), step("r3", false)],
      [focus("m1"), focus("m2"), focus("m3"), focus("m4"), focus("m5")],
      ROADMAP_A,
      5,
    );
    expect(p.next).toEqual(["r1", "r2", "r3", "m1", "m2"]);
    expect(p.dropped.map((d) => d.focus.technique_id)).toEqual(["m3", "m4", "m5"]);
    expect(p.dropped.every((d) => d.reason === "evicted")).toBe(true);
  });
});

describe("the cap", () => {
  it("never proposes more than the maximum", () => {
    // The bound IS the feature: a focus list of twenty is the library again,
    // and the wizard would be back to searching 542 entries.
    const many = Array.from({ length: 9 }, (_, i) => step(`t${i}`, false));
    const p = proposeFocus(many, [], ROADMAP_A, 5);
    expect(p.next).toHaveLength(5);
    expect(p.next).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("does not double-count a technique that is both in the roadmap and in focus", () => {
    // Without the `seen` guard this yields ["a","a"], which spends two slots on
    // one technique and sends a list the server's own uniqueness would reject.
    const p = proposeFocus([step("a", false), step("b", false)], [focus("a")], ROADMAP_A, 2);
    expect(p.next).toEqual(["a", "b"]);
  });
});

describe("fromRoadmap", () => {
  // What the server attributes to this roadmap, and therefore what deactivating
  // it is allowed to delete. Wrong in either direction is a bug with a face: too
  // wide deletes the athlete's own choices, too narrow leaves the roadmap's
  // techniques in the wizard after they switch it off (N95).
  it("names the roadmap steps and never the athlete-held entries beside them", () => {
    // `x` is the athlete's own, unrelated to the roadmap, kept by rule 3.
    const p = proposeFocus([step("a", false), step("b", false)], [focus("x")], ROADMAP_A);
    expect(p.next).toEqual(["a", "b", "x"]);
    expect(p.fromRoadmap).toEqual(["a", "b"]);
  });

  it("claims a technique the athlete already held, so the roadmap can be one of its reasons", () => {
    // The both-sources case. The client names it; the SERVER refuses to take
    // ownership of a row already marked as the athlete's, so naming it here is
    // safe — and necessary, because a second roadmap wanting the same technique
    // must be able to register its own claim.
    const p = proposeFocus([step("a", false)], [focus("a"), focus("x")], ROADMAP_A);
    expect(p.fromRoadmap).toEqual(["a"]);
  });

  it("is always a subset of next, so the cap cannot let it name an unsent id", () => {
    const many = Array.from({ length: 9 }, (_, i) => step(`t${i}`, false));
    const p = proposeFocus(many, [], ROADMAP_A, 5);
    expect(p.fromRoadmap).toEqual(p.next);
    expect(p.fromRoadmap).toHaveLength(5);
  });

  it("excludes a mastered roadmap technique, which is leaving rather than arriving", () => {
    const p = proposeFocus([step("a", true), step("b", false)], [focus("a")], ROADMAP_A);
    expect(p.next).toEqual(["b"]);
    expect(p.fromRoadmap).toEqual(["b"]);
  });
});

describe("unchanged", () => {
  it("is true only when the order matches too, not just the members", () => {
    // Order is the athlete's ranking and the wizard renders the chips in it, so
    // a reshuffle is a real change. Comparing as sets would offer a button that
    // silently reorders — or claim nothing happened when something did.
    //
    // Both entries already carry ROADMAP_A's claim — otherwise this would be
    // false for the claim reason covered below, not the order reason this test
    // is actually about.
    const items = [step("a", false), step("b", false)];
    const claimed = [focus("a", [ROADMAP_A]), focus("b", [ROADMAP_A])];
    const reordered = [focus("b", [ROADMAP_A]), focus("a", [ROADMAP_A])];
    expect(proposeFocus(items, claimed, ROADMAP_A).unchanged).toBe(true);
    expect(proposeFocus(items, reordered, ROADMAP_A).unchanged).toBe(false);
  });

  it("is false when there is nothing in focus and something to add", () => {
    expect(proposeFocus([step("a", false)], [], ROADMAP_A).unchanged).toBe(false);
  });

  it("is true for a roadmap with nothing left to work and an empty list", () => {
    // Everything mastered: there is no next, and the UI must say so rather than
    // offering an action that writes an identical list.
    expect(proposeFocus([step("a", true)], [], ROADMAP_A).unchanged).toBe(true);
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
  describe("claim awareness", () => {
    it("is false when the technique is in focus but this roadmap has never claimed it", () => {
      // The exact shape of the bug: 'a' is already in focus (say, hand-picked,
      // or claimed only by a DIFFERENT roadmap) and ROADMAP_A's own step for it
      // is unmastered. The list would not change, but applying still WRITES —
      // it registers ROADMAP_A's claim — so this must not read as unchanged.
      const p = proposeFocus([step("a", false)], [focus("a")], ROADMAP_A);
      expect(p.next).toEqual(["a"]);
      expect(p.fromRoadmap).toEqual(["a"]);
      expect(p.unchanged).toBe(false);
    });

    it("is true once this roadmap's own claim is registered", () => {
      const p = proposeFocus([step("a", false)], [focus("a", [ROADMAP_A])], ROADMAP_A);
      expect(p.unchanged).toBe(true);
    });

    it("the second of two overlapping roadmaps sees unchanged:false until it applies, then true", () => {
      // The product scenario, end to end. Roadmap A is already applied and
      // claims 'a'; roadmap B wants the same technique and has never claimed
      // it — B must be offered the apply control...
      const beforeB = proposeFocus([step("a", false)], [focus("a", [ROADMAP_A])], ROADMAP_B);
      expect(beforeB.unchanged).toBe(false);
      expect(beforeB.fromRoadmap).toEqual(["a"]);

      // ...and once B applies (the server attributes `fromRoadmap` to B, per
      // the SAME `next`), a fresh read carries BOTH claims, and B now agrees
      // nothing is left to do — the control does not become permanent noise.
      const afterB = proposeFocus(
        [step("a", false)],
        [focus("a", [ROADMAP_A, ROADMAP_B])],
        ROADMAP_B,
      );
      expect(afterB.unchanged).toBe(true);

      // And A still agrees nothing is left to do either — applying B never
      // disturbed A's own claim.
      const stillA = proposeFocus(
        [step("a", false)],
        [focus("a", [ROADMAP_A, ROADMAP_B])],
        ROADMAP_A,
      );
      expect(stillA.unchanged).toBe(true);
    });

    it("a hand-picked entry outside the roadmap is never required to carry a claim", () => {
      // 'x' is not part of ROADMAP_A's items at all (rule 3 — it is kept, not
      // claimed), so its empty curriculum_ids must never make this false.
      const p = proposeFocus([step("a", false)], [focus("a", [ROADMAP_A]), focus("x")], ROADMAP_A);
      expect(p.unchanged).toBe(true);
      expect(p.fromRoadmap).toEqual(["a"]);
    });
  });
});
