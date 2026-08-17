import { describe, expect, it } from "vitest";

import { sessionVolume, type LoggedSet } from "../api";

/**
 * The sessions list computes a session's volume and set count itself, and that
 * computation has been wrong three separate times — each time silently, and
 * each time because it was a hand-rolled copy of a server rule living inside a
 * component file where no test could reach it.
 *
 * These are the three, plus the properties that keep them fixed. Every one
 * should go red if the guard it covers is deleted.
 */

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: "dumbbell-bench-press",
  position: 1,
  set_type: "working",
  reps: 10,
  weight_kg: 30,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: "",
  completed: true,
  load_factor: 2,
  ...over,
});

describe("a session's own volume", () => {
  it("doubles a pair of dumbbells", () => {
    // Bug two. Without the factor every dumbbell session on the list read at
    // HALF the volume its own detail page showed for the same session.
    expect(sessionVolume([set()]).tonnage_kg).toBe(600);
  });

  it("treats an absent factor as one, never as zero", () => {
    // Rows logged before the server sent a factor. Reading absent as zero
    // erases a session rather than under-reporting it, which is far worse.
    expect(sessionVolume([set({ load_factor: undefined })]).tonnage_kg).toBe(
      300,
    );
    expect(sessionVolume([set({ load_factor: 0 })]).tonnage_kg).toBe(300);
  });

  it("ignores a set that was never completed", () => {
    // Bug one. A planned-but-skipped set published the athlete's intention as
    // their training.
    expect(sessionVolume([set({ completed: false })]).tonnage_kg).toBe(0);
  });

  it("ignores warm-ups", () => {
    expect(sessionVolume([set({ set_type: "warmup" })]).tonnage_kg).toBe(0);
  });

  it("survives a set with no numbers on it at all", () => {
    // A timed or bodyweight set sitting in the same session.
    expect(
      sessionVolume([set({ reps: null, weight_kg: null })]).tonnage_kg,
    ).toBe(0);
  });
});

describe("the set count, which is a different question", () => {
  it("counts a working set", () => {
    expect(sessionVolume([set()]).working_sets).toBe(1);
  });

  it("counts back-off, AMRAP and to-failure sets, both ways", () => {
    // The rule is "everything except a warm-up", NOT an allowlist of the types
    // somebody thought of. Without this case a plausible refactor to
    // `set_type === "working" || set_type === "drop"` passes every other test
    // here while silently zeroing three of the six set types out of BOTH
    // figures — measured: it survives the whole file.
    //
    // These three are not exotic. A back-off is the second half of most
    // strength templates, and an AMRAP or a to-failure set is usually the
    // hardest thing in the session — exactly the work an athlete would notice
    // going missing.
    for (const set_type of ["backoff", "amrap", "failure"] as const) {
      const v = sessionVolume([set({ set_type })]);
      expect(v.working_sets, `${set_type} should count as a set`).toBe(1);
      expect(v.tonnage_kg, `${set_type} should contribute volume`).toBe(600);
    }
  });

  it("does NOT count a drop, but still takes its weight", () => {
    // Bug three, and the reason the two figures cannot share one filter. A
    // drop is part of the set it came off — one approach to the bar, one rest
    // period — so it adds no set. The weight was still moved, so it adds
    // volume. The backend draws exactly this line with `countsAsSet` (#238),
    // and the header totals and detail page both already showed the drop-free
    // count, so counting them here put two different numbers on one screen.
    const v = sessionVolume([set(), set({ set_type: "drop", weight_kg: 20 })]);
    expect(v.working_sets).toBe(1);
    expect(v.tonnage_kg).toBe(600 + 400);
  });

  it("does not count an uncompleted drop's weight either", () => {
    // The two filters compose: `completed` still applies to a drop.
    const v = sessionVolume([
      set({ set_type: "drop", completed: false, weight_kg: 20 }),
    ]);
    expect(v.working_sets).toBe(0);
    expect(v.tonnage_kg).toBe(0);
  });

  it("counts a set with no weight — it was still a set", () => {
    // Push-ups. Nothing to add to tonnage, but the athlete did perform a set,
    // and a count that quietly requires weight would under-report every
    // bodyweight session.
    const v = sessionVolume([set({ weight_kg: null })]);
    expect(v.working_sets).toBe(1);
    expect(v.tonnage_kg).toBe(0);
  });
});
