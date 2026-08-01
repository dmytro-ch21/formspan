import { fillForward, reorderGroups, type LoggedSet, type Measure } from '../sessions';

/**
 * The pure set transforms behind in-session editing.
 *
 * One of these caught a real bug the day it was written: `fillForward`
 * filtered on `exercise_id` without stopping at the group boundary, so
 * squat / bench / squat filled the *second* squat block from the first —
 * contradicting the function's own doc comment.
 */

const set = (exercise: string, over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: exercise,
  position: 0,
  set_type: 'working',
  reps: null,
  weight_kg: null,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: false,
  ...over,
});

const REPS_AND_WEIGHT: Measure[] = ['reps', 'weight'];

describe('fillForward', () => {
  it('fills the planned sets below with what was entered', () => {
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('squat'), set('squat')];
    const out = fillForward(sets, 0, REPS_AND_WEIGHT);
    expect(out[1]).toMatchObject({ reps: 5, weight_kg: 100 });
    expect(out[2]).toMatchObject({ reps: 5, weight_kg: 100 });
  });

  it('never overwrites a value already typed', () => {
    // A top set followed by back-offs is a real plan; flattening it silently
    // would be worse than the typing this saves.
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('squat', { weight_kg: 80 })];
    const out = fillForward(sets, 0, REPS_AND_WEIGHT);
    expect(out[1].weight_kg).toBe(80);
  });

  it('still fills the measures that are blank on a partly-filled set', () => {
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('squat', { weight_kg: 80 })];
    expect(fillForward(sets, 0, REPS_AND_WEIGHT)[1].reps).toBe(5);
  });

  it('leaves a completed set alone — it records something that happened', () => {
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('squat', { completed: true })];
    const out = fillForward(sets, 0, REPS_AND_WEIGHT);
    expect(out[1]).toMatchObject({ reps: null, weight_kg: null });
  });

  it('stops at the next exercise', () => {
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('bench'), set('squat')];
    expect(fillForward(sets, 0, REPS_AND_WEIGHT)[1].weight_kg).toBeNull();
  });

  it('does not reach a LATER block of the same exercise', () => {
    // The regression this suite was started for. Groups are adjacency-based,
    // so squat/bench/squat is two separate pieces of work.
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('bench'), set('squat')];
    expect(fillForward(sets, 0, REPS_AND_WEIGHT)[2].weight_kg).toBeNull();
  });

  it('never carries effort', () => {
    // The third set at one weight is not the first set's effort; prefilling
    // invites recording a number nobody judged.
    const sets = [set('squat', { reps: 5, weight_kg: 100, rir: 2, rpe: 8 }), set('squat')];
    const out = fillForward(sets, 0, REPS_AND_WEIGHT);
    expect(out[1]).toMatchObject({ rir: null, rpe: null });
  });

  it('returns the same array when nothing changed, so callers can skip a write', () => {
    const sets = [set('squat', { reps: 5 }), set('squat', { reps: 3 })];
    expect(fillForward(sets, 0, ['reps'])).toBe(sets);
  });
});

describe('reorderGroups', () => {
  const sets = [set('a', { reps: 1 }), set('a', { reps: 2 }), set('b', { reps: 3 })];
  const order = [
    [0, 1],
    [2],
  ];

  it('moves a group with all of its sets', () => {
    const out = reorderGroups(sets, order, 1, -1)!;
    expect(out.map((s) => s.exercise_id)).toEqual(['b', 'a', 'a']);
  });

  it('renumbers positions contiguously, because the server orders by them', () => {
    const out = reorderGroups(sets, order, 1, -1)!;
    expect(out.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it('carries set contents through the move', () => {
    const out = reorderGroups(sets, order, 1, -1)!;
    expect(out.map((s) => s.reps)).toEqual([3, 1, 2]);
  });

  it('refuses to move off either end', () => {
    expect(reorderGroups(sets, order, 0, -1)).toBeNull();
    expect(reorderGroups(sets, order, 1, 1)).toBeNull();
  });
});
