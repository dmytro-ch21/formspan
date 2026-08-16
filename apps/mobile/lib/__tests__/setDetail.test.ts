import {
  dropsOf,
  emptyDropSet,
  setOrdinals,
  soloReps,
  withSetChange,
  type LoggedSet,
} from '../sessions';

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'bench-press',
  position: 0,
  set_type: 'working',
  reps: 8,
  weight_kg: 102.5,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: true,
  ...over,
});

describe('what you did unaided', () => {
  it('subtracts the help', () => {
    // "225 for 5, then 3 more with a spotter" — 8 reps of work, 5 of
    // capability, and the second number is the one to train against.
    expect(soloReps(set({ reps: 8, assisted_reps: 3 }))).toBe(5);
  });

  it('treats unrecorded as all-solo, never as none', () => {
    // Every set logged before the field existed has no value. Reading that as
    // zero solo reps would revise an athlete's whole history downward.
    expect(soloReps(set({ reps: 8 }))).toBe(8);
    expect(soloReps(set({ reps: 8, assisted_reps: null }))).toBe(8);
    // An explicit zero is a different claim and lands in the same place.
    expect(soloReps(set({ reps: 8, assisted_reps: 0 }))).toBe(8);
  });

  it('never goes negative', () => {
    // The server rejects this, so it can only be an in-progress edit — but a
    // negative rep count must not reach a tile.
    expect(soloReps(set({ reps: 3, assisted_reps: 5 }))).toBe(0);
    expect(soloReps(set({ reps: null, assisted_reps: 2 }))).toBe(0);
  });
});

describe('a drop set', () => {
  it('carries the weight down but clears the reps', () => {
    // The weight is the number to edit DOWN from; the reps are the one field
    // certainly wrong at a lower weight, so prefilling them would be a lie
    // that reads as a suggestion.
    const drop = emptyDropSet(set({ reps: 3, weight_kg: 102.5 }), 1);
    expect(drop.set_type).toBe('drop');
    expect(drop.weight_kg).toBe(102.5);
    expect(drop.reps).toBeNull();
    expect(drop.completed).toBe(false);
  });

  it('carries no effort or assistance forward', () => {
    // Both are judgements about one set. Prefilling either records something
    // nobody assessed.
    const drop = emptyDropSet(set({ rir: 1, rpe: 9, assisted_reps: 2 }), 1);
    expect(drop.rir).toBeNull();
    expect(drop.rpe).toBeNull();
    expect(drop.assisted_reps ?? null).toBeNull();
  });
});

describe('which set a drop came off', () => {
  const sets = [
    set({ position: 0, reps: 3 }),
    set({ position: 1, set_type: 'drop', reps: 8, weight_kg: 84 }),
    set({ position: 2, set_type: 'drop', reps: 6, weight_kg: 60 }),
    set({ position: 3, reps: 3 }),
  ];

  it('takes the consecutive run that follows it', () => {
    expect(dropsOf(sets, 0).map((d) => d.weight_kg)).toEqual([84, 60]);
    expect(dropsOf(sets, 3)).toEqual([]);
  });

  it('is never claimed by a drop itself', () => {
    expect(dropsOf(sets, 1)).toEqual([]);
  });

  it('stops at a different exercise, so a stray row is orphaned not stolen', () => {
    // Contiguity, matching the server. Attaching across exercises would put
    // reps under a lift they were never performed on — worse than showing an
    // orphan.
    const mixed = [
      set({ exercise_id: 'squat', position: 0 }),
      set({ exercise_id: 'bench-press', position: 1, set_type: 'drop' }),
    ];
    expect(dropsOf(mixed, 0)).toEqual([]);
  });

  it('is safe at the edges', () => {
    for (const i of [-1, 99]) expect(dropsOf(sets, i)).toEqual([]);
    expect(dropsOf([], 0)).toEqual([]);
  });
});

describe('set numbering', () => {
  const t = (...types: string[]) =>
    setOrdinals(types.map((set_type) => ({ set_type: set_type as LoggedSet['set_type'] })));

  it('does not spend a set number on a drop', () => {
    // 225x3 then 185x8 is ONE set with a drop off it. Numbering them 3 and 4
    // tells the athlete they did four sets when they did three — and that is
    // the count they carry around and compare to last week.
    expect(t('working', 'drop', 'working')).toEqual([1, 1, 2]);
  });

  it('gives every drop in a run its parent’s number', () => {
    expect(t('working', 'drop', 'drop', 'working')).toEqual([1, 1, 1, 2]);
  });

  it('numbers ordinary sets consecutively', () => {
    expect(t('warmup', 'working', 'working')).toEqual([1, 2, 3]);
  });

  it('does not show a zero for a leading drop', () => {
    // A drop with nothing above it is a client bug. It still has to render,
    // and "set 0" is the one thing it must not say.
    expect(t('drop', 'working')).toEqual([1, 1]);
  });

  it('is empty for no sets', () => {
    expect(t()).toEqual([]);
  });
});

describe('editing reps after assistance was recorded', () => {
  it('clamps the help down when the reps are corrected down', () => {
    // The gap the assisted-input clamp misses entirely: 10 reps with 8
    // assisted, then the athlete fixes the count to 5. Left alone the set
    // claims more help than work, the CHECK refuses it, and the next save
    // fails with a 400 naming a field they never touched.
    const before = set({ reps: 10, assisted_reps: 8 });
    expect(withSetChange(before, { reps: 5 }).assisted_reps).toBe(5);
  });

  it('leaves a still-valid value alone', () => {
    const before = set({ reps: 10, assisted_reps: 3 });
    expect(withSetChange(before, { reps: 8 }).assisted_reps).toBe(3);
  });

  it('clears the help when the reps are cleared', () => {
    // "3 of them were assisted" is a claim about a rep count. A claim about
    // nothing is not a smaller claim — it is a row the database rejects.
    expect(withSetChange(set({ reps: 8, assisted_reps: 3 }), { reps: null }).assisted_reps).toBeNull();
  });

  it('does not invent a value on a set that never had one', () => {
    const changed = withSetChange(set({ reps: 8, assisted_reps: undefined }), { reps: 5 });
    expect(changed.assisted_reps ?? null).toBeNull();
  });

  it('passes other measures through untouched', () => {
    const changed = withSetChange(set({ reps: 8, assisted_reps: 3 }), { weight_kg: 60 });
    expect(changed.weight_kg).toBe(60);
    expect(changed.assisted_reps).toBe(3);
  });
});
