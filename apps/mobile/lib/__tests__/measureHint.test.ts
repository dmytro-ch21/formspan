import { measureHint } from '../sessions';

/**
 * N452 (#755): the logging form says which number to type.
 *
 * The weight hint existed; the reps hint was shown on the workout template and
 * the web viewer but not on the screen where reps are typed. The two hints key
 * on different catalog facts — `load_mode` and `is_unilateral` — and neither may
 * borrow the other's.
 */
describe('measureHint', () => {
  const bilateral = { load_mode: 'total' as const, is_unilateral: false };
  const oneArmRow = { load_mode: 'per_side' as const, is_unilateral: true };
  const dumbbellBench = { load_mode: 'per_side' as const, is_unilateral: false };
  const singleLegPress = { load_mode: 'total' as const, is_unilateral: true };

  it('says "each side" beside reps on a unilateral exercise', () => {
    expect(measureHint('reps', singleLegPress)).toBe('each side');
    expect(measureHint('reps', oneArmRow)).toBe('each side');
  });

  it('says nothing beside reps when both sides work together', () => {
    expect(measureHint('reps', bilateral)).toBeUndefined();
    expect(measureHint('reps', dumbbellBench)).toBeUndefined();
  });

  it('keeps "per hand" beside weight on a per-side exercise', () => {
    expect(measureHint('weight', dumbbellBench)).toBe('per hand');
    expect(measureHint('weight', oneArmRow)).toBe('per hand');
  });

  it('does not let one fact produce the other hint', () => {
    // Unilateral says nothing about which weight to type…
    expect(measureHint('weight', singleLegPress)).toBeUndefined();
    // …and per-side load says nothing about how reps are counted.
    expect(measureHint('reps', dumbbellBench)).toBeUndefined();
  });

  it('never hints time or distance, and hints nothing without an exercise', () => {
    expect(measureHint('seconds', oneArmRow)).toBeUndefined();
    expect(measureHint('distance', oneArmRow)).toBeUndefined();
    expect(measureHint('reps', undefined)).toBeUndefined();
    expect(measureHint('weight', undefined)).toBeUndefined();
    expect(measureHint('weight', { is_unilateral: false })).toBeUndefined();
  });
});
