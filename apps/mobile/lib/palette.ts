import * as SecureStore from 'expo-secure-store';

import { MONO_KEY, isMono, type AccentName } from '@/constants/Colors';

/**
 * The monochrome mode's one moving part: keeping the early-read flag in step
 * with the accent the athlete actually chose.
 *
 * The palette itself is resolved in `constants/Colors.ts` at module-evaluation
 * time — read that file's `mono` block first, it carries the whole design and
 * the measurement that ruled out the two obvious alternatives (a root-level
 * `filter: grayscale`, which is a silent no-op in Expo Go, and a `usePalette()`
 * hook, which would mean hoisting 65 files' stylesheets into their components).
 *
 * What is left here is the write side and the honesty about the seam.
 */

/** The accent that means "monochrome". One name, so nothing has to guess. */
export const MONO_ACCENT: AccentName = 'mono';

/**
 * Record the choice where the palette can read it next launch.
 *
 * Called from the accent picker alongside the ordinary preference write. The
 * two are deliberately not merged: `PREF_ACCENT` remains the source of truth for
 * *which* accent is chosen, and this is a cache of the single bit that has to be
 * answerable synchronously, before SQLite is open.
 *
 * Never throws. A keychain that refuses the write costs a relaunch that comes up
 * in the previous mode — annoying, and far better than a settings screen that
 * fails to change a colour.
 */
export async function writeMonoFlag(name: AccentName): Promise<void> {
  try {
    await SecureStore.setItemAsync(MONO_KEY, name === MONO_ACCENT ? '1' : '0');
  } catch {
    // See above: a colour preference is not worth surfacing an error for.
  }
}

/**
 * Does the current choice differ from the palette this launch was built with?
 *
 * This is the seam, stated out loud rather than hidden: switching into or out of
 * monochrome moves the accent immediately (it is a context value) while
 * everything drawn from a module-scope stylesheet keeps the palette the app
 * launched with. The picker renders a line saying so, and only while it is
 * actually true — a permanent "restart to apply" note would be noise on the five
 * accents that need no restart at all.
 */
export function monoNeedsRelaunch(name: AccentName): boolean {
  return (name === MONO_ACCENT) !== isMono;
}

/**
 * A token colour at partial opacity, as an `rgba()` string React Native
 * accepts directly in `backgroundColor`/`borderColor`.
 *
 * N444 (#741): the design-tokens rule is "no arbitrary new colours" — this
 * is the derivation the rule expects rather than the exception to it, the
 * same move `ShareToFriend.tsx`'s sheet backdrop and `MomentumCard.tsx`'s
 * ring-centre plate already made by hand (`rgba(8,11,18,0.86)`, computed from
 * `vola.bg` and never written down as a function). Centralised here so a
 * THIRD hand-computed `rgba(8,11,18,…)` literal doesn't appear the next time
 * somebody needs a scrim.
 *
 * Takes any 6-digit `#rrggbb` hex — including a per-athlete accent colour,
 * which a literal never could — and only that shape: no shorthand `#rgb`, no
 * named CSS colours, because every token this app defines is already 6-digit
 * hex (`assets/brand/design-tokens.json`, `constants/Colors.ts`'s `accents`)
 * and a silent wrong-length parse is worse than a loud one.
 */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) {
    // A malformed token is a bug at the CALL SITE, not something to paper
    // over with a guess — but a crash mid-render is worse than a visibly
    // wrong (fully opaque) colour, so fail toward "too solid" rather than
    // toward invisible or throwing.
    return hex;
  }
  const r = parseInt(match[1].slice(0, 2), 16);
  const g = parseInt(match[1].slice(2, 4), 16);
  const b = parseInt(match[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Was: the accent-coloured bloom under a primary control. **Removed in N444
 * (#741)** along with its one remaining call site (`workouts.tsx`'s "New
 * workout" FAB) — the user reported that FAB's glow as the concrete example
 * of an inconsistency with Today's identically-shaped, deliberately flat
 * "New log" (N108: "the user has said twice that they do not want haze
 * anywhere"), and asked for one rule buttons follow, not two. N108's answer
 * wins: no glow, anywhere, ever again — so this helper has no reason to
 * exist. If a future screen wants to reintroduce a shadow, that is a new
 * decision to raise, not a reason to resurrect this function.
 */
