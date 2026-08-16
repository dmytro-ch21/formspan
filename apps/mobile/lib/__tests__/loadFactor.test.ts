import type { Exercise } from '../exercises';
import { swapExercise, totalWeightKg, type LoggedSet } from '../sessions';

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
