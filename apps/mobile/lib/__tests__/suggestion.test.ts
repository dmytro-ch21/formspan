import type { Proficiency } from '../proficiency';
import { funnelGap, shouldOfferDetail } from '../suggestion';

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
    const s = funnelGap([row()], NOW);
    expect(s).toEqual({
      techniqueId: 't1',
      name: 'Arm drag',
      position: 'Standing',
      drilled: 9,
      sessions: 3,
    });
  });

  it('says nothing when there is nothing to say', () => {
    expect(funnelGap([], NOW)).toBeNull();
    expect(funnelGap([row({ drilled: 5 })], NOW)).toBeNull();
  });

  it('does not suggest trying something already LANDED', () => {
    // The load-bearing one. `attempted` is "went for it and it did not land",
    // disjoint from `scored` — so a technique with scored > 0 has plainly been
    // tried, and a gate reading `attempted === 0` alone would tell this
    // athlete to go and try the thing they are hitting.
    expect(funnelGap([row({ attempted: 0, scored: 2 })], NOW)).toBeNull();
  });

  it('does not suggest trying something already ATTEMPTED', () => {
    expect(funnelGap([row({ attempted: 3, scored: 0 })], NOW)).toBeNull();
  });

  it('ignores a single keen class', () => {
    // Nine reps in one session is one session. `sessions` exists as exactly
    // this honesty check, and a technique the coach taught once is not
    // something the athlete is avoiding.
    expect(funnelGap([row({ sessions: 1 })], NOW)).toBeNull();
  });

  it('ignores a gap that is now archaeology', () => {
    expect(funnelGap([row({ last_seen: '2026-01-04T18:00:00Z' })], NOW)).toBeNull();
    // ...but a real gap survives a holiday.
    expect(funnelGap([row({ last_seen: '2026-07-10T18:00:00Z' })], NOW)).not.toBeNull();
  });

  it('picks the strongest evidence, not the first row', () => {
    const s = funnelGap(
      [row({ technique_id: 'a', drilled: 6 }), row({ technique_id: 'b', drilled: 14 })],
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
    expect(funnelGap(rows, NOW)?.techniqueId).toBe('c');
    expect(funnelGap(rows.slice(0, 2), NOW)?.techniqueId).toBe('a');
    expect(funnelGap(rows.slice(0, 2).reverse(), NOW)?.techniqueId).toBe('a');
  });

  it('falls back to the id when the library no longer has the name', () => {
    // `technique_id` survives a retired technique (ON DELETE SET NULL keeps
    // the evidence), so the card must still say something.
    expect(funnelGap([row({ name: '' })], NOW)?.name).toBe('t1');
  });

  it('survives an unparseable timestamp instead of suggesting on garbage', () => {
    expect(funnelGap([row({ last_seen: 'not a date' })], NOW)).toBeNull();
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
    expect(shouldOfferDetail(1, 0)).toBe(false);
  });

  it('offers once the fast path is a habit', () => {
    expect(shouldOfferDetail(2, 0)).toBe(true);
    expect(shouldOfferDetail(4, 0)).toBe(true);
  });

  it('stops after the fourth, whatever the athlete decided', () => {
    expect(shouldOfferDetail(5, 0)).toBe(false);
    expect(shouldOfferDetail(40, 0)).toBe(false);
  });

  it('never asks someone who is already logging detail', () => {
    // One technique with any evidence at all is enough — the list is per
    // technique, not per session.
    expect(shouldOfferDetail(3, 1)).toBe(false);
  });
});
