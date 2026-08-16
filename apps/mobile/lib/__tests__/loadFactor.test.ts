import { totalWeightKg } from '../sessions';

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
