import {
  classify,
  headline,
  liveOf,
  rankPositions,
  winShare,
  type PositionStat,
} from '../positionStats';

/**
 * Reading the position map.
 *
 * Two properties carry this file. **Defence counts as a won exchange** — get
 * that wrong and a survival-based game reads as a total collapse, which is the
 * reading most likely to make someone abandon a position they are fine in. And
 * **`thin` is a refusal, not a category** — below the threshold the row is
 * shown and no verdict is attached, because one bad night dominates small
 * numbers.
 *
 * `attempted` and `conceded` are DISJOINT from `scored` and `defended`
 * respectively (the backend insists on it), so every fixture below is written
 * as four independent counts rather than totals-and-parts.
 */

function pos(position: string, p: Partial<PositionStat> = {}): PositionStat {
  return {
    position,
    scored: 0,
    attempted: 0,
    conceded: 0,
    defended: 0,
    drilled: 0,
    sessions: 1,
    last_seen: '2026-08-09T00:00:00Z',
    ...p,
  };
}

describe('liveOf', () => {
  it('counts all four live outcomes and excludes drilling', () => {
    // The ordering rule the backend enforces, mirrored here: 50 drills is not
    // evidence about a round.
    expect(liveOf(pos('Mount', { scored: 1, attempted: 2, conceded: 3, defended: 4, drilled: 50 })))
      .toBe(10);
  });
});

describe('winShare', () => {
  it('counts a successful defence as a won exchange', () => {
    /*
      The sign trap. Four exchanges, none of them a submission by the athlete,
      all four of them survived. Counting only `scored` gives 0 — "you lose
      everything here" — when the truth is the opposite.
    */
    const p = pos('Side Control', { defended: 4 });
    expect(winShare(p)).toBe(1);
  });

  it('is null rather than zero when nothing live has happened', () => {
    // A drilled-only position has no rate. Zero would render as 0%.
    expect(winShare(pos('Mount', { drilled: 20 }))).toBeNull();
  });

  it('measures won exchanges against every live one', () => {
    const p = pos('Half Guard', { scored: 1, defended: 1, conceded: 1, attempted: 1 });
    expect(winShare(p)).toBe(0.5);
  });
});

describe('classify', () => {
  it('refuses a verdict below the threshold', () => {
    // Four exchanges all going badly is still not enough to say so.
    expect(classify(pos('Turtle', { conceded: 4 }), 5)).toBe('thin');
  });

  it('gives a verdict at exactly the threshold', () => {
    // The boundary is `< minLive`, not `<= minLive` — off by one here silently
    // withholds every verdict for a whole extra round of evidence.
    expect(classify(pos('Turtle', { conceded: 5 }), 5)).toBe('leaking');
  });

  it('weighs a missed attempt as a lost exchange', () => {
    /*
      `attempted` is "went for it and missed". A position where the athlete
      scores twice and misses four times is not going well, and comparing
      `scored` to `conceded` alone would call it 'strong' on a 2-0 record
      while ignoring the four failures.
    */
    expect(classify(pos('Closed Guard', { scored: 2, attempted: 4 }), 5)).toBe('leaking');
  });

  it('weighs a defence against a concession', () => {
    expect(classify(pos('Back Control', { defended: 4, conceded: 2 }), 5)).toBe('strong');
  });

  it('calls a genuine tie even', () => {
    expect(classify(pos('Guard', { scored: 3, conceded: 3 }), 5)).toBe('even');
  });
});

describe('rankPositions', () => {
  it('puts the worst leak first and the best strength first', () => {
    const bad = pos('Turtle', { conceded: 9, defended: 1 }); // 10%
    const worse = pos('Back Control', { conceded: 10 }); // 0%
    const good = pos('Closed Guard', { scored: 6, conceded: 1, attempted: 1 }); // 75%
    const best = pos('Mount', { scored: 8, defended: 1, conceded: 1 }); // 90%
    const r = rankPositions([bad, good, worse, best], 5);
    expect(r.leaking.map((p) => p.position)).toEqual(['Back Control', 'Turtle']);
    expect(r.strong.map((p) => p.position)).toEqual(['Mount', 'Closed Guard']);
  });

  it('files an even position with the strong ones rather than losing it', () => {
    const r = rankPositions([pos('Guard', { scored: 3, conceded: 3 })], 5);
    expect(r.strong.map((p) => p.position)).toEqual(['Guard']);
    expect(r.leaking).toEqual([]);
    expect(r.thin).toEqual([]);
  });

  it('keeps thin rows instead of dropping them', () => {
    // The athlete has been there; that fact survives even when no verdict does.
    const r = rankPositions([pos('Knee Shield', { conceded: 2 })], 5);
    expect(r.thin.map((p) => p.position)).toEqual(['Knee Shield']);
    expect(r.strong).toEqual([]);
    expect(r.leaking).toEqual([]);
  });

  it('orders tied rows by evidence and then by name, so nothing reshuffles', () => {
    /*
      Two positions at an identical win share is the common case on small
      numbers, not the exotic one. Without the second and third keys the order
      falls out of whatever the server happened to send, and the list moves
      under the athlete's thumb between two renders of unchanged data.
    */
    const a = pos('Z-Guard', { scored: 3, conceded: 3 }); // 50%, 6 live
    const b = pos('Ashi', { scored: 3, conceded: 3 }); // 50%, 6 live
    const c = pos('Deep Half', { scored: 5, conceded: 5 }); // 50%, 10 live
    const r = rankPositions([a, b, c], 5);
    expect(r.strong.map((p) => p.position)).toEqual(['Deep Half', 'Ashi', 'Z-Guard']);
  });
});

describe('headline', () => {
  it('names where things go worst without telling the athlete what to do', () => {
    /*
      Deliberately descriptive. The backend's note is explicit that concessions
      are equally consistent with a hole in the game and with starting every
      round there on purpose, and that nothing in this data separates them — so
      any "drill this" here would be confidently wrong about a third of the
      time. This test is what stops that sentence being added later.
    */
    const r = rankPositions([pos('Turtle', { conceded: 8, defended: 1 })], 5);
    const line = headline(r, 5);
    expect(line).toContain('Turtle');
    // The denominator travels with the count: "8 of 9" is a finding, a bare
    // percentage is a number nobody can argue with.
    expect(line).toContain('8 of 9');
    expect(line).not.toMatch(/drill|should|work on|need to|fix/i);
  });

  it('leads with a strength when nothing is leaking', () => {
    const r = rankPositions([pos('Mount', { scored: 7, conceded: 1 })], 5);
    const line = headline(r, 5);
    expect(line).toContain('best position');
    expect(line).toContain('7 of 8');
  });

  it('counts the same four outcomes the verdict does', () => {
    /*
      A position leaking purely through missed attempts. The first version of
      this headline printed `conceded` and `scored` only, so this case read
      "0 conceded, 0 scored" directly above a heading saying things go against
      you here — the sentence contradicted the section it introduced.
    */
    const r = rankPositions([pos('Closed Guard', { attempted: 6 })], 5);
    expect(headline(r, 5)).toBe(
      'Most goes against you in Closed Guard — 6 of 6 exchanges lost.',
    );
  });

  it('explains the threshold rather than showing an empty screen', () => {
    const r = rankPositions([pos('Guard', { scored: 1 })], 5);
    expect(headline(r, 5)).toContain('5 exchanges');
  });

  it('asks for tags when there is nothing at all', () => {
    expect(headline(rankPositions([], 5), 5)).toContain('No positions tagged');
  });
});
