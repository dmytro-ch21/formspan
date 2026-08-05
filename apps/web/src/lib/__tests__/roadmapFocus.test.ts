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
  technique_id: id,
  name: id,
  position: "Guard - Bottom",
  category: "Sweep",
  order: n++,
  notes: "",
  criteria: {
    target_scored: 25,
    target_defended: 8,
    target_sessions: 12,
    min_hit_rate: 0.35,
  },
  progress: {
    scored: 0,
    defended: 0,
    sessions: 0,
    attempts: 0,
    hit_rate: null,
    mastered,
  },
});

/** An item with no criteria — something to study, not to work. */
const reading = (id: string): CurriculumItem => ({
  ...step(id, false),
  criteria: null,
  progress: null,
});

const focus = (id: string): BjjFocus => ({
  technique_id: id,
  name: id,
  position: "Guard - Bottom",
  category: "Sweep",
  started_on: "2026-01-01",
});

const ids = (list: { technique_id: string }[]) => list.map((x) => x.technique_id);

describe("what the roadmap puts in focus", () => {
  it("brings in unmastered steps, in roadmap order", () => {
    // Order is the content of a syllabus — someone put the retention before the
    // sweep on purpose — so this asserts the sequence, not the set.
    const p = proposeFocus([step("a", false), step("b", false)], []);
    expect(p.next).toEqual(["a", "b"]);
    expect(ids(p.added)).toEqual(["a", "b"]);
    expect(p.dropped).toEqual([]);
  });

  it("leaves reading items out entirely", () => {
    // An item with no criteria is something to study. Focus exists to capture
    // live outcomes, so putting a reading entry there is a category error — and
    // it would spend one of five slots on something nothing can complete.
    const p = proposeFocus([reading("book"), step("a", false)], []);
    expect(p.next).toEqual(["a"]);
  });

  it("drops a mastered technique to make room for the next", () => {
    // THE ADVANCE. Without this the loop never turns over: a finished technique
    // holds its slot forever and the roadmap stops feeding the wizard.
    const p = proposeFocus(
      [step("done", true), step("next", false)],
      [focus("done")],
    );
    expect(p.next).toEqual(["next"]);
    expect(p.dropped).toEqual([{ focus: focus("done"), reason: "mastered" }]);
  });
});

describe("what the athlete already had", () => {
  it("keeps hand-set techniques the roadmap has nothing to say about", () => {
    // The roadmap is not entitled to the whole list. Someone working an armbar
    // alongside a syllabus keeps the armbar.
    const p = proposeFocus([step("a", false)], [focus("mine")]);
    expect(p.next).toEqual(["a", "mine"]);
    expect(p.dropped).toEqual([]);
  });

  it("keeps an unmastered roadmap technique already in focus, without re-adding it", () => {
    const p = proposeFocus([step("a", false)], [focus("a")]);
    expect(p.next).toEqual(["a"]);
    // Not "added" — it was already there, and reporting it as new would make
    // the UI claim it did something it did not.
    expect(p.added).toEqual([]);
    expect(p.unchanged).toBe(true);
  });

  it("evicts the athlete's own entries only when the cap forces it, and names them", () => {
    // The one case that destroys something the athlete chose. It has to be
    // reported so the UI can say which, rather than quietly doing it.
    const p = proposeFocus(
      [step("r1", false), step("r2", false), step("r3", false)],
      [focus("m1"), focus("m2"), focus("m3"), focus("m4"), focus("m5")],
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
    // and the wizard would be back to searching 466 entries.
    const many = Array.from({ length: 9 }, (_, i) => step(`t${i}`, false));
    const p = proposeFocus(many, [], 5);
    expect(p.next).toHaveLength(5);
    expect(p.next).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("does not double-count a technique that is both in the roadmap and in focus", () => {
    // Without the `seen` guard this yields ["a","a"], which spends two slots on
    // one technique and sends a list the server's own uniqueness would reject.
    const p = proposeFocus([step("a", false), step("b", false)], [focus("a")], 2);
    expect(p.next).toEqual(["a", "b"]);
  });
});

describe("unchanged", () => {
  it("is true only when the order matches too, not just the members", () => {
    // Order is the athlete's ranking and the wizard renders the chips in it, so
    // a reshuffle is a real change. Comparing as sets would offer a button that
    // silently reorders — or claim nothing happened when something did.
    const items = [step("a", false), step("b", false)];
    expect(proposeFocus(items, [focus("a"), focus("b")]).unchanged).toBe(true);
    expect(proposeFocus(items, [focus("b"), focus("a")]).unchanged).toBe(false);
  });

  it("is false when there is nothing in focus and something to add", () => {
    expect(proposeFocus([step("a", false)], []).unchanged).toBe(false);
  });

  it("is true for a roadmap with nothing left to work and an empty list", () => {
    // Everything mastered: there is no next, and the UI must say so rather than
    // offering an action that writes an identical list.
    expect(proposeFocus([step("a", true)], []).unchanged).toBe(true);
  });
});
