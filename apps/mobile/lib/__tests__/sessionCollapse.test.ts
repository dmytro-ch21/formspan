import {
  groupKeys,
  parseCollapsed,
  rekeyCollapsed,
  rekeyCollapsedAcross,
  summariseGroup,
  toggleGroup,
} from '../sessionCollapse';
import { groupSets, reorderedIndices, type LoggedSet } from '../sessions';

/**
 * Per-exercise "Done" (N530/#961, the user's item 7): the pure half.
 *
 * Every collapsed / expanded / summary state the screen can show is built
 * here from a set list and asserted on directly — no rendering, so there is
 * no state a test can claim that the screen could not reach. The load-bearing
 * property is the one N473 spent a ticket on: **nothing in this module can
 * write `completed`**, and the summary counts the ticks it finds rather than
 * the ticks a "Done" button might be imagined to grant.
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
  completed: false,
  performed_at: null,
  ...over,
});

describe('groupKeys', () => {
  it('keys each group by exercise and occurrence, in render order', () => {
    const groups = groupSets([
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'bench' }),
      set({ exercise_id: 'squat' }),
    ]);
    expect(groupKeys(groups)).toEqual(['squat#0', 'bench#0', 'squat#1']);
  });

  it('survives a set being added above the group', () => {
    // The reason keys are not indices: "+ Set" on the first group shifts every
    // later index, and a key that moved would unfold the group it named.
    const before = groupKeys(groupSets([set({ exercise_id: 'a' }), set({ exercise_id: 'b' })]));
    const after = groupKeys(
      groupSets([set({ exercise_id: 'a' }), set({ exercise_id: 'a' }), set({ exercise_id: 'b' })]),
    );
    expect(after).toEqual(before);
  });

  it('is empty for an empty session', () => {
    expect(groupKeys([])).toEqual([]);
  });
});

describe('toggleGroup', () => {
  it('collapses an open group', () => {
    expect([...toggleGroup(new Set(), 'squat#0')]).toEqual(['squat#0']);
  });

  it('re-expands a collapsed group', () => {
    expect([...toggleGroup(new Set(['squat#0']), 'squat#0')]).toEqual([]);
  });

  it('leaves other groups alone and never mutates its input', () => {
    const input = new Set(['bench#0']);
    const out = toggleGroup(input, 'squat#0');
    expect([...out].sort()).toEqual(['bench#0', 'squat#0']);
    expect([...input]).toEqual(['bench#0']);
  });
});

describe('parseCollapsed', () => {
  it('reads what saveCollapsedGroups writes', () => {
    expect(parseCollapsed(JSON.stringify(['squat#0', 'bench#1']))).toEqual(['squat#0', 'bench#1']);
  });

  it.each([null, undefined, '', 'not json', '{}', '42', '["a", 1, null]'])(
    'reads %p as nothing collapsed rather than throwing',
    (blob) => {
      const out = parseCollapsed(blob as string | null | undefined);
      // The mixed array keeps its strings and drops the rest — a partial blob
      // is still better honoured than discarded.
      expect(out).toEqual(blob === '["a", 1, null]' ? ['a'] : []);
    },
  );
});

describe('summariseGroup — the one line a collapsed group shows', () => {
  const kg = 'metric' as const;

  it('states ticked-of-total, and never claims more than was ticked', () => {
    const s = summariseGroup(
      [set({ completed: true }), set({ completed: true }), set({ completed: false })],
      kg,
    );
    expect(s.total).toBe(3);
    expect(s.ticked).toBe(2);
    expect(s.text).toBe('3 sets · 8 × 100kg · 2 of 3 done');
  });

  it('reads 0 of N when nothing is ticked — Done ticks nothing for you', () => {
    const s = summariseGroup([set(), set()], kg);
    expect(s.ticked).toBe(0);
    expect(s.text).toBe('2 sets · 8 × 100kg · 0 of 2 done');
  });

  it('reads N of N only when every row really is ticked', () => {
    const s = summariseGroup([set({ completed: true }), set({ completed: true })], kg);
    expect(s.text).toBe('2 sets · 8 × 100kg · 2 of 2 done');
  });

  it('singular for one set', () => {
    expect(summariseGroup([set({ completed: true })], kg).text).toBe('1 set · 8 × 100kg · 1 of 1 done');
  });

  it('describes the last NON-drop row, and counts the drop in the total', () => {
    // [working 100×8 ✓, drop 80×10 ✓, working 100×6 ✗]: the headline is the
    // 100×6 working set, and "2 of 3" counts the drop's own tick.
    const s = summariseGroup(
      [
        set({ completed: true }),
        set({ set_type: 'drop', weight_kg: 80, reps: 10, completed: true }),
        set({ reps: 6, completed: false }),
      ],
      kg,
    );
    expect(s.text).toBe('3 sets · 6 × 100kg · 2 of 3 done');
  });

  it('skips past a trailing drop to the working set it hangs off', () => {
    const s = summariseGroup(
      [set({ completed: true }), set({ set_type: 'drop', weight_kg: 80, reps: 10, completed: false })],
      kg,
    );
    expect(s.text).toBe('2 sets · 8 × 100kg · 1 of 2 done');
  });

  it('falls back to the drop itself when the group is all drops', () => {
    const s = summariseGroup([set({ set_type: 'drop', weight_kg: 80, reps: 10 })], kg);
    expect(s.text).toBe('1 set · 10 × 80kg · 0 of 1 done');
  });

  it('omits the description when nothing is recorded yet', () => {
    // "3 sets · Not recorded · 0 of 3 done" is noise; the count is the fact.
    const blank = set({ reps: null, weight_kg: null });
    expect(summariseGroup([blank, blank, blank], kg).text).toBe('3 sets · 0 of 3 done');
  });

  it('renders in the units and duration scale it is given', () => {
    const s = summariseGroup([set({ seconds: 90, completed: true })], 'imperial', 'minutes');
    expect(s.text).toContain('lb');
    expect(s.text).toContain('1:30');
  });

  it('is a pure read — the input rows are untouched', () => {
    const rows = [set(), set({ completed: true })];
    const snapshot = JSON.stringify(rows);
    summariseGroup(rows, kg);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

/**
 * N543/#981 — a removal must not hand one block's fold state to another.
 *
 * `groupKeys` numbers by occurrence, so removing `squat#0` renames the
 * surviving `squat#1` to `squat#0`. Nothing in the screen touched the
 * `collapsed` set on removal, so the survivor inherited whatever the removed
 * block's key had been — folded a block nobody folded, or lost a fold nobody
 * undid, depending on which one went.
 *
 * These tests run the screen's OWN removal path (`removeOnScreen` below is
 * the two lines `removeGroup` runs), not the helper in isolation: a helper
 * that is right and uncalled is the failure this ticket is about.
 */
describe('rekeyCollapsed — removing a block leaves every survivor as the athlete left it', () => {
  const circuit = () => [
    set({ exercise_id: 'squat' }),
    set({ exercise_id: 'bench' }),
    set({ exercise_id: 'squat' }),
  ];

  /** What `removeGroup` does: drop the group's set indices, rekey the folds. */
  function removeOnScreen(sets: LoggedSet[], collapsed: ReadonlySet<string>, groupIndex: number) {
    const drop = new Set(groupSets(sets)[groupIndex].indices);
    const surviving = sets.map((_, i) => i).filter((i) => !drop.has(i));
    return {
      sets: surviving.map((i, position) => ({ ...sets[i], position })),
      collapsed: rekeyCollapsed(collapsed, sets, surviving),
    };
  }

  /** Which exercise blocks read as folded, in render order. */
  function foldedBlocks(sets: LoggedSet[], collapsed: ReadonlySet<string>): boolean[] {
    return groupKeys(groupSets(sets)).map((k) => collapsed.has(k));
  }

  it('the keys are the ones the bug renames', () => {
    // Not decoration: every case below turns on `squat#1` becoming `squat#0`.
    expect(groupKeys(groupSets(circuit()))).toEqual(['squat#0', 'bench#0', 'squat#1']);
  });

  it('folds the SECOND squat, removes the first — the survivor stays folded', () => {
    // #981's acceptance criterion, with the expectation corrected: the block
    // that survives here IS the one the athlete tapped Done on, so "expanded"
    // would assert the bug. Today's code drops the fold, because the stale
    // `squat#1` names nothing after the rename.
    const sets = circuit();
    const out = removeOnScreen(sets, toggleGroup(new Set(), 'squat#1'), 0);
    expect(groupKeys(groupSets(out.sets))).toEqual(['bench#0', 'squat#0']);
    expect(foldedBlocks(out.sets, out.collapsed)).toEqual([false, true]);
  });

  it('folds the FIRST squat, removes it — the survivor is NOT folded', () => {
    // The issue's own prose: the stale `squat#0` is inherited by a block the
    // athlete never tapped, which renders it shut mid-workout.
    const sets = circuit();
    const out = removeOnScreen(sets, toggleGroup(new Set(), 'squat#0'), 0);
    expect(foldedBlocks(out.sets, out.collapsed)).toEqual([false, false]);
    expect([...out.collapsed]).toEqual([]);
  });

  it('folds the FIRST squat, removes the SECOND — the fold stays where it was', () => {
    const sets = circuit();
    const out = removeOnScreen(sets, toggleGroup(new Set(), 'squat#0'), 2);
    expect(groupKeys(groupSets(out.sets))).toEqual(['squat#0', 'bench#0']);
    expect(foldedBlocks(out.sets, out.collapsed)).toEqual([true, false]);
  });

  it('folds the SECOND squat, removes the bench between them — the two squats merge, unfolded', () => {
    // Adjacency IS the grouping, so deleting the bench welds the squats into
    // ONE block. Half of it was folded and half was not; the honest answer is
    // open, because folding rows the athlete never folded hides work.
    const sets = circuit();
    const out = removeOnScreen(sets, toggleGroup(new Set(), 'squat#1'), 1);
    expect(groupKeys(groupSets(out.sets))).toEqual(['squat#0']);
    expect(foldedBlocks(out.sets, out.collapsed)).toEqual([false]);
  });

  it('folds BOTH squats, removes the bench — the merged block stays folded', () => {
    const sets = circuit();
    const both = toggleGroup(toggleGroup(new Set(), 'squat#0'), 'squat#1');
    const out = removeOnScreen(sets, both, 1);
    expect(foldedBlocks(out.sets, out.collapsed)).toEqual([true]);
  });

  it('drops keys for blocks that no longer exist, so collapsed_json cannot accumulate', () => {
    const sets = circuit();
    const out = removeOnScreen(sets, new Set(['squat#0', 'bench#0', 'squat#1', 'deadlift#0']), 1);
    // One merged squat block survives; bench's key and the never-real
    // deadlift key both go, rather than sitting in the row forever.
    expect([...out.collapsed]).toEqual(['squat#0']);
  });

  it('removing the LAST set of a block removes the block, same rename, same guarantee', () => {
    // `removeSet` runs the identical path — a one-set block is an exercise.
    const sets = circuit();
    const surviving = [1, 2]; // drop set 0, which is all of squat#0
    const collapsed = rekeyCollapsed(toggleGroup(new Set(), 'squat#0'), sets, surviving);
    expect([...collapsed]).toEqual([]);
  });

  it('a reorder that welds two same-exercise blocks together keeps the fold on its own block', () => {
    // The case N543's first draft argued away, reproduced by
    // `frontend-reviewer` against the real functions: squat / bench / squat /
    // deadlift / squat, move the BENCH down one place, and the two leading
    // squats become adjacent and merge — renaming `squat#2` to `squat#1`.
    // One tap of an existing arrow, no removal anywhere.
    const sets = [
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'bench' }),
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'deadlift' }),
      set({ exercise_id: 'squat' }),
    ];
    expect(groupKeys(groupSets(sets))).toEqual([
      'squat#0',
      'bench#0',
      'squat#1',
      'deadlift#0',
      'squat#2',
    ]);
    const order = groupSets(sets).map((g) => g.indices);
    const moved = reorderedIndices(order, 1, 1);
    expect(moved).not.toBeNull();
    const after = moved!.map((i, position) => ({ ...sets[i], position }));
    expect(groupKeys(groupSets(after))).toEqual([
      'squat#0',
      'bench#0',
      'deadlift#0',
      'squat#1',
    ]);

    // The athlete folded the LAST squat. It must still be the folded one.
    const out = rekeyCollapsed(new Set(['squat#2']), sets, moved!);
    expect(foldedBlocks(after, out)).toEqual([false, false, false, true]);
  });

  it('a plain reorder of two different exercises renames nothing', () => {
    const sets = [
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'bench' }),
      set({ exercise_id: 'deadlift' }),
    ];
    const order = groupSets(sets).map((g) => g.indices);
    const moved = reorderedIndices(order, 1, 1)!; // bench and deadlift swap
    const after = moved.map((i, position) => ({ ...sets[i], position }));
    const out = rekeyCollapsed(new Set(['squat#0', 'bench#0']), sets, moved);
    expect(groupKeys(groupSets(after))).toEqual(['squat#0', 'deadlift#0', 'bench#0']);
    expect(foldedBlocks(after, out)).toEqual([true, false, true]);
  });

  it('ignores an index that names no set, rather than sliding the rest by one', () => {
    // The out-of-range filter has to run BEFORE the rows are mapped: filter
    // afterwards and `after`'s indices fall out of step with `surviving`'s,
    // which reads as a confident wrong answer. 99 names nothing; the two real
    // survivors must still land on their own blocks.
    const sets = circuit();
    expect([...rekeyCollapsed(new Set(['squat#1']), sets, [99, 1, 2])]).toEqual(['squat#0']);
    expect([...rekeyCollapsed(new Set(['squat#1']), sets, [-1, 1, 2])]).toEqual(['squat#0']);
  });

  it('is a pure read — neither the sets nor the input set are touched', () => {
    const sets = circuit();
    const snapshot = JSON.stringify(sets);
    const input = new Set(['squat#1']);
    rekeyCollapsed(input, sets, [1, 2]);
    expect(JSON.stringify(sets)).toBe(snapshot);
    expect([...input]).toEqual(['squat#1']);
  });

  it('an unchanged set list is left exactly as it was', () => {
    const sets = circuit();
    const all = sets.map((_, i) => i);
    expect([...rekeyCollapsed(new Set(['squat#1']), sets, all)]).toEqual(['squat#1']);
  });
});

/*
  F35/#999 — a swap or an append written OFF the session screen.

  The exercise picker and photo identify write straight to SQLite, so the screen
  only sees the result on focus. A swap changes `exercise_id`, which the removal
  and reorder cases above never do — so each case below first asserts what
  TODAY's code does (carry `collapsed` unchanged, because nothing rebuilt it) and
  shows it is wrong, then asserts the rekeyed answer. A test that only asserted
  the fix would stay green if the bug came back.
*/
describe('rekeyCollapsedAcross — a swap or an append written off-screen (F35/#999)', () => {
  const foldedAfter = (after: LoggedSet[], collapsed: ReadonlySet<string>): boolean[] =>
    groupKeys(groupSets(after)).map((k) => collapsed.has(k));
  /** What `swapExercise` does to exercise ids: EVERY row of `from` becomes `to`. */
  const swapAll = (sets: LoggedSet[], from: string, to: string): LoggedSet[] =>
    sets.map((s) => (s.exercise_id === from ? { ...s, exercise_id: to } : s));
  const identity = (rows: readonly unknown[]): number[] => rows.map((_, i) => i);

  it('a swapped block keeps the fold the athlete gave it, under its new name', () => {
    const before = [
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'bench' }),
      set({ exercise_id: 'squat' }),
    ];
    const collapsed = new Set(['squat#1']);
    const after = swapAll(before, 'squat', 'deadlift');
    expect(groupKeys(groupSets(after))).toEqual(['deadlift#0', 'bench#0', 'deadlift#1']);

    // Today: `squat#1` names nothing any more, so the fold is silently dropped.
    expect(foldedAfter(after, collapsed)).toEqual([false, false, false]);

    const out = rekeyCollapsedAcross(collapsed, before, after, identity(after));
    expect(foldedAfter(after, out)).toEqual([false, false, true]);
  });

  it("a swap that welds a block to a folded neighbour does not hand it the neighbour's fold", () => {
    // #999's merge case, constructed: squat / bench / deadlift, only the deadlift
    // folded. Swap the bench for a deadlift, and the two deadlifts are adjacent,
    // so `groupSets` welds them into one block.
    const before = [
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'bench' }),
      set({ exercise_id: 'deadlift' }),
    ];
    const collapsed = new Set(['deadlift#0']);
    const after = swapAll(before, 'bench', 'deadlift');
    expect(groupKeys(groupSets(after))).toEqual(['squat#0', 'deadlift#0']);

    // Today: the stale `deadlift#0` now names the WELDED block, so the swapped-in
    // half is folded shut without the athlete ever tapping Done on it.
    expect(foldedAfter(after, collapsed)).toEqual([false, true]);

    const out = rekeyCollapsedAcross(collapsed, before, after, identity(after));
    expect(foldedAfter(after, out)).toEqual([false, false]);
  });

  it('a weld whose halves were BOTH folded stays folded', () => {
    const before = [
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'bench' }),
      set({ exercise_id: 'deadlift' }),
    ];
    const collapsed = new Set(['bench#0', 'deadlift#0']);
    const after = swapAll(before, 'bench', 'deadlift');
    const out = rekeyCollapsedAcross(collapsed, before, after, identity(after));
    expect(foldedAfter(after, out)).toEqual([false, true]);
  });

  it('a swap renames later blocks of the exercise swapped TO, and the fold stays on its own block', () => {
    // squat / deadlift / bench, the BENCH folded. Swap the squat for a bench and
    // a new bench now precedes it: the athlete's block is renamed `bench#0` →
    // `bench#1`, and `bench#0` becomes the block they never touched.
    const before = [
      set({ exercise_id: 'squat' }),
      set({ exercise_id: 'deadlift' }),
      set({ exercise_id: 'bench' }),
    ];
    const collapsed = new Set(['bench#0']);
    const after = swapAll(before, 'squat', 'bench');
    expect(groupKeys(groupSets(after))).toEqual(['bench#0', 'deadlift#0', 'bench#1']);

    // Today: the fold jumps to the swapped-in bench at the top.
    expect(foldedAfter(after, collapsed)).toEqual([true, false, false]);

    const out = rekeyCollapsedAcross(collapsed, before, after, identity(after));
    expect(foldedAfter(after, out)).toEqual([false, false, true]);
  });

  it('an exercise appended into a folded last block opens it, so the new set is not hidden', () => {
    // squat / bench with the bench folded; add another bench. It welds into the
    // folded block, which today renders it hidden under a header the athlete
    // closed before the set existed.
    const before = [set({ exercise_id: 'squat' }), set({ exercise_id: 'bench' })];
    const collapsed = new Set(['bench#0']);
    const after = [...before, set({ exercise_id: 'bench' })];
    expect(groupKeys(groupSets(after))).toEqual(['squat#0', 'bench#0']);

    expect(foldedAfter(after, collapsed)).toEqual([false, true]);

    const out = rekeyCollapsedAcross(collapsed, before, after, [0, 1, null]);
    expect(foldedAfter(after, out)).toEqual([false, false]);
  });

  it('appending a different exercise leaves every existing fold where it was', () => {
    const before = [set({ exercise_id: 'squat' }), set({ exercise_id: 'bench' })];
    const after = [...before, set({ exercise_id: 'deadlift' })];
    const out = rekeyCollapsedAcross(new Set(['squat#0']), before, after, [0, 1, null]);
    expect(foldedAfter(after, out)).toEqual([true, false, false]);
  });

  it('a source that names no row reads as never folded, rather than borrowing a neighbour', () => {
    // This pins the OUTCOME, not the range check: an out-of-range index would
    // also land on `undefined` through the lookups and read as unfolded. The
    // check is kept because relying on that chain is the kind of thing a later
    // refactor breaks without noticing; the `[]` case is the `null` branch.
    const before = [set({ exercise_id: 'squat' })];
    const after = [set({ exercise_id: 'squat' })];
    expect([...rekeyCollapsedAcross(new Set(['squat#0']), before, after, [7])]).toEqual([]);
    expect([...rekeyCollapsedAcross(new Set(['squat#0']), before, after, [])]).toEqual([]);
  });
});
