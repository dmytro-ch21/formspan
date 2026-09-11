import { groupKeys } from '../sessionCollapse';
import { groupSets } from '../sessions';
import {
  applySetsHandoff,
  handoffForAppend,
  handoffForSwap,
  handoffStillApplies,
  recordSetsHandoff,
  takeSetsHandoff,
} from '../collapseHandoff';

/**
 * F35/#999 — the handoff an off-screen set writer leaves the session screen.
 *
 * The rekey arithmetic is pinned in `sessionCollapse.test.ts`. This pins the
 * three things that make a handoff safe to apply at all: that it is consumed
 * exactly once, that it reaches only the session it was written for, and that
 * it is refused when the rows it describes are no longer the rows in SQLite.
 */

const rows = (...ids: string[]) => ids.map((exercise_id) => ({ exercise_id }));

describe('takeSetsHandoff', () => {
  it('returns a recorded handoff once, then nothing', () => {
    const h = handoffForSwap(rows('squat'), rows('deadlift'));
    recordSetsHandoff('user-a', 'session-1', h);
    expect(takeSetsHandoff('user-a', 'session-1')).toEqual(h);
    // Consumed: a second focus must not re-apply a rekey to already-rekeyed keys.
    expect(takeSetsHandoff('user-a', 'session-1')).toBeNull();
  });

  it('is keyed by user AND session, so no other session or user ever receives it', () => {
    recordSetsHandoff('user-a', 'session-1', handoffForSwap(rows('squat'), rows('deadlift')));
    expect(takeSetsHandoff('user-a', 'session-2')).toBeNull();
    expect(takeSetsHandoff('user-b', 'session-1')).toBeNull();
    expect(takeSetsHandoff('user-a', 'session-1')).not.toBeNull();
  });

  it('keeps only the latest unconsumed handoff for a session', () => {
    recordSetsHandoff('user-a', 'session-1', handoffForSwap(rows('squat'), rows('deadlift')));
    const later = handoffForSwap(rows('deadlift'), rows('bench'));
    recordSetsHandoff('user-a', 'session-1', later);
    expect(takeSetsHandoff('user-a', 'session-1')).toEqual(later);
  });
});

describe('handoffForSwap', () => {
  it('is identity by index for a same-length swap', () => {
    const h = handoffForSwap(rows('squat', 'bench', 'squat'), rows('deadlift', 'bench', 'deadlift'));
    expect(h.sourceOf).toEqual([0, 1, 2]);
    expect(h.before).toEqual(['squat', 'bench', 'squat']);
    expect(h.after).toEqual(['deadlift', 'bench', 'deadlift']);
  });

  it('claims no correspondence when the length changed — every row reads as new', () => {
    expect(handoffForSwap(rows('squat', 'bench'), rows('squat')).sourceOf).toEqual([null]);
  });
});

describe('handoffForAppend', () => {
  it('maps the untouched prefix and marks the appended rows as new', () => {
    expect(handoffForAppend(rows('squat', 'bench'), rows('squat', 'bench', 'bench')).sourceOf).toEqual([
      0,
      1,
      null,
    ]);
  });

  it('claims no correspondence when the prefix was not preserved', () => {
    expect(handoffForAppend(rows('squat', 'bench'), rows('bench', 'bench', 'squat')).sourceOf).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('handoffStillApplies', () => {
  const h = handoffForSwap(rows('squat', 'bench'), rows('deadlift', 'bench'));

  it('applies when SQLite holds exactly the rows the writer wrote', () => {
    expect(handoffStillApplies(h, rows('deadlift', 'bench'))).toBe(true);
  });

  it('refuses a different length — something added or removed a row since', () => {
    expect(handoffStillApplies(h, rows('deadlift', 'bench', 'bench'))).toBe(false);
    expect(handoffStillApplies(h, rows('deadlift'))).toBe(false);
  });

  it('refuses a different exercise at any index — something relabelled or reordered since', () => {
    expect(handoffStillApplies(h, rows('bench', 'deadlift'))).toBe(false);
    expect(handoffStillApplies(h, rows('squat', 'bench'))).toBe(false);
  });
});

describe('applySetsHandoff — end to end, #999 merge case', () => {
  it('the welded block is not folded when only one of its halves was', () => {
    const before = rows('squat', 'bench', 'deadlift');
    const after = rows('squat', 'deadlift', 'deadlift');
    const out = applySetsHandoff(new Set(['deadlift#0']), handoffForSwap(before, after));
    expect(groupKeys(groupSets(after)).map((k) => out.has(k))).toEqual([false, false]);
  });
});
