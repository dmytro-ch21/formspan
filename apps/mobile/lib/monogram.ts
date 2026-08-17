import { activeMonogramColors, monogramInk, type MonogramColor } from '@/constants/Colors';

/**
 * A person's stand-in avatar, derived from their handle.
 *
 * There are no uploaded avatars in this app and this is not a placeholder for
 * one — it is the answer for now, and it stays the fallback if photos are ever
 * added, because every avatar system needs something to draw for the people who
 * have not uploaded anything.
 *
 * Deriving it rather than storing it buys three things worth having:
 *
 *   - **Nothing new crosses the wire.** The social scope addresses everyone by
 *     handle and never sends a user id; fetching a hosted image would need one.
 *   - **Nothing to moderate.** `display_name` is already unguarded prose that
 *     friends can see, and an uploaded picture is a strictly worse version of
 *     that problem with no report path built.
 *   - **Nothing to store, resize, cache or serve.**
 *
 * ## What the colour is and is not
 *
 * The first draft of this file claimed the colour was the point — "two initials
 * do not distinguish many people, but the teal one is scannable". Measurement
 * retired that claim. `scripts/validate_palette.mjs` requires categorical
 * colours to stay ΔE 15 apart under simulated protanopia, deuteranopia and
 * tritanopia, and an eight-colour palette failed **16 of its 28 pairs** while
 * looking perfectly varied. White ink pins every disc into one dark luminance
 * band, and CVD collapses hue toward a single axis, so what survives is
 * lightness — and there is only room for about five distinguishable steps.
 *
 * So: **the INITIALS and the `@handle` beside them identify a person. The
 * colour groups them.** Five buckets over a feed of friends means shared
 * colours are ordinary rather than exceptional, and that is fine for a coarse
 * aid and would be useless for an identity. The stability guarantee below is
 * still worth having — a colour that shuffled would be worse than none — but it
 * is not load-bearing the way it was first written to be.
 */

/** The bucket names, in the order the palette declares them. */
const NAMES = Object.keys(monogramInk) as MonogramColor[];

/**
 * A stable, order-dependent hash of the handle.
 *
 * djb2 — but note the FOLD below, which is not decoration. djb2's multiplier is
 * 33, and 33 ≡ 1 (mod 8), so `hash(s) % 8` reduces exactly to
 * `(5381 + Σ charCodes) % 8`: order-independent, zero avalanche, and anagrams
 * land in the same bucket every time. `mat_rat` and `rat_mat` collided
 * deterministically, as did `alice`/`celia` and `sam`/`sim`, measured. Review
 * caught it; the comment here previously asserted the opposite.
 *
 * The bucket count is no longer a power of two, which weakens that particular
 * degeneracy on its own — but the fold is what makes the result independent of
 * the modulus, and a palette resize must not be able to quietly reintroduce it.
 *
 * `>>> 0` on every step, and again after the fold: `^` yields a SIGNED 32-bit
 * int in JavaScript, so an unmasked fold can go negative and index the palette
 * out of bounds. That is not hypothetical — it was observed while writing this.
 */
function bucket(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) >>> 0) + h + s.charCodeAt(i)) >>> 0;
  }
  const folded = ((h ^ (h >>> 8) ^ (h >>> 16)) >>> 0) % NAMES.length;
  return folded;
}

/**
 * Up to two initials.
 *
 * Read from the handle rather than the display name, deliberately: the handle
 * is the stable identity, it is unique, and it is what the colour is keyed on —
 * so letters and colour can never disagree about who this is. A display name
 * can be changed to anything, including somebody else's name.
 *
 * Word boundaries are `_`, `-`, `.` and a digit run. Handles are
 * `[a-z][a-z0-9_]{2,29}` so only `_` and the digits occur in practice; the
 * other two are harmless generality. `mat_rat` reads as two words where
 * `matrat` does not, and a handle with no boundary gives its first two letters.
 */
export function initialsFor(handle: string): string {
  const words = handle
    .split(/[_\-.]+|(?<=\D)(?=\d)/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export type Monogram = { initials: string; background: string; ink: string };

/**
 * The whole avatar for a handle. Pure, so the same person is the same colour on
 * every screen, on every device, forever — which matters even for a coarse aid,
 * because a colour that shuffled between launches would be actively misleading.
 *
 * Reads `activeMonogramColors`, not the raw palette, so monochrome mode swaps
 * all of them to one grey. Under mono the initials carry everything, which is
 * what that mode asks of every other signal in the app.
 */
export function monogramFor(handle: string): Monogram {
  const clean = handle.trim().toLowerCase();
  const name = clean ? NAMES[bucket(clean)] : NAMES[0];
  return {
    // A row with no handle should not reach a feed at all — the server's
    // `visibleFrom` requires one — but a '?' on the first bucket is a better
    // answer than crashing on an undefined palette entry.
    initials: clean ? initialsFor(clean) : '?',
    background: activeMonogramColors[name],
    ink: monogramInk[name],
  };
}
