import { describe, expect, it } from "vitest";

import {
  GRIPS,
  emptySet,
  gripApplies,
  gripsFor,
  offeredGrips,
  type Grip,
  type LoggedSet,
} from "../api";

/**
 * Web's copy of the grip vocabulary.
 *
 * **These tests exist because the rule is duplicated three times** — Go's
 * `GripsFor`, mobile's `gripsFor`, and this one — with no shared package to put
 * it in. A comment asking the next person to update all three is not a
 * guarantee; a table pinned entry by entry is, because drift fails here rather
 * than shipping a picker that offers a grip the server will refuse or hides one
 * it would accept.
 *
 * The table below is written out longhand ON PURPOSE. Deriving it from
 * `gripsFor` would make these tests agree with whatever the function currently
 * says, which is the "a mock supplying the behaviour under test" mistake this
 * repo has shipped before.
 *
 * **Scope, precisely:** this file pins WEB's copy against a written-down table.
 * It cannot see Go or mobile drifting — that is `scripts/check-grip-parity.py`'s
 * job, and the two together are the guarantee. An earlier version of this
 * comment claimed drift "fails here", which was only ever true of one of the
 * three copies.
 */

const EXPECTED: Record<string, Grip[]> = {
  horizontal_push: ["regular", "neutral", "reverse", "angled"],
  horizontal_pull: ["regular", "neutral", "reverse", "angled"],
  vertical_push: ["regular", "neutral", "reverse", "angled"],
  vertical_pull: ["regular", "neutral", "reverse", "angled"],
  isolation: ["regular", "neutral", "reverse", "angled"],
  hinge: ["regular", "neutral", "mixed", "hook"],
  carry: ["regular", "neutral", "hook"],
  olympic: ["regular", "neutral", "hook"],
};

describe("which grips a movement offers", () => {
  it("matches the vocabulary table exactly, pattern by pattern", () => {
    for (const [pattern, grips] of Object.entries(EXPECTED)) {
      expect(gripsFor(pattern), pattern).toEqual(grips);
    }
  });

  it("offers nothing for a movement with no grip worth recording", () => {
    // A leg press or a squat. The picker must not appear at all — an empty
    // picker is a question with no answers.
    for (const p of ["squat", "lunge", "core", "mobility", "locomotion"]) {
      expect(gripsFor(p), p).toEqual([]);
      expect(gripApplies(p), p).toBe(false);
    }
    expect(gripsFor(undefined)).toEqual([]);
    expect(gripApplies(undefined)).toBe(false);
  });

  it("says a hinge can be pulled mixed or hook, and never angled", () => {
    // The whole point of N9: a deadlifter could not record how they pull.
    expect(gripsFor("hinge")).toContain("mixed");
    expect(gripsFor("hinge")).toContain("hook");
    expect(gripsFor("hinge")).not.toContain("angled");
  });

  it("agrees with gripApplies wherever it offers anything", () => {
    for (const p of Object.keys(EXPECTED)) {
      expect(gripApplies(p), p).toBe(true);
    }
  });

  it("only ever names grips the shared list knows how to label", () => {
    // A key with no GRIPS entry renders as its raw id ("mixed_left") in the
    // picker. Tolerated by design for a value the SERVER added, never for one
    // this table names itself.
    const known = new Set(GRIPS.map((g) => g.key));
    for (const [pattern, grips] of Object.entries(EXPECTED)) {
      for (const g of gripsFor(pattern)) {
        expect(known.has(g), `${pattern}/${g}`).toBe(true);
      }
      expect(grips.every((g) => known.has(g))).toBe(true);
    }
  });
});

describe("the chips a row actually shows", () => {
  it("shows the movement's own subset", () => {
    expect(offeredGrips("hinge", null).map((g) => g.key)).toEqual([
      "regular",
      "neutral",
      "mixed",
      "hook",
    ]);
  });

  it("APPENDS a grip the set already holds but the subset does not list", () => {
    // #256's rule at the UI end. A set recorded as `angled` on a movement whose
    // subset later dropped it — or a grip a newer server added — must stay
    // clearable. Rendering the subset alone would leave it visible in the row
    // and impossible to remove.
    const shown = offeredGrips("hinge", "angled").map((g) => g.key);
    expect(shown).toContain("angled");
    expect(shown.indexOf("angled")).toBe(shown.length - 1);
    expect(shown.slice(0, 4)).toEqual(["regular", "neutral", "mixed", "hook"]);
  });

  it("does not duplicate a grip already in the subset", () => {
    const shown = offeredGrips("hinge", "hook").map((g) => g.key);
    expect(shown.filter((g) => g === "hook")).toHaveLength(1);
  });

  it("labels an unknown grip with its own id rather than dropping it", () => {
    // The value the server may add before this build knows its label. Dropping
    // it is the erasure T4 is about; showing the raw id is survivable.
    // Typed through a variable, not compared against a bare literal: the
    // point of the case is a value OUTSIDE this build's union, which is
    // exactly what `g.key === "mixed_left"` cannot express.
    const fromANewerServer = "mixed_left" as Grip;
    const shown = offeredGrips("hinge", fromANewerServer);
    expect(shown.map((g) => g.key)).toContain(fromANewerServer);
    expect(shown.find((g) => g.key === fromANewerServer)?.label).toBe(
      "mixed_left",
    );
  });

  it("offers nothing at all where the movement has no vocabulary", () => {
    expect(offeredGrips("squat", null)).toEqual([]);
  });

  it("STILL offers a grip a set holds on a movement with no vocabulary", () => {
    // The case the picker's gate turns on, and it was untested until review
    // pointed at it. A squat that carries a grip — the console recategorised
    // the exercise after it was logged, or a newer server grew a pattern this
    // build does not know — must still be offered, or the grip is visible in
    // the row, unclearable, and re-sent by every wholesale PUT forever.
    expect(offeredGrips("squat", "regular").map((g) => g.key)).toEqual([
      "regular",
    ]);
    expect(offeredGrips(undefined, "hook").map((g) => g.key)).toEqual(["hook"]);
  });
});

describe("a new set carries the grip forward", () => {
  const prev: LoggedSet = {
    exercise_id: "deadlift",
    position: 1,
    set_type: "working",
    reps: 5,
    weight_kg: 140,
    seconds: null,
    distance_m: null,
    rir: 2,
    rpe: 8,
    grip: "mixed",
    notes: "",
    completed: true,
  };

  it("keeps the grip, because you do not change it between sets", () => {
    // REVERSED by N10. Web used to refuse this, and rightly, because it had no
    // control to unmake the recording with. It has one now.
    expect(emptySet("deadlift", 2, prev).grip).toBe("mixed");
    // A SECOND value, because one is indistinguishable from a hardcode:
    // `grip: from ? "mixed" : undefined` passed the single-value version of
    // this test and the whole web suite. Found by review.
    expect(emptySet("deadlift", 2, { ...prev, grip: "hook" }).grip).toBe("hook");
    expect(emptySet("deadlift", 2, { ...prev, grip: null }).grip).toBeNull();
  });

  it("still refuses to carry effort", () => {
    // The distinction that survived: a grip is how you are doing the movement,
    // effort is a judgement about one particular set.
    const next = emptySet("deadlift", 2, prev);
    expect(next.rir).toBeNull();
    expect(next.rpe).toBeNull();
  });

  it("leaves a first set with no grip", () => {
    expect(emptySet("deadlift", 1).grip).toBeUndefined();
  });
});
