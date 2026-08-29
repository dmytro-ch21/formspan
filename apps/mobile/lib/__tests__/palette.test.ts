import { withAlpha } from '../palette';

/**
 * N444 (#741) — `withAlpha` is the one place any button/pill derives a
 * translucent fill from an existing token, so a second hand-written
 * `rgba(...)` literal doesn't reappear the next time somebody needs a
 * scrim.
 */
describe('withAlpha', () => {
  it('converts a 6-digit hex to rgba with the given alpha', () => {
    expect(withAlpha('#D3EC52', 0.92)).toBe('rgba(211,236,82,0.92)');
  });

  it('matches vola.bg — the scrim MomentumCard/ShareToFriend already hand-computed', () => {
    // #080B12 → rgb(8,11,18), the exact channels those two files' literal
    // rgba() strings already use.
    expect(withAlpha('#080B12', 0.72)).toBe('rgba(8,11,18,0.72)');
  });

  it('is case-insensitive on the hex digits', () => {
    expect(withAlpha('#d3ec52', 0.5)).toBe('rgba(211,236,82,0.5)');
  });

  it('falls back to the original string on a malformed hex, rather than throwing', () => {
    expect(withAlpha('not-a-colour', 0.5)).toBe('not-a-colour');
    expect(withAlpha('#fff', 0.5)).toBe('#fff'); // shorthand 3-digit — unsupported, not guessed at
  });
});
