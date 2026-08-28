import type { ClassPlanBlock } from '../classplans';
import {
  advanced,
  blockSeconds,
  canAdvance,
  canGoBack,
  currentBlock,
  deadlineFor,
  remainingAt,
  startRun,
  upcomingBlock,
  wentBack,
  type RunState,
} from '../classPlanRun';

const block = (over: Partial<ClassPlanBlock> = {}): ClassPlanBlock => ({
  order: 0,
  type: 'warmup',
  duration_minutes: 10,
  notes: '',
  ...over,
});

describe('walking a class plan', () => {
  const blocks = [
    block({ order: 0, type: 'warmup', duration_minutes: 10 }),
    block({ order: 1, type: 'technique_drill', duration_minutes: 20, technique_id: 't1' }),
    block({ order: 2, type: 'live_rounds', duration_minutes: 15 }),
  ];

  it('starts at the first block', () => {
    const run = startRun(blocks);
    expect(run.at).toBe(0);
    expect(currentBlock(run)).toBe(blocks[0]);
  });

  it('advances one block at a time and signals completion at the end', () => {
    let run: RunState | null = startRun(blocks);
    const seen: string[] = [];
    while (run) {
      seen.push(currentBlock(run)!.type);
      run = advanced(run);
    }
    expect(seen).toEqual(['warmup', 'technique_drill', 'live_rounds']);
  });

  it('reports whether there is a next block to advance into', () => {
    expect(canAdvance(startRun(blocks))).toBe(true);
    expect(canAdvance({ blocks, at: 2 })).toBe(false);
  });

  it('reports whether there is a previous block to go back to', () => {
    expect(canGoBack(startRun(blocks))).toBe(false);
    expect(canGoBack({ blocks, at: 1 })).toBe(true);
  });

  it('shows next up without moving position', () => {
    const run = startRun(blocks);
    expect(upcomingBlock(run)?.type).toBe('technique_drill');
    expect(run.at).toBe(0);
  });

  it('has no next block on the last one', () => {
    expect(upcomingBlock({ blocks, at: 2 })).toBeNull();
  });

  it('goes back a block', () => {
    const run: RunState = { blocks, at: 2 };
    const back = wentBack(run);
    expect(back.at).toBe(1);
  });

  it('going back from the first block is a no-op, not a crash', () => {
    const run = startRun(blocks);
    const back = wentBack(run);
    expect(back.at).toBe(0);
    expect(back).toEqual(run);
  });

  it('advancing past the last block signals the run is complete', () => {
    const last: RunState = { blocks, at: 2 };
    expect(advanced(last)).toBeNull();
  });
});

describe('a single-block plan', () => {
  const blocks = [block({ order: 0, type: 'notes', duration_minutes: 5 })];

  it('can neither advance nor go back', () => {
    const run = startRun(blocks);
    expect(canAdvance(run)).toBe(false);
    expect(canGoBack(run)).toBe(false);
  });

  it('completes on the very first advance', () => {
    expect(advanced(startRun(blocks))).toBeNull();
  });

  it('going back is still a no-op', () => {
    const run = startRun(blocks);
    expect(wentBack(run)).toEqual(run);
  });
});

describe('an empty plan', () => {
  it('has no current block', () => {
    expect(currentBlock(startRun([]))).toBeNull();
  });

  it('has no next block', () => {
    expect(upcomingBlock(startRun([]))).toBeNull();
  });

  it('cannot advance or go back', () => {
    expect(canAdvance(startRun([]))).toBe(false);
    expect(canGoBack(startRun([]))).toBe(false);
  });
});

describe('block duration', () => {
  it('converts minutes to seconds', () => {
    expect(blockSeconds(block({ duration_minutes: 10 }))).toBe(600);
  });

  it('never goes negative on a malformed duration', () => {
    // A timer counting backwards is worse than one stuck at zero.
    expect(blockSeconds(block({ duration_minutes: -5 }))).toBe(0);
  });
});

describe('a block deadline', () => {
  const now = 1_000_000;

  it('ends `duration_minutes` after now, in ms', () => {
    const d = deadlineFor(block({ duration_minutes: 2 }), now);
    expect(d.endsAt).toBe(now + 120_000);
    expect(d.total).toBe(120);
  });

  it('reports the full duration as remaining right when it starts', () => {
    const d = deadlineFor(block({ duration_minutes: 2 }), now);
    expect(remainingAt(d, now)).toBe(120);
  });

  it('counts down as the clock advances', () => {
    const d = deadlineFor(block({ duration_minutes: 2 }), now);
    expect(remainingAt(d, now + 30_000)).toBe(90);
  });

  it('is correct after a long gap — the deadline model survives backgrounding', () => {
    // The whole point of a deadline over a decrementing counter: put the
    // phone away for two minutes and the answer is still right when you
    // look again, because nothing was ever counting.
    const d = deadlineFor(block({ duration_minutes: 5 }), now);
    expect(remainingAt(d, now + 4 * 60_000)).toBe(60);
  });

  it('clamps at zero rather than going negative once it has run out', () => {
    const d = deadlineFor(block({ duration_minutes: 1 }), now);
    expect(remainingAt(d, now + 90_000)).toBe(0);
  });

  it('reads zero remaining for a null deadline rather than throwing', () => {
    expect(remainingAt(null, now)).toBe(0);
  });
});
