import type { ViewStyle } from 'react-native';
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
 * The accent-coloured bloom under a primary control — and nothing at all in
 * monochrome.
 *
 * Three surfaces (the Today action, the Workouts action, the calendar's selected
 * day) set `shadowColor` to the accent rather than to black, so the button reads
 * as lit rather than as lifted. In colour that is a soft green or amber halo. In
 * mono the accent is a near-white, and a near-white bloom on a near-black ground
 * is not subtle — it is a glow, on the one theme whose whole point is being
 * plain.
 *
 * `shadowOpacity` and `elevation` are zeroed rather than just the colour:
 * a transparent iOS shadow still costs an offscreen pass, and Android draws
 * `elevation` on its own regardless of what colour it was told.
 */
export function accentGlow(accent: string): ViewStyle {
  return isMono ? NO_GLOW : { shadowColor: accent };
}

const NO_GLOW: ViewStyle = { shadowColor: 'transparent', shadowOpacity: 0, elevation: 0 };
