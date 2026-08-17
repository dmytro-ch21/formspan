import { contributesVolume, countsAsSet, type LoggedSet } from '../sessions';

const s = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'bench',
  position: 0,
  set_type: 'working',
  reps: 5,
  weight_kg: 100,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: true,
  ...over,
});

describe('a drop is part of the set above it', () => {
  it('does not count as a set, but does contribute volume', () => {
    // The pair IS the change. Asserting only the first half would pass against
    // a version that also discarded the drop's work — which is the mistake the
    // split exists to prevent, and the one that would lose real training.
    const drop = s({ set_type: 'drop' });
    expect(countsAsSet(drop)).toBe(false);
    expect(contributesVolume(drop)).toBe(true);
  });

  it('leaves every other performed set alone', () => {
    for (const t of ['working', 'backoff', 'amrap', 'failure'] as const) {
      expect(countsAsSet(s({ set_type: t }))).toBe(true);
      expect(contributesVolume(s({ set_type: t }))).toBe(true);
    }
  });

  it('excludes a warm-up from both', () => {
    const warm = s({ set_type: 'warmup' });
    expect(countsAsSet(warm)).toBe(false);
    expect(contributesVolume(warm)).toBe(false);
  });

  it('excludes anything not performed from both', () => {
    // Planned but not ticked. A template opens with every set false.
    const planned = s({ completed: false });
    expect(countsAsSet(planned)).toBe(false);
    expect(contributesVolume(planned)).toBe(false);
  });
});
