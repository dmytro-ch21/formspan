import type { Exercise } from '../exercises';
import { describeSet, swapExercise, totalWeightKg, type LoggedSet } from '../sessions';

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

const barbell = { id: 'bench-press', load_type: 'weight_reps' } as Exercise;

describe('swapping an exercise', () => {
  it('does not carry the old exercise’s factor onto the new one', () => {
    // A factor describes the MOVEMENT, so it cannot survive becoming a
    // different one. Swapping a pair of dumbbells for a barbell kept the ×2
    // and counted the barbell double — a number this feature invents, not one
    // it fails to correct.
    //
    // It does not self-heal offline either: the pull skips dirty rows, so the
    // doubled figure survives the whole session, one tab from the Today header.
    const [swapped] = swapExercise([set()], 'dumbbell-bench-press', barbell, 'weight_reps');
    expect(swapped.exercise_id).toBe('bench-press');
    expect(swapped.load_factor).toBeUndefined();
    // And the number that actually reaches a volume sum is the honest one.
    expect(totalWeightKg(swapped)).toBe(30);
  });

  it('keeps the weight when the shape matches, which is why the factor had to go', () => {
    // The carry-over exists because a same-shape swap deliberately preserves
    // `weight_kg`. That is the right behaviour and is what made the stale
    // factor reachable — so this pins both halves together.
    const [swapped] = swapExercise([set()], 'dumbbell-bench-press', barbell, 'weight_reps');
    expect(swapped.weight_kg).toBe(30);
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
