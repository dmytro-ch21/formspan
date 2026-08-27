import { describe, expect, it } from "vitest";

import {
  describeSetWeight,
  swapExercise,
  totalWeightKg,
  weightTotalSuffix,
  type Exercise,
  type LoggedSet,
} from "../api";

/**
 * `weight_kg` is what is stamped on the implement, because that is what an
 * athlete reads and types. For a pair of dumbbells it is ONE of the two.
 *
 * `sessionVolume.test.ts` already covers the aggregate; this file is about
 * the per-set reading (#425) — naming it on the row, and getting it right
 * across an exercise swap.
 */
describe("what was actually moved", () => {
  it("doubles a pair of dumbbells", () => {
    expect(totalWeightKg({ weight_kg: 30, load_factor: 2 })).toBe(60);
  });

  it("leaves a barbell alone", () => {
    expect(totalWeightKg({ weight_kg: 100, load_factor: 1 })).toBe(100);
  });

  it("treats a missing factor as one, never as zero", () => {
    // Every set logged before the server sent a factor has none. Reading
    // that as zero would erase its volume rather than under-reporting the
    // dumbbell ones, which is the worse of the two bugs.
    expect(totalWeightKg({ weight_kg: 100 })).toBe(100);
    expect(totalWeightKg({ weight_kg: 100, load_factor: 0 })).toBe(100);
  });

  it("is zero when there is no weight at all", () => {
    expect(totalWeightKg({ weight_kg: null, load_factor: 2 })).toBe(0);
  });
});

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

const barbell = {
  id: "bench-press",
  load_type: "weight_reps",
  implements: 1,
} as Exercise;
const inclineDumbbell = {
  id: "incline-dumbbell-press",
  load_type: "weight_reps",
  implements: 2,
} as Exercise;

describe("swapping an exercise (#425 — a stale factor must not survive the swap)", () => {
  it("looks up the new exercise's own factor rather than carrying the old one forward", () => {
    // Web never cleared `load_factor` on a swap at all until this change —
    // worse than mobile's pre-fix bug in the same family, since mobile at
    // least reset to a safe (under-reporting) default. Here, a barbell set
    // could inherit a dumbbell's ×2 and read DOUBLE, silently, for as long as
    // the row went unsaved. `to.implements` is always known on web — there is
    // no offline path — so the fix is a straight lookup, not a fallback.
    const [swapped] = swapExercise(
      [set()],
      "dumbbell-bench-press",
      barbell,
      "weight_reps",
    );
    expect(swapped.exercise_id).toBe("bench-press");
    expect(swapped.load_factor).toBe(1);
    expect(totalWeightKg(swapped)).toBe(30);
  });

  it("carries the new factor correctly for a dumbbell-to-dumbbell swap too", () => {
    const [swapped] = swapExercise(
      [set()],
      "dumbbell-bench-press",
      inclineDumbbell,
      "weight_reps",
    );
    expect(swapped.load_factor).toBe(2);
    expect(totalWeightKg(swapped)).toBe(60);
  });

  it("keeps the weight when the shape matches", () => {
    const [swapped] = swapExercise(
      [set()],
      "dumbbell-bench-press",
      barbell,
      "weight_reps",
    );
    expect(swapped.weight_kg).toBe(30);
  });
});

/**
 * The row itself, read-only — the visible half of #425. Mobile's
 * `describeSet` has rendered `"30kg (60kg total)"` for a long time; this app
 * showed the bare weight with no indication a total existed at all.
 */
describe("naming the per-hand reading on the row", () => {
  it("shows the total when a pair of dumbbells doubles it", () => {
    expect(describeSetWeight(set(), "metric")).toBe("30kg (60kg total)");
  });

  it("says nothing at all when the weight is the whole story", () => {
    expect(
      describeSetWeight({ weight_kg: 100, load_factor: 1 }, "metric"),
    ).toBe("100kg");
  });

  it("says nothing for a one-arm row, where per-hand does NOT mean doubled", () => {
    // Driven by the TOTAL, not by `load_mode`/`perSide` — a unilateral
    // per-side movement is still typed per hand but its factor is 1, so
    // "(X total)" here would be a straight lie.
    expect(
      describeSetWeight({ weight_kg: 40, load_factor: 1 }, "metric"),
    ).toBe("40kg");
  });

  it("says nothing when the factor is missing, rather than guessing", () => {
    expect(
      describeSetWeight({ weight_kg: 30, load_factor: undefined }, "metric"),
    ).toBe("30kg");
    expect(
      describeSetWeight({ weight_kg: 30, load_factor: 0 }, "metric"),
    ).toBe("30kg");
  });

  it("converts both numbers, not just the one that was typed", () => {
    // The total is doubled in kilograms and converted once — 132.3, not
    // 66.1 x 2 = 132.2 — so it is not the displayed number times two.
    expect(describeSetWeight(set(), "imperial")).toBe("66.1lb (132.3lb total)");
  });

  it("annotates any factor, not just two", () => {
    expect(
      describeSetWeight({ weight_kg: 30, load_factor: 3 }, "metric"),
    ).toBe("30kg (90kg total)");
  });
});

/**
 * `weightTotalSuffix` is the fragment `SetRow`'s weight cell actually
 * renders — extracted from `describeSetWeight` so the two cannot drift
 * (found independently by `ac-verifier` and `frontend-reviewer` in review: an
 * earlier version had the page recompute the same condition inline, which
 * meant a test on `describeSetWeight` proved nothing about what the athlete
 * would see). These pin the fragment on its own, and the composition pins
 * that `describeSetWeight` is built from it rather than merely agreeing with
 * it by coincidence.
 */
describe("the fragment the weight cell actually renders", () => {
  it("is null, not '', when there is nothing to say", () => {
    // The falsy-vs-absent distinction matters if this is ever compared
    // directly rather than just used in JSX, where both render nothing.
    expect(weightTotalSuffix({ weight_kg: 100, load_factor: 1 }, "metric")).toBeNull();
  });

  it("is the parenthesised fragment alone, with no leading number", () => {
    expect(weightTotalSuffix(set(), "metric")).toBe("(60kg total)");
  });

  it("composes into describeSetWeight exactly — the property that makes the split safe", () => {
    // If `describeSetWeight` ever stopped delegating to this function — a
    // hand-rolled `${w} (${total} total)` restated beside it — this still
    // passes as long as both formulas happen to agree, which is exactly the
    // silent-drift risk the split exists to close. It is here as
    // documentation of the intended shape, not as the only guard against
    // that: the UI's own use of `weightTotalSuffix` (not a copy of its logic)
    // is what actually closes it, in `sessions/[id]/page.tsx`.
    const w = "30kg";
    const suffix = weightTotalSuffix(set(), "metric");
    expect(`${w} ${suffix}`).toBe(describeSetWeight(set(), "metric"));
  });
});

/**
 * `apps/mobile/lib/__tests__/loadFactor.test.ts` mirrors this file — same
 * filename, same fixture shape (`exercise_id: 'dumbbell-bench-press'`,
 * `weight_kg: 30`, `load_factor: 2`), same expected numbers — for the
 * "the two surfaces agree" acceptance criterion on #425.
 *
 * **Said plainly, in the spirit of the backend's own
 * `TestTheRuleIsSharedNotCopied`: this cannot import mobile's implementation.**
 * `apps/mobile/lib/sessions.ts` imports `expo-crypto` at module scope, which
 * has no resolution under this app's Vitest environment — the two apps share
 * no package. What this file and its mobile twin CAN do, and do, is assert
 * byte-for-byte identical expectations against a fixture that is
 * byte-for-byte identical by inspection, so a change to either formula that
 * the other does not also get shows up as a failing assertion in ONE of the
 * two files on the next run of THIS repo's test suite — real protection, with
 * a real gap (a divergence introduced in both files at once, identically,
 * would pass both), stated rather than implied.
 */
describe("parity with apps/mobile (see the doc comment above)", () => {
  it("agrees with mobile's totalWeightKg on the canonical #425 fixture", () => {
    // mobile: totalWeightKg({ weight_kg: 30, load_factor: 2 }) === 60
    expect(totalWeightKg({ weight_kg: 30, load_factor: 2 })).toBe(60);
  });

  it("agrees with mobile's localVolume on the same fixture summed over a whole session", () => {
    // mobile: localVolume([set()]).tonnage_kg === 600  (10 reps x 30kg x 2)
    // `import { sessionVolume } from '../api'` is deliberately not added here
    // — this block is only the two numbers the parity claim depends on.
    expect(10 * totalWeightKg(set())).toBe(600);
  });

  it("agrees with mobile's describeSet on the annotated string", () => {
    // mobile: describeSet(set({ reps: null }), 'metric')
    //           === '30kg (60kg total)'
    expect(describeSetWeight(set(), "metric")).toBe("30kg (60kg total)");
  });
});
