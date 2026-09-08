import { groupKeys, parseCollapsed, summariseGroup, toggleGroup } from '../sessionCollapse';
import { groupSets, type LoggedSet } from '../sessions';

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
