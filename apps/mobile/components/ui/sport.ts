import { sportColors, type SportKey } from '@/constants/Colors';
import type { IconName } from '@/components/ui/Icon';

/**
 * What a discipline looks like — its colour and its glyph, in one place.
 *
 * Both are needed together everywhere they are needed at all (a session row, a
 * hero card, a stat badge), and keeping them in one lookup is what stops BJJ
 * from being purple in one list and violet in another.
 *
 * **Both fall back rather than throwing.** `sport` on a session is a string
 * from the server, and the module registry can legitimately carry a discipline
 * this build has no colour for — a new sport shipped to the API before the app
 * catches up. A neutral row is the right answer there; a crash is not.
 */

const ICONS: Record<SportKey, IconName> = {
  strength: 'workout',
  bjj: 'bjj',
  running: 'running',
  nutrition: 'nutrition',
};

/** Undefined for a sport this build doesn't know — callers use a neutral. */
export function sportColor(key: string): string | undefined {
  return sportColors[key as SportKey];
}

export function sportIcon(key: string): IconName | undefined {
  return ICONS[key as SportKey];
}

/**
 * A sport colour at badge strength — the fill behind its icon.
 *
 * Alpha rather than a pre-solved opaque tint, which is the opposite of what
 * `setDone` does and deliberately so: `setDone` sits on exactly one ground
 * (`surface`), so it can be solved per channel and stored flat, while these
 * badges appear on `surface` in a list and `surfaceRaised` in a hero card. A
 * tint solved for one would be visibly wrong on the other.
 *
 * The icon on top is the full-strength colour, which is what carries the
 * meaning; this is only the disc behind it.
 */
export function sportTint(color: string): string {
  return `${color}22`;
}
