import { emptyDropSet, emptySet, emptyWorkingSet, type LoggedSet } from '../sessions';

/**
 * "+ Set" after a drop set makes a WORKING set (N530/#961, the user's item 8).
 *
 * The user's words: *"when we have a drop set and we click on create a new set
 * it creates a drop automatically. If we click set it should create a normal
 * set, if drop it should create drop."*
 *
 * The bug was `addSet` handing `sets[afterIndex]` to `emptySet`, whose
 * `set_type: from?.set_type ?? 'working'` carried the drop's type forward.
 * `emptyWorkingSet` is what "+ Set" calls now. The golden test below is
 * PERMANENT: it is the ticket's own acceptance criterion, and it goes red if
 * the old carry is restored (mutation-verified — see the history entry).
 */

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'back-squat',
  position: 0,
  set_type: 'working',
  reps: 8,
  weight_kg: 100,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  grip: undefined,
  notes: '',
  completed: true,
  performed_at: '2026-09-08T10:00:00.000Z',
  ...over,
});

describe('the golden case — [working 100×8, drop 80×8] + "+ Set"', () => {
  const sets: LoggedSet[] = [
    set({ position: 0 }),
    set({ position: 1, set_type: 'drop', weight_kg: 80, reps: 8 }),
  ];
  const added = emptyWorkingSet(sets, 'back-squat', 1);

  it('is a working set, not another drop', () => {
    expect(added.set_type).toBe('working');
  });

  it("carries the WORKING set's weight, not the drop's", () => {
    // 80 would be the "same surprise in a different coat" the ticket names:
    // a normal set prefilled with the weight the athlete just dropped TO.
    expect(added.weight_kg).toBe(100);
  });

  it('carries the reps', () => {
    expect(added.reps).toBe(8);
  });

  it('is not performed yet', () => {
    expect(added.completed).toBe(false);
    expect(added.performed_at).toBeNull();
  });

  it('lands at the position after the drop', () => {
    expect(added.position).toBe(2);
    expect(added.exercise_id).toBe('back-squat');
  });
});

describe('after a warmup', () => {
  it('is a working set carrying the warmup\'s numbers', () => {
    // The decided-and-stated behaviour: the TYPE follows the user's rule (a
    // "normal" set); the NUMBERS follow `emptyDropSet`'s reasoning — editing
    // up from 60 beats typing into a blank, and an invented jump to "probably
    // 100" would be a guess about somebody's training.
    const added = emptyWorkingSet(
      [set({ set_type: 'warmup', weight_kg: 60, reps: 10 })],
      'back-squat',
      0,
    );
    expect(added.set_type).toBe('working');
    expect(added.weight_kg).toBe(60);
    expect(added.reps).toBe(10);
  });
});

describe('the carry walks back past EVERY drop to the row they hang off', () => {
  it('[working 100×8, drop 80, drop 60] → 100', () => {
    const sets = [
      set({ position: 0 }),
      set({ position: 1, set_type: 'drop', weight_kg: 80, reps: 6 }),
      set({ position: 2, set_type: 'drop', weight_kg: 60, reps: 10 }),
    ];
    const added = emptyWorkingSet(sets, 'back-squat', 2);
    expect(added.set_type).toBe('working');
    expect(added.weight_kg).toBe(100);
    expect(added.reps).toBe(8);
  });

  it('stops at the group boundary rather than borrowing another exercise', () => {
    // bench then a squat group that is all drops (an orphan — see
    // `setOrdinals`). The bench's 60 kg must NOT be what the squat inherits.
    const sets = [
      set({ position: 0, exercise_id: 'bench-press', weight_kg: 60, reps: 5 }),
      set({ position: 1, set_type: 'drop', weight_kg: 80, reps: null }),
    ];
    const added = emptyWorkingSet(sets, 'back-squat', 1);
    expect(added.exercise_id).toBe('back-squat');
    expect(added.set_type).toBe('working');
    // The stated fallback: the only numbers this exercise has on screen.
    expect(added.weight_kg).toBe(80);
  });

  it('carries nothing when afterIndex is not even this exercise', () => {
    // A caller passing the wrong index gets a blank row, not the other
    // exercise's numbers — the one outcome worse than an empty field.
    const sets = [set({ position: 0, exercise_id: 'bench-press', weight_kg: 60 })];
    const added = emptyWorkingSet(sets, 'back-squat', 0);
    expect(added.exercise_id).toBe('back-squat');
    expect(added.set_type).toBe('working');
    expect(added.weight_kg).toBeNull();
    expect(added.reps).toBeNull();
  });
});

describe('every other set type carries the same way — only a drop is skipped', () => {
  it.each(['backoff', 'amrap', 'failure', 'working'] as const)('after a %s set', (type) => {
    const added = emptyWorkingSet(
      [set({ set_type: type, weight_kg: 90, reps: 12 })],
      'back-squat',
      0,
    );
    expect(added.set_type).toBe('working');
    expect(added.weight_kg).toBe(90);
    expect(added.reps).toBe(12);
  });
});

describe('"+ Drop" is still the only thing that mints a drop', () => {
  it('emptyDropSet still yields a drop off a working set', () => {
    const drop = emptyDropSet(set(), 1);
    expect(drop.set_type).toBe('drop');
    expect(drop.weight_kg).toBe(100);
    expect(drop.reps).toBeNull();
  });

  it('emptySet itself still carries set_type — the trap the wrapper exists for', () => {
    // Pinned so a future "tidy-up" that changes `emptySet`'s default knows it
    // is changing `emptyDropSet`'s input too. If this needs to change, read
    // the comment on `emptySet`'s `set_type` line first.
    expect(emptySet('back-squat', 1, set({ set_type: 'drop' })).set_type).toBe('drop');
    expect(emptySet('back-squat', 1).set_type).toBe('working');
  });
});
