import { contributesVolume, countsAsSet, localVolume, type LoggedSet } from '../sessions';

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

describe('a drop that was never performed', () => {
  it('counts for nothing, like any unticked set', () => {
    // The boundary the pair implies: `completed` gates both predicates, so an
    // unticked drop is excluded twice over. Two lines, and it pins the one case
    // the generic "not performed" test does not spell out for a drop.
    const planned = s({ set_type: 'drop', completed: false });
    expect(countsAsSet(planned)).toBe(false);
    expect(contributesVolume(planned)).toBe(false);
  });
});

describe('the local summary, now that it can be tested', () => {
  it('counts a drop toward volume and not toward sets', () => {
    // This function was the site missed twice — once for per-side load, once
    // for drops — while living in a 2,700-line screen with a comment promising
    // it matched the server. This is the assertion that comment could not make.
    const v = localVolume([
      s({ reps: 3, weight_kg: 100 }),
      s({ set_type: 'drop', reps: 8, weight_kg: 80 }),
      s({ reps: 3, weight_kg: 100 }),
    ]);
    expect(v.working_sets).toBe(2);
    expect(v.total_reps).toBe(14);
    expect(v.tonnage_kg).toBe(1240); // 300 + 640 + 300
  });

  it('doubles a per-side set, and still adds no set for its drop', () => {
    // The two rules composing — the same pair the backend's parity fixture
    // proves, asserted on the phone's own copy.
    const v = localVolume([
      s({ reps: 10, weight_kg: 30, load_factor: 2 }),
      s({ set_type: 'drop', reps: 12, weight_kg: 20, load_factor: 2 }),
    ]);
    expect(v.working_sets).toBe(1);
    expect(v.tonnage_kg).toBe(1080); // 10x60 + 12x40
  });

  it('ignores warm-ups and unticked sets entirely', () => {
    const v = localVolume([
      s({ set_type: 'warmup', reps: 10, weight_kg: 40 }),
      s({ completed: false, reps: 5, weight_kg: 100 }),
    ]);
    expect(v).toMatchObject({ working_sets: 0, total_reps: 0, tonnage_kg: 0 });
  });
});
