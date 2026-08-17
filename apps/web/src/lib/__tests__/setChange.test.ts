import { describe, expect, it } from "vitest";

import { withSetChange, type LoggedSet } from "../api";

/**
 * Web can neither display nor clear `assisted_reps`, and a save is a WHOLESALE
 * PUT of every set — so one row that violates
 * `session_sets_assisted_within_reps` 400s every subsequent edit to any set in
 * the session, with nothing on screen explaining why.
 *
 * Web edited measures with a bare spread until now, which is how a field it
 * never shows could wedge the whole page. These cover the clamp that closed it.
 */

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: "bench-press",
  position: 1,
  set_type: "working",
  reps: 8,
  weight_kg: 100,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: "",
  completed: true,
  assisted_reps: 3,
  ...over,
});

describe("editing a set on web", () => {
  it("clears the assisted count when reps are cleared", () => {
    // The wedge: `assisted_reps IS NOT NULL AND reps IS NULL` is a row the
    // database refuses, and web shows no field that could put it right.
    const next = withSetChange(set(), { reps: null });
    expect(next.assisted_reps).toBeNull();
  });

  it("caps the assisted count when reps drop below it", () => {
    // 3 of 8 spotted, corrected to 2 total: 3 assisted is now more reps than
    // were performed.
    expect(withSetChange(set(), { reps: 2 }).assisted_reps).toBe(2);
  });

  it("leaves a still-valid assisted count alone", () => {
    // Or the clamp would be indistinguishable from "always clear it".
    expect(withSetChange(set(), { reps: 5 }).assisted_reps).toBe(3);
  });

  it("does nothing to a set that has no assisted count", () => {
    const next = withSetChange(set({ assisted_reps: null }), { reps: null });
    expect(next.assisted_reps).toBeNull();
    expect(next.reps).toBeNull();
  });

  it("passes every other field through untouched", () => {
    // It is on the write path for every measure edit, so anything it drops is
    // wiped by the wholesale PUT — grip included.
    const next = withSetChange(set({ grip: "neutral" }), { weight_kg: 105 });
    expect(next.grip).toBe("neutral");
    expect(next.weight_kg).toBe(105);
    expect(next.reps).toBe(8);
  });
});
