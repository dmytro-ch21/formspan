import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';

/**
 * The visual anchor on the left of every Library row.
 *
 * Why this exists: only 4 of 524 exercises have artwork, and techniques have
 * none at all, so a list that renders an image *when there is one* is a list
 * that is blank 99% of the time. Rows became a wall of undifferentiated text
 * you cannot scan. A tile is always drawn — from the photo when there is one,
 * and otherwise from what the item IS.
 *
 * **Colour never carries meaning alone.** Every tile also shows a three-letter
 * code, so the palette is scanning assistance, not information. That matters
 * here for a specific measured reason: the obvious 5-colour scheme (one hue per
 * technique category) failed validation — violet against blue came out at ΔE
 * 2.0 for a deuteranope and 12.9 even with full colour vision, i.e. two
 * categories that look identical to everyone. Three hues plus a neutral clear
 * every check (worst adjacent pair ΔE 21.7 CVD / 35.6 normal), so the nine
 * categories map onto four *intents* for colour while the code stays specific.
 *
 * Re-run `validate_palette.js` against `vola.surface` before adding a fourth
 * hue; adjacent-pair separation is not eyeballable.
 */

/** What a technique is *for*. Colour groups by this; the code stays specific. */
const ATTACK = vola.danger; //  finishing
const ADVANCE = vola.lime; //   improving position
const DEFEND = '#6BB6FF'; //    getting out / keeping guard
const HOLD = vola.textMuted; // staying put — deliberately achromatic

/**
 * Category → [code, accent]. Codes are what a coach would write on a whiteboard;
 * they have to be legible at 11px, so three characters is the ceiling.
 */
const CATEGORY: Record<string, readonly [string, string]> = {
  Submission: ['SUB', ATTACK],
  Sweep: ['SWP', ADVANCE],
  Takedown: ['TKD', ADVANCE],
  Pass: ['PAS', ADVANCE],
  Transition: ['TRN', ADVANCE],
  Escape: ['ESC', DEFEND],
  'Guard Retention': ['RET', DEFEND],
  'Control/Pin': ['PIN', HOLD],
  Other: ['GEN', HOLD],
};

export function categoryBadge(category: string): readonly [string, string] {
  return CATEGORY[category] ?? ['GEN', HOLD];
}

/**
 * Exercises get the same treatment keyed on movement pattern, so a mixed list
 * reads as one library rather than two that share a screen. Achromatic on
 * purpose: strength work is the bulk of the catalog, and colouring 498 rows
 * would drown the technique accents that actually mean something.
 */
export function patternBadge(pattern: string): readonly [string, string] {
  const code = pattern
    .replace(/[^a-z]/gi, '')
    .slice(0, 3)
    .toUpperCase();
  return [code || 'EX', vola.textMuted];
}

/**
 * Hex + alpha, as RN needs it. Kept explicit rather than using `opacity`,
 * which would fade the code text along with its backing.
 */
function wash(hex: string, alpha: string): string {
  return `${hex}${alpha}`;
}

export function LibraryTile({
  uri,
  code,
  accent,
}: {
  /** The photo, when the item has one — always preferred over the code. */
  uri?: string | null;
  code: string;
  accent: string;
}) {
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={styles.tile}
        contentFit="cover"
        // Immutable keys, so caching hard is free and correct.
        cachePolicy="memory-disk"
        transition={150}
        // Decorative: the name beside it already says what this is, and
        // expo-image's web renderer maps accessibilityLabel to alt.
        alt=""
        accessible={false}
      />
    );
  }
  return (
    <View
      style={[
        styles.tile,
        styles.coded,
        { backgroundColor: wash(accent, '1A'), borderColor: wash(accent, '44') },
      ]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.code, { color: accent }]}>{code}</Text>
    </View>
  );
}

export const TILE_SIZE = 52;

const styles = StyleSheet.create({
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: 13,
    backgroundColor: vola.surfaceRaised,
  },
  coded: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  code: { fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
});
