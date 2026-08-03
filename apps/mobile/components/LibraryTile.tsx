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
const DEFEND = vola.info; //    getting out / keeping guard
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
 * The same treatment for exercises, keyed on movement pattern.
 *
 * Explicit rather than derived. Truncating the pattern to three letters gave
 * `horizontal_push` and `horizontal_pull` the same code (HOR, 78 exercises) and
 * both vertical variants VER (51) — collapsing push against pull, which is the
 * first distinction a lifter scans for. A table is four more lines and cannot
 * collide silently.
 *
 * Hue is scoped to its own domain: red means "lower body" on an exercise and
 * "submission" on a technique. That is safe **because the code is always
 * present and names the domain** — PSH is never a technique, SUB is never an
 * exercise. It is what lets both halves use one validated three-hue palette
 * instead of a second one nobody measured.
 */
const PATTERN: Record<string, readonly [string, string]> = {
  horizontal_push: ['PSH', ADVANCE],
  vertical_push: ['OHP', ADVANCE],
  horizontal_pull: ['ROW', DEFEND],
  vertical_pull: ['PUL', DEFEND],
  squat: ['SQT', ATTACK],
  hinge: ['HNG', ATTACK],
  lunge: ['LNG', ATTACK],
  olympic: ['OLY', ATTACK],
  jump: ['JMP', ATTACK],
  isolation: ['ISO', HOLD],
  core: ['COR', HOLD],
  carry: ['CRY', HOLD],
  locomotion: ['LOC', HOLD],
  mobility: ['MOB', HOLD],
  rotation: ['ROT', HOLD],
};

export function patternBadge(pattern: string): readonly [string, string] {
  return PATTERN[pattern] ?? ['EX', HOLD];
}

/**
 * Positions, keyed on the position's own id — NOT on its family.
 *
 * All of them take the achromatic HOLD, deliberately: these are reference
 * reading rather than a thing you do, and a hue from this palette would imply
 * an intent (attacking, defending) that a position does not have — every
 * position is both, depending on which end of it you are on.
 *
 * Which is exactly why the code has to be per-position. With colour carrying
 * nothing here, the three letters are the *only* differentiator, and keying on
 * family printed GRD twice (closed and open guard) and SDE twice (side control
 * and knee on belly) — two pairs of identical tiles sitting side by side in a
 * eleven-card row. That breaks this file's own rule from the other direction:
 * colour never carries meaning alone, so the code may never be ambiguous.
 */
const POSITION: Record<string, string> = {
  standing: 'STD',
  'closed-guard': 'CLG',
  'open-guard': 'OPN',
  'half-guard': 'HLF',
  'side-control': 'SDE',
  'knee-on-belly': 'KOB',
  mount: 'MNT',
  'north-south': 'N-S',
  'back-control': 'BCK',
  turtle: 'TRT',
  // 'ASH' for ashi garami rather than 'LEG': the row is scanned, and LEG
  // reads as a body part next to ten position names.
  'leg-entanglement': 'ASH',
};

export function positionBadge(id: string): readonly [string, string] {
  return [POSITION[id] ?? 'POS', HOLD];
}

/**
 * Hex + alpha, as RN needs it. Kept explicit rather than using `opacity`,
 * which would fade the code text along with its backing.
 *
 * Only #RRGGBB concatenates correctly — `'red' + '1A'` and `'#F00' + '1A'` are
 * both invalid colours that RN renders as transparent, i.e. a tile that silently
 * disappears. Every accent flows through the two tables above, so this cannot
 * fire today; it is here so the next accent added fails visibly instead.
 */
function wash(hex: string, alpha: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return `${vola.surfaceRaised}${alpha}`;
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
      // Both, deliberately: importantForAccessibility is Android-only, so on
      // iOS VoiceOver would otherwise focus the tile and read "SUB" as an
      // orphan word just before the heading says "SUBMISSION".
      accessibilityElementsHidden
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
