import { monogramColors, monogramInk, accents } from '@/constants/Colors';

import { initialsFor, monogramFor } from '../monogram';

/**
 * What is actually load-bearing here is STABILITY, not distinctiveness.
 *
 * The palette is five buckets — that is all the lightness range leaves once
 * `scripts/validate_palette.mjs` requires ΔE 15 between every pair under three
 * simulated colour-vision deficiencies. So two friends sharing a colour is
 * ordinary, the initials and `@handle` are what identify a person, and the
 * colour is a coarse grouping aid. A coarse aid that SHUFFLED would still be
 * worse than none, which is what most of this file guards.
 */

describe('a person’s colour', () => {
  it('is the same every time', () => {
    expect(monogramFor('mat_rat')).toEqual(monogramFor('mat_rat'));
  });

  it('ignores case and surrounding space', () => {
    // Handles are stored lowercase, but a caller passing one through a display
    // path could hand us anything; the same person must not get two identities.
    expect(monogramFor('  MAT_RAT ').background).toBe(monogramFor('mat_rat').background);
  });

  it('is not decided by a bare sum of the letters', () => {
    // The bug review caught. djb2's multiplier is 33, and 33 ≡ 1 (mod 8), so
    // `hash % 8` collapsed to `(5381 + Σ charCodes) % 8` — order-independent,
    // meaning ANAGRAMS collided deterministically rather than at the 1-in-N
    // birthday rate. Measured on the shipped code before the fold: mat_rat and
    // rat_mat, alice and celia, sam_k and k_sam all matched.
    //
    // Anagrams are the sharpest probe, and training partners really do pick
    // handles like this. Asserted as a RATE rather than pair by pair: with five
    // buckets any given pair coincides 1 time in 5 by chance, so a single
    // `not.toBe` would be flaky-by-construction. What the bug produced was
    // total: measured 6 of 6 colliding before the fold, 1 of 6 after — the
    // chance rate. `mat_rat`/`rat_mat` is that one, and it is not evidence.
    const anagrams: [string, string][] = [
      ['mat_rat', 'rat_mat'],
      ['alice', 'celia'],
      ['sam_k', 'k_sam'],
      ['sam', 'sim'],
      ['dan', 'and'],
      ['bob_k', 'k_bob'],
    ];
    const separated = anagrams.filter(
      ([a, b]) => monogramFor(a).background !== monogramFor(b).background,
    ).length;
    expect(separated).toBeGreaterThanOrEqual(4);
  });

  it('stays inside the palette for a handle that overflows an unmasked hash', () => {
    // The `>>> 0` guards. Without them the accumulator — or the fold, since `^`
    // yields a SIGNED int32 — goes negative and indexes the palette out of
    // bounds, giving `backgroundColor: undefined`.
    //
    // The fixture is a REAL handle shape, not `'a'.repeat(30)`: the repeated
    // string happens to stay positive unmasked, so it passed with the guard
    // deleted and proved nothing. These four go negative without it.
    for (const handle of ['mat_rat', 'dmytro21', 'bjj_dave', 'marcelo_garcia']) {
      const m = monogramFor(handle);
      expect(Object.values(monogramColors)).toContain(m.background);
      expect(Object.values(monogramInk)).toContain(m.ink);
    }
  });

  it('never uses one of the athlete’s accent colours', () => {
    // Asserted against the REAL accent set, not against "is it a hex string" —
    // the previous version of this test checked only the format, so putting an
    // accent hex straight into the palette would have kept it green.
    //
    // The point: an accent follows the READER's theme, so keying a friend's
    // avatar on one would make their identity change when you change a setting.
    const accentHexes = new Set(
      Object.values(accents).flatMap((a) => [a.accent, a.ink, a.on].map((h) => h.toUpperCase())),
    );
    for (const hex of Object.values(monogramColors)) {
      expect(accentHexes.has(hex.toUpperCase())).toBe(false);
    }
  });

  it('pins one handle to one colour, so a palette edit is a deliberate migration', () => {
    // A golden pair. Every other test here passes if the palette is reordered
    // or extended — which silently reassigns nearly everyone, because the
    // bucket is `hash % length`. This makes that a loud, intentional change,
    // since it IS one: people's colours move.
    expect(monogramFor('mat_rat').background).toBe(monogramColors.ocean);
  });

  it('does not crash on a handle that should never reach it', () => {
    // The server's `visibleFrom` requires a username, so this is unreachable.
    expect(monogramFor('').initials).toBe('?');
    expect(Object.values(monogramColors)).toContain(monogramFor('').background);
  });
});

describe('the letters, which are what actually identify a person', () => {
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
