/**
 * N553/#1019 — the arithmetic behind "put the eggs above the toast".
 *
 * Every rule here is one that would otherwise only be discovered on a device,
 * usually as an order that quietly stopped matching what the athlete arranged:
 * a gap that ran out and produced two equal positions, a move that renumbered
 * a meal it did not need to, an index that was one place off because the
 * dragged row was counted twice.
 */
import {
  POSITION_BOUND,
  POSITION_STEP,
  appendPosition,
  between,
  insertAt,
  needsRebalance,
  ordered,
  plan,
  planInto,
  rebalanced,
} from '../entryOrder';

const at = (id: string, position: number) => ({ id, position });

/** A meal on the grid: 1024, 2048, 3072. */
const meal = [at('a', 1024), at('b', 2048), at('c', 3072)];

describe('compareEntries', () => {
  it('orders by position', () => {
    expect(ordered([at('c', 3072), at('a', 1024), at('b', 2048)]).map((e) => e.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  // THE CONVERGENCE GUARANTEE, and the reason it is a property rather than a
  // hope. Two devices reordering the same meal offline can independently
  // compute the same number for two different rows. Ordering by position
  // ALONE leaves those two in whatever order the array happened to hold, which
  // differs per device — so two synced phones would show different breakfasts
  // with no way to say which was right. The id is a client-generated UUID, so
  // the tiebreak is the same everywhere, including in the server's own ORDER
  // BY and in `localEntries`'s SQL.
  it('breaks a tie by id, so every device agrees', () => {
    const one = ordered([at('z', 1024), at('a', 1024)]).map((e) => e.id);
    const other = ordered([at('a', 1024), at('z', 1024)]).map((e) => e.id);
    expect(one).toEqual(['a', 'z']);
    expect(other).toEqual(['a', 'z']);
  });

  it('sorts a copy — the caller list is not mutated', () => {
    const rows = [at('c', 3072), at('a', 1024)];
    ordered(rows);
    expect(rows.map((e) => e.id)).toEqual(['c', 'a']);
  });
});

describe('appendPosition', () => {
  it('starts an empty meal at one step, not at zero', () => {
    expect(appendPosition([])).toBe(POSITION_STEP);
  });

  it('is one step past the LAST, whatever order the siblings arrive in', () => {
    expect(appendPosition(meal)).toBe(4096);
    expect(appendPosition([...meal].reverse())).toBe(4096);
  });

  it('is past the last even when the meal has been dragged into negatives', () => {
    expect(appendPosition([at('a', -5000), at('b', -1000)])).toBe(-1000 + POSITION_STEP);
  });
});

describe('between', () => {
  it('is the midpoint of two neighbours', () => {
    expect(between(1024, 2048)).toBe(1536);
  });

  it('is one step BELOW the first when dropping at the top — which may be negative', () => {
    expect(between(null, 1024)).toBe(0);
    expect(between(null, 0)).toBe(-1024);
    expect(between(null, -1024)).toBe(-2048);
  });

  it('is one step past the last when dropping at the bottom', () => {
    expect(between(3072, null)).toBe(4096);
  });

  it('is one step for a meal with nothing in it', () => {
    expect(between(null, null)).toBe(POSITION_STEP);
  });

  // The rebalance signal. `Math.floor((1 + 2) / 2)` is 1, which is NOT
  // strictly between 1 and 2 — a rounding rule alone would return it and two
  // rows would silently share a position.
  it('is null when there is no integer strictly between the neighbours', () => {
    expect(between(1, 2)).toBeNull();
    expect(between(1024, 1025)).toBeNull();
    expect(between(1024, 1024)).toBeNull();
    // One more apart is the last case that still fits.
    expect(between(1024, 1026)).toBe(1025);
  });
});

describe('needsRebalance', () => {
  it('is true for no room', () => {
    expect(needsRebalance(null)).toBe(true);
  });

  it('is true past the bound in either direction, where a JS number stops being exact', () => {
    expect(needsRebalance(POSITION_BOUND)).toBe(true);
    expect(needsRebalance(-POSITION_BOUND)).toBe(true);
    expect(needsRebalance(POSITION_BOUND - 1)).toBe(false);
  });

  it('is false for an ordinary position, including zero and negatives', () => {
    expect(needsRebalance(0)).toBe(false);
    expect(needsRebalance(-4096)).toBe(false);
  });
});

describe('rebalanced', () => {
  it('puts a meal back on the grid, keeping the order given', () => {
    expect(rebalanced([at('c', 5), at('a', 6), at('b', 7)])).toEqual([
      { id: 'c', position: 1024 },
      { id: 'a', position: 2048 },
      { id: 'b', position: 3072 },
    ]);
  });

  // A partial renumber is how a meal ends up with a gap in the middle and the
  // next move fails again in the same place.
  it('writes EVERY row, including ones whose number does not change', () => {
    expect(rebalanced(meal)).toHaveLength(3);
  });
});

describe('plan — a reorder inside one meal', () => {
  // THE CRITERION: reordering N rows does not write N rows. Everything else in
  // this scheme exists to make this true.
  it('writes ONE row — the one that moved', () => {
    const p = plan(meal, 'c', 0);
    expect(p.writes).toEqual([{ id: 'c', position: 0 }]);
    expect(p.rebalanced).toBe(false);
  });

  it('drops a row between two others at their midpoint', () => {
    expect(plan(meal, 'a', 1).writes).toEqual([{ id: 'a', position: 2560 }]);
  });

  it('drops a row at the end one step past the last', () => {
    expect(plan(meal, 'a', 2).writes).toEqual([{ id: 'a', position: 4096 }]);
  });

  it('actually reorders — the plan applied gives the sequence the athlete dragged', () => {
    const p = plan(meal, 'c', 0);
    const applied = meal.map((e) => {
      const w = p.writes.find((x) => x.id === e.id);
      return w ? at(e.id, w.position) : e;
    });
    expect(ordered(applied).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  // A write marks the row dirty, and a dirty row is one `entrySyncState`
  // reports as `owed`, which disables sharing with "Save your changes first".
  // A finger that lifted where it started must not cost the athlete a share.
  it('writes NOTHING for a move that changes nothing', () => {
    expect(plan(meal, 'b', 1).writes).toEqual([]);
    expect(plan(meal, 'a', 0).writes).toEqual([]);
  });

  it('writes nothing for an id that is not in the meal', () => {
    expect(plan(meal, 'nope', 0).writes).toEqual([]);
  });

  it('clamps an index past either end rather than producing a hole', () => {
    expect(plan(meal, 'a', 99).writes).toEqual([{ id: 'a', position: 4096 }]);
    expect(plan(meal, 'c', -5).writes).toEqual([{ id: 'c', position: 0 }]);
  });

  it('renumbers the whole meal, and only then, when the gap has run out', () => {
    const tight = [at('a', 1024), at('b', 1025), at('c', 3072)];
    const p = plan(tight, 'c', 1);
    expect(p.rebalanced).toBe(true);
    expect(p.writes).toEqual([
      { id: 'a', position: 1024 },
      { id: 'c', position: 2048 },
      { id: 'b', position: 3072 },
    ]);
  });

  // Ten halvings at one spot, then the eleventh rebalances — the number 1024
  // was chosen for exactly this and nothing checks it anywhere else.
  it('survives ten successive drops at the SAME spot before needing a rebalance', () => {
    let rows = [at('a', 1024), at('b', 2048)];
    let rebalances = 0;
    for (let i = 0; i < 10; i += 1) {
      const p = plan([...rows, at(`x${i}`, 99999)], `x${i}`, 1);
      if (p.rebalanced) rebalances += 1;
      const w = p.writes.find((x) => x.id === `x${i}`);
      rows = ordered([...rows, at(`x${i}`, w!.position)]);
    }
    expect(rebalances).toBe(0);
    // Every row still has its own number: no two rows collided on the way.
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
  });
});

describe('planInto — a move onto ANOTHER meal', () => {
  it('gives the row a position inside the meal it joined', () => {
    expect(planInto(meal, 'x', 1).writes).toEqual([{ id: 'x', position: 1536 }]);
  });

  it('appends when the drop named the meal but no slot inside it', () => {
    expect(planInto(meal, 'x', meal.length).writes).toEqual([{ id: 'x', position: 4096 }]);
  });

  it('starts an empty meal at one step', () => {
    expect(planInto([], 'x', 0).writes).toEqual([{ id: 'x', position: POSITION_STEP }]);
  });

  it('rebalances the DESTINATION when it has no room, moved row included', () => {
    const tight = [at('a', 1024), at('b', 1025)];
    const p = planInto(tight, 'x', 1);
    expect(p.rebalanced).toBe(true);
    expect(p.writes).toEqual([
      { id: 'a', position: 1024 },
      { id: 'x', position: 2048 },
      { id: 'b', position: 3072 },
    ]);
  });
});

describe('insertAt is the one primitive under both', () => {
  // Stated as a test because the alternative — two implementations of "what
  // number goes between these rows" — is how a rebalance ends up living in
  // only one of them.
  it('agrees with plan for a move inside a meal', () => {
    const others = meal.filter((e) => e.id !== 'c');
    expect(insertAt(others, 'c', 0)).toEqual(plan(meal, 'c', 0));
  });

  it('agrees with planInto for a move onto another meal', () => {
    expect(insertAt(meal, 'x', 2)).toEqual(planInto(meal, 'x', 2));
  });
});
