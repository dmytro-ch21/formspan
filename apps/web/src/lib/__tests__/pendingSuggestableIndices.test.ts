import { describe, expect, it } from "vitest";

import {
  applySuggestions,
  pendingSuggestableIndices,
  type LoggedSet,
  type Suggestion,
} from "../api";

/**
 * N551/#1013, item 7 — "a suggestion applies only to matching pending working
 * sets, never to every non-warm-up set."
 *
 * The web session screen filtered `set_type !== "warmup"` until this landed,
 * which is the defect #753 reported verbatim: a straight-set recommendation
 * derived from the working cohort was written into backoffs, drops, AMRAPs and
 * failure sets as well. Mobile was fixed in #812; this surface was not, and
 * nothing could see the difference because the filter was an inline expression
 * inside a 1,500-line page component where no test could reach it — the same
 * shape `sessionVolume` was extracted for, and for the same reason.
 *
 * Every case below should go red if the `set_type === "working"` half of the
 * predicate is weakened back to `!== "warmup"`.
 */

const set = (over: Partial<LoggedSet> = {}): LoggedSet =>
  ({
    exercise_id: "back-squat",
    position: 1,
    set_type: "working",
    reps: 5,
    weight_kg: 100,
    completed: false,
    ...over,
  }) as LoggedSet;

describe("pendingSuggestableIndices", () => {
  it("keeps a pending straight working set", () => {
    const sets = [set()];
    expect(pendingSuggestableIndices([0], sets)).toEqual([0]);
  });

  it("drops a completed set — it is a record, not a slot to fill", () => {
    const sets = [set({ completed: true })];
    expect(pendingSuggestableIndices([0], sets)).toEqual([]);
  });

  it("drops a warm-up", () => {
    const sets = [set({ set_type: "warmup" })];
    expect(pendingSuggestableIndices([0], sets)).toEqual([]);
  });

  /**
   * The whole point of the ticket. Each of these is "not a warm-up" and would
   * have received the recommendation under the old filter — a backoff
   * prescribed off a percentage silently becoming the top-set weight is the
   * loudest version of it.
   */
  it.each(["backoff", "drop", "amrap", "failure"] as const)(
    "drops a pending %s set — the suggestion was never derived from one",
    (setType) => {
      const sets = [set({ set_type: setType })];
      expect(pendingSuggestableIndices([0], sets)).toEqual([]);
    },
  );

  it("picks only the working sets out of a mixed group, preserving order", () => {
    const sets = [
      set({ set_type: "warmup" }), // 0
      set({ completed: true }), // 1 — done
      set(), // 2
      set({ set_type: "backoff" }), // 3
      set(), // 4
      set({ set_type: "drop" }), // 5
    ];
    expect(pendingSuggestableIndices([0, 1, 2, 3, 4, 5], sets)).toEqual([2, 4]);
  });

  it("only considers the indices it was handed, not the whole list", () => {
    const sets = [set(), set(), set()];
    expect(pendingSuggestableIndices([1], sets)).toEqual([1]);
  });

  /**
   * Mirrors the server's `NOT NULL DEFAULT 'working'` column and mobile's own
   * `?? 'working'`: a row that somehow reaches the client without a set_type is
   * a working set, not an unsuggestable one. Without this the card would
   * silently offer no action at all.
   */
  it("reads a missing set_type as working", () => {
    const sets = [{ completed: false } as Pick<LoggedSet, "completed" | "set_type">];
    expect(pendingSuggestableIndices([0], sets)).toEqual([0]);
  });

  /**
   * Pinned as PARITY, not as a recommendation. An index with no set behind it
   * reads as pending (`!undefined`) and as working (`undefined ?? "working"`),
   * so it survives the filter — and mobile's `pendingSuggestableIndices`
   * behaves identically, byte for byte. Both call sites derive `indices` from
   * the same `sets` array they pass in, so neither can produce one; this test
   * exists so that if either copy ever grows a bounds check, the other's
   * divergence is visible rather than silent. Two hand-rolled copies of one
   * rule drifting in the middle is exactly what `sessionVolume`'s doc comment
   * records happening three times.
   */
  it("keeps an out-of-range index, matching mobile's twin exactly", () => {
    expect(pendingSuggestableIndices([7], [set()])).toEqual([7]);
  });
});

/**
 * The same invariant one level up: the silent prefill that runs when a session
 * is started from a template or a workout. `pendingSuggestableIndices` guards
 * the "Use" button; this guards the prefill.
 *
 * No caller can reach it with a non-working set today — `setsFromWorkout`
 * hardcodes `set_type: "working"` and `WorkoutItem` has no set role — so these
 * pin an invariant that is currently true by CONSTRUCTION, which is precisely
 * how it would become the reported bug the day templates can author a backoff.
 */
describe("applySuggestions", () => {
  const hit = new Map<string, Suggestion>([
    [
      "back-squat",
      {
        exercise_id: "back-squat",
        target_weight_kg: 100,
        target_reps: 5,
      } as Suggestion,
    ],
  ]);

  it("fills a blank working set", () => {
    const [out] = applySuggestions([set({ weight_kg: null, reps: null })], hit);
    expect(out.weight_kg).toBe(100);
    expect(out.reps).toBe(5);
  });

  it.each(["backoff", "drop", "amrap", "failure", "warmup"] as const)(
    "leaves a blank %s set completely alone",
    (setType) => {
      const [out] = applySuggestions(
        [set({ set_type: setType, weight_kg: null, reps: null })],
        hit,
      );
      expect(out.weight_kg).toBeNull();
      expect(out.reps).toBeNull();
    },
  );

  it("never overwrites a template's own prescription", () => {
    const [out] = applySuggestions([set({ weight_kg: 60, reps: 12 })], hit);
    expect(out.weight_kg).toBe(60);
    expect(out.reps).toBe(12);
  });

  it("leaves an exercise with no suggestion untouched", () => {
    const [out] = applySuggestions(
      [set({ exercise_id: "bench-press", weight_kg: null, reps: null })],
      hit,
    );
    expect(out.weight_kg).toBeNull();
  });
});
