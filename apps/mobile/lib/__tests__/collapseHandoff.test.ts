import { groupKeys } from '../sessionCollapse';
import { groupSets } from '../sessions';
import {
  applySetsHandoff,
  chainHandoffs,
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

  it('chains a second write onto an unconsumed first, so the screen gets one correspondence from ITS rows', () => {
    // The screen's fold state still describes `[squat]`; handing it the second
    // handoff alone would describe `[deadlift]` rows it has never seen.
    recordSetsHandoff('user-a', 'session-1', handoffForSwap(rows('squat'), rows('deadlift')));
    recordSetsHandoff('user-a', 'session-1', handoffForSwap(rows('deadlift'), rows('bench')));
    expect(takeSetsHandoff('user-a', 'session-1')).toEqual({
      before: ['squat'],
      after: ['bench'],
      sourceOf: [0],
    });
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

describe('chainHandoffs', () => {
  it('composes a swap then an append through the first write', () => {
    const first = handoffForSwap(rows('squat', 'bench'), rows('deadlift', 'bench'));
    const second = handoffForAppend(rows('deadlift', 'bench'), rows('deadlift', 'bench', 'bench'));
    expect(chainHandoffs(first, second)).toEqual({
      before: ['squat', 'bench'],
      after: ['deadlift', 'bench', 'bench'],
      sourceOf: [0, 1, null],
    });
  });

  it('carries the FIRST write\'s new rows through as new — an append then a swap', () => {
    // Every other vector here starts with a swap, whose mapping is identity, so
    // skipping the first mapping entirely would still pass them.
    const first = handoffForAppend(rows('squat'), rows('squat', 'bench'));
    const second = handoffForSwap(rows('squat', 'bench'), rows('deadlift', 'bench'));
    expect(chainHandoffs(first, second)).toEqual({
      before: ['squat'],
      after: ['deadlift', 'bench'],
      sourceOf: [0, null],
    });
  });

  it('refuses when the second did not start from what the first wrote — every row reads as new', () => {
    const first = handoffForSwap(rows('squat', 'bench'), rows('deadlift', 'bench'));
    const second = handoffForSwap(rows('bench', 'deadlift'), rows('bench', 'row'));
    expect(chainHandoffs(first, second).sourceOf).toEqual([null, null]);
  });

  it('end to end: a double swap keeps the fold on the block the athlete folded', () => {
    // [squat, bench, squat], second squat folded. Swap squat -> deadlift, then
    // deadlift -> row, before the screen reloads between them.
    const s0 = rows('squat', 'bench', 'squat');
    const s1 = rows('deadlift', 'bench', 'deadlift');
    const s2 = rows('row', 'bench', 'row');
    const chained = chainHandoffs(handoffForSwap(s0, s1), handoffForSwap(s1, s2));
    const out = applySetsHandoff(new Set(['squat#1']), chained);
    expect(groupKeys(groupSets(s2)).map((k) => out.has(k))).toEqual([false, false, true]);
    // Applying only the second — the replaced-not-chained behaviour — loses it.
    const lost = applySetsHandoff(new Set(['squat#1']), handoffForSwap(s1, s2));
    expect(groupKeys(groupSets(s2)).map((k) => lost.has(k))).toEqual([false, false, false]);
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
