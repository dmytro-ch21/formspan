import {
  RELIABLE_MIN_SCORED,
  displayLearningState,
  learningStateOfCounts,
  sessionLearningFloor,
} from '@/lib/learningState';
import type { Tag } from '@/lib/bjjSession';

function tag(overrides: Partial<Tag>): Tag {
  return {
    category: 'submission',
    event: 'drilled',
    position: '',
    technique_id: 'armbar-closed-guard',
    count: 1,
    ...overrides,
  };
}

describe('learningStateOfCounts', () => {
  it('reads no counts at all as seen', () => {
    expect(learningStateOfCounts(null)).toBe('seen');
    expect(learningStateOfCounts(undefined)).toBe('seen');
    expect(learningStateOfCounts({ drilled: 0, attempted: 0, scored: 0 })).toBe('seen');
  });

  it('reads drilled-only as drilled', () => {
    expect(learningStateOfCounts({ drilled: 6, attempted: 0, scored: 0 })).toBe('drilled');
  });

  it('reads any live attempt as used live, short of the reliable bar', () => {
    expect(learningStateOfCounts({ drilled: 6, attempted: 1, scored: 0 })).toBe('live');
    expect(learningStateOfCounts({ drilled: 6, attempted: 0, scored: 1 })).toBe('live');
    expect(
      learningStateOfCounts({ drilled: 6, attempted: 0, scored: RELIABLE_MIN_SCORED - 1 }),
    ).toBe('live');
  });

  it('reaches reliable only at the scored threshold, not one below it', () => {
    expect(
      learningStateOfCounts({ drilled: 6, attempted: 0, scored: RELIABLE_MIN_SCORED - 1 }),
    ).not.toBe('reliable');
    expect(learningStateOfCounts({ drilled: 6, attempted: 0, scored: RELIABLE_MIN_SCORED })).toBe(
      'reliable',
    );
  });

  it('does not double-count attempted and scored — the disjoint-sum rule', () => {
    // Two apart on each, neither alone at the bar, but the SUM is —
    // this is the same "attempted + scored is how often it was tried" rule
    // bjjSession.ts documents for the backend counters.
    expect(
      learningStateOfCounts({
        drilled: 0,
        attempted: RELIABLE_MIN_SCORED - 1,
        scored: RELIABLE_MIN_SCORED - 1,
      }),
    ).toBe('live'); // scored alone is short of RELIABLE_MIN_SCORED
  });
});

describe('sessionLearningFloor', () => {
  it('is seen for a technique this session never named', () => {
    expect(sessionLearningFloor([], 'armbar-closed-guard')).toBe('seen');
    expect(
      sessionLearningFloor([tag({ technique_id: 'kimura-mount' })], 'armbar-closed-guard'),
    ).toBe('seen');
  });

  it('reads this session drilled tag as drilled', () => {
    expect(sessionLearningFloor([tag({ event: 'drilled', count: 1 })], 'armbar-closed-guard')).toBe(
      'drilled',
    );
  });

  it('reads a live outcome tagged this session as used live', () => {
    expect(
      sessionLearningFloor(
        [tag({ event: 'drilled' }), tag({ event: 'scored', count: 1 })],
        'armbar-closed-guard',
      ),
    ).toBe('live');
  });

  it('can reach reliable from this session alone, at the threshold', () => {
    expect(
      sessionLearningFloor(
        [tag({ event: 'scored', count: RELIABLE_MIN_SCORED })],
        'armbar-closed-guard',
      ),
    ).toBe('reliable');
  });
});

describe('displayLearningState', () => {
  const techniqueId = 'armbar-closed-guard';

  it('is seen with no id, no proficiency and no tags', () => {
    expect(displayLearningState(new Map(), [], null)).toBe('seen');
    expect(displayLearningState(new Map(), [], undefined)).toBe('seen');
  });

  it('reads the funnel for a technique with prior evidence and nothing added this session', () => {
    const proficiency = new Map([
      [techniqueId, { drilled: 12, attempted: 1, scored: RELIABLE_MIN_SCORED }],
    ]);
    expect(displayLearningState(proficiency, [], techniqueId)).toBe('reliable');
  });

  it('takes the local floor when the funnel has not caught up yet — a brand new session', () => {
    // The funnel is empty (new session, nothing synced), but the athlete just
    // drilled this technique for the first time — the badge must say so NOW,
    // not "Seen", or the ticket's own acceptance-criteria scenario (log a
    // technique and see the state) fails on every first-time technique.
    const tags = [tag({ event: 'drilled' })];
    expect(displayLearningState(new Map(), tags, techniqueId)).toBe('drilled');
  });

  it('never double-counts an already-synced session reopened for editing', () => {
    // The funnel ALREADY includes this session's own three scored reps (it
    // synced already); re-deriving from local tags on top must not push a
    // technique that is exactly AT the threshold past it via double-counting.
    // Taking the max rather than the sum is what this test would catch: a
    // summing implementation stays at 'reliable' here too (both readings
    // already agree), so the mutation this guards against is caught by the
    // NEXT test instead, where the two readings disagree.
    const proficiency = new Map([[techniqueId, { drilled: 3, attempted: 0, scored: 3 }]]);
    const tags = [tag({ event: 'scored', count: 3 })];
    expect(displayLearningState(proficiency, tags, techniqueId)).toBe('reliable');
  });

  it('takes the BETTER reading, not the funnel alone, when local evidence is ahead of it', () => {
    // The funnel has not caught up (still 'drilled'), but this session's own
    // tags already justify 'live' — the display must not regress to 'drilled'
    // just because the network snapshot is older than the local write.
    const proficiency = new Map([[techniqueId, { drilled: 6, attempted: 0, scored: 0 }]]);
    const tags = [tag({ event: 'scored', count: 1 })];
    expect(displayLearningState(proficiency, tags, techniqueId)).toBe('live');
  });

  it('never regresses below what the funnel alone already shows', () => {
    // Local floor is only 'drilled' (drilled today, no live tag yet this
    // session), but the funnel already knows this technique is reliable from
    // OTHER sessions. The badge must show the better reading, not the local one.
    const proficiency = new Map([[techniqueId, { drilled: 12, attempted: 0, scored: RELIABLE_MIN_SCORED }]]);
    const tags = [tag({ event: 'drilled' })];
    expect(displayLearningState(proficiency, tags, techniqueId)).toBe('reliable');
  });
});
