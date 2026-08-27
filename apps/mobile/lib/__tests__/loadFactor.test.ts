import type { Exercise } from '../exercises';
import {
  describeSet,
  hasUnresolvedLoad,
  localVolume,
  swapExercise,
  totalWeightKg,
  type LoggedSet,
} from '../sessions';

/**
 * `weight_kg` is what is stamped on the implement, because that is what an
 * athlete reads and types. For a pair of dumbbells it is ONE of the two.
 *
 * The phone sums its own volume for the week, the Today header and the
 * calendar, so it has to agree with the server about this or the number on the
 * screen disagrees with the history behind it.
 */
describe('what was actually moved', () => {
  it('doubles a pair of dumbbells', () => {
    expect(totalWeightKg({ weight_kg: 30, load_factor: 2 })).toBe(60);
  });

  it('leaves a barbell alone', () => {
    expect(totalWeightKg({ weight_kg: 100, load_factor: 1 })).toBe(100);
  });

  it('treats a missing factor as one, never as zero', () => {
    // Every set logged before the server sent a factor has none — offline rows
    // included. Reading that as zero would erase their volume rather than
    // under-reporting the dumbbell ones, which is the worse of the two bugs.
    expect(totalWeightKg({ weight_kg: 100 })).toBe(100);
    expect(totalWeightKg({ weight_kg: 100, load_factor: 0 })).toBe(100);
  });

  it('is zero when there is no weight at all', () => {
    // A bodyweight or timed set. Zero here is the truth, not a fallback.
    expect(totalWeightKg({ weight_kg: null, load_factor: 2 })).toBe(0);
  });

  it('returns null rather than a guess when the factor is EXPLICITLY unresolved (#425)', () => {
    // `null` is not the same absence as `undefined`/`0` above — see the field's
    // own doc on `LoggedSet.load_factor`. An offline swap that could not look
    // up the new exercise's factor sets this, and the whole point is that
    // `totalWeightKg` must not paper over it with 1: the true factor is
    // knowable, imminently, on the next sync, so guessing here is exactly the
    // "reports half its eventual tonnage" bug rather than a safe fallback.
    expect(totalWeightKg({ weight_kg: 30, load_factor: null })).toBeNull();
  });

  it('is still zero, not null, when there is no weight — the factor cannot matter', () => {
    // `weight_kg == null` is checked first, so an unresolved factor on a
    // bodyweight/timed set (which should never happen, but costs nothing to
    // guard) does not turn an honest zero into a suppressed unknown.
    expect(totalWeightKg({ weight_kg: null, load_factor: null })).toBe(0);
  });
});

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'dumbbell-bench-press',
  position: 1,
  set_type: 'working',
  reps: 10,
  weight_kg: 30,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: true,
  load_factor: 2,
  ...over,
});

const barbell = { id: 'bench-press', load_type: 'weight_reps', implements: 1 } as Exercise;
const inclineDumbbell = {
  id: 'incline-dumbbell-press',
  load_type: 'weight_reps',
  implements: 2,
} as Exercise;
// A cache row from before `implements` was DECLARED on the TS type — the
// residual case `swapExercise` cannot resolve locally. See the field's own
// doc on `Exercise.implements` and `cachedExercises`'s pre-v10 fallback.
const undeclaredFactor = { id: 'cable-fly', load_type: 'weight_reps' } as Exercise;

describe('swapping an exercise (#425 — an offline swap must not reset the factor to a guess)', () => {
  it('looks up the new exercise’s own factor rather than carrying the old one forward', () => {
    // A factor describes the MOVEMENT, so it cannot survive becoming a
    // different one. Swapping a pair of dumbbells for a barbell used to keep
    // the ×2 and count the barbell double — a number this feature invented,
    // not one it failed to correct.
    //
    // It did not self-heal offline either: the pull skips dirty rows, so the
    // doubled figure survived the whole session, one tab from the Today
    // header. The fix is not "clear it and hope" — `barbell.implements` is
    // right there in the picker's own `Exercise`, offline included (see
    // `cacheExercises`), so the correct factor is available immediately.
    const [swapped] = swapExercise([set()], 'dumbbell-bench-press', barbell, 'weight_reps');
    expect(swapped.exercise_id).toBe('bench-press');
    expect(swapped.load_factor).toBe(1);
    // And the number that actually reaches a volume sum is the honest one.
    expect(totalWeightKg(swapped)).toBe(30);
  });

  it('carries the new factor correctly for a dumbbell-to-dumbbell swap too, not just down to one', () => {
    // The bug this replaces was not "always resets to 1" — it was "always
    // resets to whatever undefined happens to mean", which is 1 today. A fix
    // that only handled the ×2-to-×1 direction would still guess wrong the
    // moment somebody swapped one pair of dumbbells for another.
    const [swapped] = swapExercise([set()], 'dumbbell-bench-press', inclineDumbbell, 'weight_reps');
    expect(swapped.load_factor).toBe(2);
    expect(totalWeightKg(swapped)).toBe(60);
  });

  it('keeps the weight when the shape matches, which is why the factor had to go', () => {
    // The carry-over exists because a same-shape swap deliberately preserves
    // `weight_kg`. That is the right behaviour and is what made the stale
    // factor reachable — so this pins both halves together.
    const [swapped] = swapExercise([set()], 'dumbbell-bench-press', barbell, 'weight_reps');
    expect(swapped.weight_kg).toBe(30);
  });

  it('sets the factor to EXPLICITLY UNRESOLVED, never to a guessed 1, when the catalog has no answer', () => {
    // The residual case: a cache row from before `implements` was declared on
    // this type. Reading it as `undefined` (⇒ 1) here would be the exact
    // "reports half its eventual tonnage" bug #425 was filed for — the
    // athlete just swapped exercises with intent, on this screen, right now,
    // which is a sharper case than an old row nobody is currently reading.
    const [swapped] = swapExercise([set()], 'dumbbell-bench-press', undeclaredFactor, 'weight_reps');
    expect(swapped.load_factor).toBeNull();
    // And it propagates: no number is better than a wrong one here.
    expect(totalWeightKg(swapped)).toBeNull();
  });
});

/**
 * The arithmetic was right and silent, which is its own bug: the Volume tile
 * had already doubled while the row still read `10 × 30kg`, so an athlete
 * checking one against the other found the app off by exactly two — and the
 * row, being the thing they typed, is the one they believe.
 */
describe('saying so on the row', () => {
  it('shows the total when a pair of dumbbells doubles it', () => {
    expect(describeSet(set(), 'metric')).toBe('10 × 30kg (60kg total)');
  });

  it('says nothing at all when the weight is the whole story', () => {
    // A barbell, a machine, or one kettlebell held in two hands. An annotation
    // here would be noise on the overwhelming majority of sets — 620 of the
    // catalog's 762 — and noise is how a real signal stops being read.
    expect(describeSet(set({ exercise_id: 'bench-press', weight_kg: 100, load_factor: 1 }), 'metric')).toBe(
      '10 × 100kg',
    );
  });

  it('says nothing for a one-arm row, where per-hand does NOT mean doubled', () => {
    // The 34 exercises that are `per_side` AND unilateral. They are still typed
    // per hand — the input hint is right to appear — but only one implement
    // moves, so "60kg total" here would be a straight lie. This is the case
    // that forces the input hint and this annotation onto different flags.
    expect(
      describeSet(set({ exercise_id: 'one-arm-dumbbell-row', weight_kg: 40, load_factor: 1 }), 'metric'),
    ).toBe('10 × 40kg');
  });

  it('says nothing when the factor is missing, rather than guessing', () => {
    // Sets logged offline, and every set logged before the server sent a
    // factor. `totalWeightKg` reads absent as one, so the annotation must
    // vanish with it — inventing "(30kg total)" would state a fact this row
    // does not have.
    expect(describeSet(set({ load_factor: undefined }), 'metric')).toBe('10 × 30kg');
    expect(describeSet(set({ load_factor: 0 }), 'metric')).toBe('10 × 30kg');
  });

  it('says nothing — not "(30kg total)", not a crash — when the factor is EXPLICITLY unresolved (#425)', () => {
    // The offline-swap case: `totalWeightKg` returns `null` here, not a
    // number, so the `total !== s.weight_kg` comparison this used to rely on
    // (`null !== 30` is true) would have annotated a set with no known total
    // at all — the exact "reports half its eventual tonnage" bug, just
    // spelled differently. Plain `30kg` is the honest answer: it claims no
    // total, rather than a wrong one.
    expect(describeSet(set({ load_factor: null }), 'metric')).toBe('10 × 30kg');
  });

  it('converts both numbers, not just the one that was typed', () => {
    // The trap in writing this by hand: format the entered weight through the
    // unit system and the total through neither, and an imperial athlete gets
    // "66.1lb (60kg total)" — two units in one phrase, the second of them wrong.
    //
    // Note 132.3 rather than 66.1 × 2 = 132.2. The total is doubled in
    // KILOGRAMS and converted once, so it is not the displayed number times
    // two; doubling the rounded pound figure would drift a little further from
    // the truth with every conversion.
    expect(describeSet(set({ weight_kg: 30 }), 'imperial')).toBe('10 × 66.1lb (132.3lb total)');
  });

  it('annotates any factor, not just two', () => {
    // The server emits only 1 and 2 today, so this is defence rather than a
    // live case — and it is here because without it `total !== weight_kg` and
    // `load_factor === 2` are indistinguishable, which makes the simpler,
    // narrower form look like a free simplification to whoever reads this
    // next. It is not: it would go silent on the first factor nobody planned.
    expect(describeSet(set({ load_factor: 3 }), 'metric')).toBe('10 × 30kg (90kg total)');
  });

  it('annotates a weight logged with no reps', () => {
    // The weight-only branch is a separate line of code from the reps × weight
    // one, so it needs its own proof rather than an assumption of symmetry.
    expect(describeSet(set({ reps: null }), 'metric')).toBe('30kg (60kg total)');
  });

  it('keeps the rest of the summary intact around it', () => {
    // The annotation attaches to the weight, inside that ` · `-joined part —
    // not as a segment of its own, where it would read as another measure
    // alongside RIR.
    expect(describeSet(set({ rir: 2 }), 'metric')).toBe('10 × 30kg (60kg total) · 2 RIR');
  });
});

/**
 * `hasUnresolvedLoad` and `localVolume`'s own tonnage sum, together — the
 * session screen's Volume tile checks the first before trusting the second
 * (#425). Split from "saying so on the row" above because these are about the
 * SESSION total, not one set's own line.
 */
describe('the session total, when one set in it is unresolved', () => {
  it('flags a session containing an unresolved set', () => {
    expect(hasUnresolvedLoad([set({ load_factor: null })])).toBe(true);
  });

  it('does not flag an ordinary session', () => {
    expect(hasUnresolvedLoad([set(), set({ load_factor: 1, weight_kg: 100 })])).toBe(false);
  });

  it('does not confuse LEGACY-absent (`undefined`) with EXPLICITLY-unresolved (`null`)', () => {
    // The distinction the whole `load_factor` design rests on. `undefined` is
    // every set logged before the server sent a factor at all — ordinary,
    // common, and not something a swap or a sync will ever resolve further.
    // Treating it the same as `null` here would hide the Volume tile on
    // countless untouched historical sessions, for no reason connected to
    // #425 at all — a `===` weakened to `==` reproduces exactly this.
    expect(hasUnresolvedLoad([set({ load_factor: undefined })])).toBe(false);
  });

  it('ignores an unresolved set that would not have contributed anyway', () => {
    // A warm-up, or one never marked complete. Neither counts toward
    // `localVolume`'s sum, so an unresolved factor on one is not a reason to
    // hide a session's whole total.
    expect(hasUnresolvedLoad([set({ load_factor: null, set_type: 'warmup' })])).toBe(false);
    expect(hasUnresolvedLoad([set({ load_factor: null, completed: false })])).toBe(false);
  });

  it('ignores an unresolved factor on a set with no weight at all', () => {
    // A bodyweight or timed set carries no tonnage regardless of its factor,
    // so an unresolved one there is not a reason to hide the total either.
    expect(hasUnresolvedLoad([set({ load_factor: null, weight_kg: null })])).toBe(false);
  });

  it('under-counts rather than guessing, in the sum itself', () => {
    // `localVolume` leaves the unresolved set's tonnage OUT — it does not
    // guess 1 (300kg) or throw. This number is exactly what a caller must
    // NOT display without first checking `hasUnresolvedLoad`; the session
    // screen's own guard is what turns this under-count into a withheld "—"
    // rather than a silently wrong figure.
    const sets = [set(), set({ load_factor: null, weight_kg: 50, exercise_id: 'cable-fly' })];
    expect(hasUnresolvedLoad(sets)).toBe(true);
    // 10 x 30kg x 2 from the resolved set; the unresolved one contributes 0.
    expect(localVolume(sets).tonnage_kg).toBe(600);
  });
});

/**
 * `apps/web/src/lib/__tests__/loadFactor.test.ts` mirrors this file — same
 * filename, same fixture shape (`exercise_id: 'dumbbell-bench-press'`,
 * `weight_kg: 30`, `load_factor: 2`), same expected numbers — for the
 * "the two surfaces agree" acceptance criterion on #425.
 *
 * **Said plainly, in the spirit of the backend's own
 * `TestTheRuleIsSharedNotCopied`: this cannot import web's implementation.**
 * `apps/mobile/lib/sessions.ts` imports `expo-crypto` at module scope for
 * `randomUUID`, which has no resolution under web's Vitest environment, so a
 * cross-app import fails before either function under test runs — the two
 * apps share no package, and the mobile-first platform rule is exactly why
 * mobile's copy has to keep working with zero signal. What this file and its
 * web twin CAN do, and do, is assert byte-for-byte identical expectations
 * against a fixture that is byte-for-byte identical by inspection — so a
 * change to either formula that the other does not also get shows up as a
 * failing assertion in ONE of the two files, on the next run of THIS repo's
 * test suite, rather than as a silent drift only a shared runtime could catch.
 * That is real protection with a real gap in it, not full parity, and this
 * says so rather than letting the comment claim more than the mechanism does.
 */
describe('parity with apps/web (see the doc comment above)', () => {
  it('agrees with web’s totalWeightKg on the canonical #425 fixture', () => {
    // web: totalWeightKg({ weight_kg: 30, load_factor: 2 }) === 60
    expect(totalWeightKg({ weight_kg: 30, load_factor: 2 })).toBe(60);
  });

  it('agrees with web’s sessionVolume on the same fixture summed over a whole session', () => {
    // web: sessionVolume([set()]).tonnage_kg === 600  (10 reps x 30kg x 2)
    expect(localVolume([set()]).tonnage_kg).toBe(600);
  });

  it('agrees with web’s describeSetWeight on the annotated string', () => {
    // web: describeSetWeight({ weight_kg: 30, load_factor: 2 }, 'metric')
    //        === '30kg (60kg total)'
    expect(describeSet(set({ reps: null }), 'metric')).toBe('30kg (60kg total)');
  });
});
