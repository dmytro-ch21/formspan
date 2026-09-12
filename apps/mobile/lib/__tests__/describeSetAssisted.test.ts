import { describeSet, soloReps, type LoggedSet } from '../sessions';

/**
 * F25/#707 — assisted reps were saved and never shown.
 *
 * `reps` holds the full count, assisted included, and `describeSet` is what
 * every read-only surface prints for a set: the completed session's rows, their
 * VoiceOver label, and a collapsed group's headline. It never read
 * `assisted_reps`, so "8 reps, 3 with a spotter" read exactly like 8 unaided.
 */
const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'assisted-pull-up',
  position: 0,
  set_type: 'working',
  reps: 8,
  weight_kg: null,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: true,
  ...over,
});

describe('a set with assisted reps says so', () => {
  it('names how many were assisted on a bodyweight set', () => {
    expect(describeSet(set({ assisted_reps: 3 }), 'metric')).toBe('8 reps · 3 assisted');
  });

  it('names them on a loaded set, after the load and its total', () => {
    expect(
      describeSet(set({ exercise_id: 'dumbbell-row', weight_kg: 30, load_factor: 2, assisted_reps: 2 }), 'metric'),
    ).toBe('8 × 30kg (60kg total) · 2 assisted');
  });

  it('keeps the order of what follows it: effort, then grip', () => {
    expect(describeSet(set({ assisted_reps: 3, rpe: 9, grip: 'neutral' }), 'metric')).toMatch(
      /^8 reps · 3 assisted · RPE 9 · /,
    );
  });

  it('counts every rep when all of them were assisted', () => {
    expect(describeSet(set({ assisted_reps: 8 }), 'metric')).toBe('8 reps · 8 assisted');
  });
});

describe('a set with no assistance to report says nothing about it', () => {
  it.each([
    ['unrecorded (null)', null],
    ['unrecorded (absent, an older cached row)', undefined],
    ['none of them (0)', 0],
  ] as const)('%s', (_label, assisted) => {
    const s = set(assisted === undefined ? {} : { assisted_reps: assisted });
    expect(describeSet(s, 'metric')).toBe('8 reps');
  });
});

describe('an assisted count with no rep count behind it', () => {
  it('is not reported, because it would describe reps that were never recorded', () => {
    // Unreachable in valid data — the server's check constraint keeps
    // assisted_reps within reps, and withSetChange clears it when reps is
    // cleared — but a row cached before either rule existed could still carry
    // one. "3 assisted" with no count beside it reads as three reps done.
    expect(describeSet(set({ reps: null, assisted_reps: 3 }), 'metric')).toBe('Not recorded');
  });
});

describe('the summary and the arithmetic tell the same story', () => {
  it('shows the assisted count that soloReps subtracts', () => {
    const s = set({ assisted_reps: 3 });
    // The row says 8 with 3 assisted; progression works from the 5 unaided.
    expect(describeSet(s, 'metric')).toContain('3 assisted');
    expect(soloReps(s)).toBe(5);
  });
});
