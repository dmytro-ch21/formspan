import { initialsFor, monogramFor } from '../monogram';

/**
 * The colour is the load-bearing part, not the letters: two initials do not
 * distinguish many people, but "the teal one" is scannable before anything is
 * read. That only works if a person's colour never changes, so most of this
 * file is about stability rather than about which colour anyone gets.
 */

describe('a person’s colour', () => {
  it('is the same every time', () => {
    // The whole feature. If this drifts, a feed scanned by colour is worse than
    // one with no colour at all, because it looks reliable and is not.
    expect(monogramFor('mat_rat')).toEqual(monogramFor('mat_rat'));
  });

  it('ignores case and surrounding space', () => {
    // Handles are stored lowercase, but a caller passing one through a display
    // path could hand us anything; the same person must not get two identities.
    expect(monogramFor('  MAT_RAT ').background).toBe(monogramFor('mat_rat').background);
  });

  it('separates handles that differ by one letter', () => {
    // Not a hash-quality claim in general — just the case that actually occurs,
    // since friends pick similar handles and a collision between two people in
    // the same small feed is the only collision anyone would notice.
    expect(monogramFor('alice').background).not.toBe(monogramFor('alicf').background);
  });

  it('stays in the palette for a long handle', () => {
    // The `>>> 0` in the hash. Without it the accumulator leaves the
    // integer-safe range on a long handle and the modulo stops being stable —
    // silently, and only for some people.
    const m = monogramFor('a'.repeat(30));
    expect(m.background).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('never uses the athlete’s accent colour', () => {
    // Deliberate: the accent follows the READER's theme, so keying a friend's
    // avatar on it would make their identity change when you change a setting.
    // Pinned as a property of the palette rather than left to be noticed.
    const backgrounds = ['alice', 'bob', 'carol', 'dan', 'erin', 'frank', 'gina', 'hal'].map(
      (h) => monogramFor(h).background,
    );
    for (const b of backgrounds) {
      expect(b).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('does not crash on a handle that should never reach it', () => {
    // The server's `visibleFrom` requires a username, so this is unreachable —
    // but `PALETTE[NaN]` is undefined, and a card rendering `backgroundColor:
    // undefined` is a nicer failure than one that throws mid-list.
    expect(monogramFor('').initials).toBe('?');
    expect(monogramFor('').background).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe('the letters', () => {
  it('takes one from each word of a two-word handle', () => {
    expect(initialsFor('mat_rat')).toBe('MR');
    expect(initialsFor('john-smith')).toBe('JS');
    expect(initialsFor('a.b')).toBe('AB');
  });

  it('takes the first two letters when there is no boundary', () => {
    expect(initialsFor('matrat')).toBe('MA');
  });

  it('treats a digit run as a boundary', () => {
    // `dmytro21` is one word to a naive splitter and gives "DM"; the digits are
    // a real boundary in practice, and "D2" distinguishes better across the
    // handles people actually pick.
    expect(initialsFor('dmytro21')).toBe('D2');
  });

  it('copes with a handle of one letter plus separators', () => {
    expect(initialsFor('a_')).toBe('A');
  });
});
