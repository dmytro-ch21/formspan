import type { Proficiency } from '../proficiency';
import { MAX_OFFERS, countersInUse, funnelGap, shouldOfferDetail } from '../suggestion';

/**
 * The first suggestion the app ever makes about how to train, which is a
 * higher bar than it sounds: a wrong one is worse than none, because it
 * teaches the athlete the suggestions are noise and they stop reading them.
 *
 * The assertion that matters most is the third one — `attempted` and `scored`
 * are DISJOINT in this schema, so testing "never attempted" without also
 * testing "never scored" would tell someone to go and try a technique they are
 * already landing.
 */

const NOW = new Date('2026-08-05T12:00:00');

/**
 * A second technique that HAS live counters, so `countersInUse` is satisfied.
 *
 * Without one in the list nothing can fire — and that is the point: the only
 * writer of a technique-tagged attempted/scored row is the wizard's focus
 * grid, so for a technique never on that list `attempted + scored` is
 * structurally 0 and proves nothing.
 */
const usesCounters: Proficiency = {
  technique_id: 'other',
  name: 'Scissor sweep',
  position: 'Guard',
  category: 'Sweep',
  drilled: 2,
  attempted: 1,
  scored: 1,
  conceded: 0,
  defended: 0,
  sessions: 2,
  last_seen: '2026-08-01T18:00:00Z',
} as Proficiency;

function row(over: Partial<Proficiency> = {}): Proficiency {
  return {
    technique_id: 't1',
    name: 'Arm drag',
    position: 'Standing',
    category: 'Sweep',
    drilled: 9,
    attempted: 0,
    scored: 0,
    conceded: 0,
    sessions: 3,
    last_seen: '2026-08-01T18:00:00Z',
    ...over,
  };
}

describe('funnelGap', () => {
  it('finds a technique drilled repeatedly and never taken live', () => {
    const s = funnelGap([row(), usesCounters], NOW);
    expect(s).toEqual({
      techniqueId: 't1',
      name: 'Arm drag',
      position: 'Standing',
      drilled: 9,
      sessions: 3,
    });
  });

  it('says nothing when there is nothing to say', () => {
    expect(funnelGap([usesCounters], NOW)).toBeNull();
    expect(funnelGap([row({ drilled: 5 }), usesCounters], NOW)).toBeNull();
  });

  it('does not suggest trying something already LANDED', () => {
    // The load-bearing one. `attempted` is "went for it and it did not land",
    // disjoint from `scored` — so a technique with scored > 0 has plainly been
    // tried, and a gate reading `attempted === 0` alone would tell this
    // athlete to go and try the thing they are hitting.
    expect(funnelGap([row({ attempted: 0, scored: 2 }), usesCounters], NOW)).toBeNull();
  });

  it('does not suggest trying something already ATTEMPTED', () => {
    expect(funnelGap([row({ attempted: 3, scored: 0 }), usesCounters], NOW)).toBeNull();
  });

  describe('the thresholds themselves, at their boundaries', () => {
    // None of these was pinned: the fixture sat at drilled 9 / 60d and the
    // rejections at 5 / 213d, so MIN_DRILLED could be raised to 9 and the
    // window moved anywhere in [27, 212] with the suite still green. Every one
    // of these numbers is argued about at length in the docstrings, so every
    // one gets its boundary pair.
    it('accepts exactly MIN_DRILLED and rejects one below', () => {
      expect(funnelGap([row({ drilled: 6 }), usesCounters], NOW)).not.toBeNull();
      expect(funnelGap([row({ drilled: 5 }), usesCounters], NOW)).toBeNull();
    });

    it('accepts a gap seen just inside the window and rejects just outside', () => {
      const at = (days: number) =>
        new Date(NOW.getTime() - days * 86_400_000).toISOString();
      expect(funnelGap([row({ last_seen: at(59) }), usesCounters], NOW)).not.toBeNull();
      expect(funnelGap([row({ last_seen: at(61) }), usesCounters], NOW)).toBeNull();
    });
  });

  it('says nothing at all until the athlete uses the live counters', () => {
    // THE finding. The only writer of a technique-tagged attempted/scored row
    // is the wizard's focus grid, so for a technique never on that list
    // `attempted + scored` is structurally 0 — an absence of the surface that
    // could record it, not evidence. Without this precondition the rule
    // collapses to "drilled a lot, recently" and the card asserts "never live"
    // about rounds the app was never told about.
    expect(countersInUse([row()])).toBe(false);
    expect(funnelGap([row()], NOW)).toBeNull();
    expect(countersInUse([row(), usesCounters])).toBe(true);
    expect(funnelGap([row(), usesCounters], NOW)).not.toBeNull();
  });

  it('ignores a gap that is now archaeology', () => {
    expect(funnelGap([row({ last_seen: '2026-01-04T18:00:00Z' }), usesCounters], NOW)).toBeNull();
    // ...but a real gap survives a holiday.
    expect(funnelGap([row({ last_seen: '2026-07-10T18:00:00Z' }), usesCounters], NOW)).not.toBeNull();
  });

  it('picks the strongest evidence, not the first row', () => {
    const s = funnelGap(
      [row({ technique_id: 'a', drilled: 6 }), row({ technique_id: 'b', drilled: 14 }), usesCounters],
      NOW,
    );
    expect(s?.techniqueId).toBe('b');
  });

  it('breaks a tie on sessions, then on id, so the answer never wobbles', () => {
    // An unstable order would move the suggestion between two equal techniques
    // on every refresh, which reads as the app changing its mind.
    const rows = [
      row({ technique_id: 'b', drilled: 9, sessions: 3 }),
      row({ technique_id: 'a', drilled: 9, sessions: 3 }),
      row({ technique_id: 'c', drilled: 9, sessions: 5 }),
    ];
    expect(funnelGap([...rows, usesCounters], NOW)?.techniqueId).toBe('c');
    expect(funnelGap([...rows.slice(0, 2), usesCounters], NOW)?.techniqueId).toBe('a');
    expect(funnelGap([...rows.slice(0, 2).reverse(), usesCounters], NOW)?.techniqueId).toBe('a');
  });

  it('survives an unparseable timestamp instead of suggesting on garbage', () => {
    expect(funnelGap([row({ last_seen: 'not a date' }), usesCounters], NOW)).toBeNull();
  });
});

describe('shouldOfferDetail', () => {
  /*
   * Tier 0 — the only tier that CREATES the evidence the others consume. It
   * has to read as an offer, and the bound on the far side is what keeps it
   * one: a prompt that repeats forever is the shame the UX direction rules
   * out, however politely it is worded.
   */
  it('stays quiet on the very first session', () => {
    expect(shouldOfferDetail(1, 0, 0)).toBe(false);
    expect(shouldOfferDetail(2, 0, 0)).toBe(true);
  });

  it('stops for good once it has been shown its share of times', () => {
    // Bounded on TIMES SHOWN, not on a session count. The first version used
    // `bjjSessions <= 4`, and that count is over the most recent ~30 local
    // rows — so a reinstall put a three-year athlete back at "session 2", and
    // for a strength-heavy athlete the old BJJ sessions aged out of the window
    // and the prompt returned indefinitely. Which is the one thing the bound
    // exists to prevent.
    expect(shouldOfferDetail(50, 0, MAX_OFFERS - 1)).toBe(true);
    expect(shouldOfferDetail(50, 0, MAX_OFFERS)).toBe(false);
    expect(shouldOfferDetail(2, 0, MAX_OFFERS + 9)).toBe(false);
  });

  it('never asks someone who is already logging detail', () => {
    // One technique with any evidence at all is enough — the list is per
    // technique, not per session.
    expect(shouldOfferDetail(3, 1, 0)).toBe(false);
  });
});
