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
 * The COLOUR is the point, more than the letters. Two initials are not very
 * distinguishing across a feed, but "the teal one" is scannable at a glance —
 * so the colour has to be stable for a person forever, which is why it is a
 * pure function of the handle and not of anything that can be reassigned.
 */

/**
 * The palette.
 *
 * Chosen to sit on the app's dark ground with white text at readable contrast,
 * and to be distinguishable from each other rather than merely pretty — a ramp
 * of one hue would defeat the whole purpose. Deliberately NOT the accent
 * colour: the accent moves with the athlete's own theme, and a friend whose
 * avatar changes colour because YOU changed a setting is not an identity.
 */
const PALETTE = [
  '#2F6F5E', // pine
  '#1F5F8B', // deep blue
  '#6B4E9B', // violet
  '#9B4E6B', // plum
  '#A05A2C', // amber-brown
  '#3F7A3F', // moss
  '#4A5B8C', // slate blue
  '#8C5A3F', // clay
] as const;

/**
 * A stable, order-dependent hash of the handle.
 *
 * djb2, because it is four lines and its avalanche is good enough to keep
 * `alice` and `alicf` in different buckets — which is the only property that
 * matters here. Nothing about this is a security claim.
 *
 * `>>> 0` on every step keeps it in unsigned 32-bit range: without it the value
 * silently leaves the integer-safe range and the "same handle, same colour"
 * guarantee stops holding for long handles.
 */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) >>> 0) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Up to two initials.
 *
 * Read from the handle rather than the display name, deliberately: the handle
 * is the stable identity, it is unique, and it is what the colour is keyed on —
 * so letters and colour can never disagree about who this is. A display name
 * can be changed to anything, including somebody else's name.
 *
 * Word boundaries are `_`, `-`, `.` and a digit run, because handles are
 * `[a-z][a-z0-9_]{2,29}` and `mat_rat` reads as two words where `matrat` does
 * not. A handle with no boundary gives its first two letters.
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

export type Monogram = { initials: string; background: string };

/**
 * The whole avatar for a handle. Pure, so the same person is the same colour on
 * every screen, on every device, forever.
 */
export function monogramFor(handle: string): Monogram {
  const clean = handle.trim().toLowerCase();
  if (!clean) {
    // A row with no handle should not reach a feed at all — the server's
    // `visibleFrom` requires one — but rendering a grey blank is a better
    // answer than crashing on `PALETTE[NaN]`.
    return { initials: '?', background: '#3A4150' };
  }
  return {
    initials: initialsFor(clean),
    background: PALETTE[hash(clean) % PALETTE.length],
  };
}
