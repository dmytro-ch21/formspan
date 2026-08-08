import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View as RNView } from 'react-native';

import { Icon, type IconName } from '@/components/ui/Icon';
import { isMono, vola } from '@/constants/Colors';

/**
 * The artwork on a VOLA Workout tile.
 *
 * **Still nothing bundled, downloaded or decoded.** The brief asked twice for
 * something that looks good and is not expensive in memory, and the cheapest
 * answer to that remains not a small image but no image: everything here is a
 * gradient, three flat shapes and one stroked glyph, all from values already in
 * the binary. Seventeen plans cost zero bytes of assets; an eighteenth costs the
 * same.
 *
 * What changed from the first version is the *composition*, not the budget. A
 * 76pt strip could only carry a wash of colour and a small icon. A square has
 * room for an actual picture, so it gets one: an angled band, a soft corner
 * bloom, and the glyph at a size you can read across a two-column grid.
 *
 * Stock photography was reconsidered and rejected again, for the reasons that
 * have nothing to do with bytes: licences to track, images that date, and
 * seventeen small judgements about who a plan is "for" that nobody asked this
 * app to make.
 */

/**
 * Deep, low-saturation pairs.
 *
 * Dark enough to read as artwork rather than as a highlight, and dark enough
 * that the white band and bloom drawn over them stay visible at 5–6% opacity.
 * No type sits on the gradient — the plan's name is in the tile body below it —
 * so this needs no scrim, which is the whole reason the composition puts the
 * name outside the picture.
 */
const PALETTES: readonly (readonly [string, string])[] = [
  ['#14324a', '#0d1b2a'],
  ['#2b1f45', '#141024'],
  ['#123a33', '#0b1f1c'],
  ['#3a2418', '#1d120c'],
  ['#1c2f4d', '#0e1726'],
  ['#38203a', '#1b0f1c'],
];

/**
 * The same six, drained of hue.
 *
 * These are artwork rather than signal, so the mono versions only have to keep
 * the two properties the note above claims: dark enough to read as a picture,
 * and light enough at the top that the white band and bloom stay visible over
 * them. Six of them rather than one, because the whole point of the set is that
 * two plans side by side do not look like the same card.
 */
const MONO_PALETTES: readonly (readonly [string, string])[] = [
  ['#2e3542', '#171c25'],
  ['#272d39', '#13171f'],
  ['#333a48', '#191e27'],
  ['#2a303c', '#151920'],
  ['#3a4150', '#1d222c'],
  ['#232935', '#11151c'],
];

/**
 * Which brand glyph sits on the plan.
 *
 * Read off the goal rather than the name, so it never has to be authored per
 * plan and cannot drift when one is renamed.
 */
export function planIcon(goal: string | null): IconName {
  if (goal === 'endurance') return 'heart';
  if (goal === 'powerlifting') return 'weight';
  return 'workout';
}

/**
 * Stable across launches and devices.
 *
 * A plain character sum rather than anything cryptographic: the only property
 * needed is that the same id always lands on the same artwork, and that two
 * adjacent plans in a grid rarely collide. A random pick would shimmer between
 * renders and make a screenshot taken last week disagree with the app.
 */
function hash(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return n;
}

export function paletteFor(id: string): readonly [string, string] {
  // The set swaps, the INDEX does not — so a plan keeps the same artwork slot
  // through a mode change rather than shuffling into a different one.
  const set = isMono ? MONO_PALETTES : PALETTES;
  return set[hash(id) % set.length];
}

/**
 * The angle of the band across the tile, in degrees: nine steps of 11° from
 * -44 to 44.
 *
 * Derived from a different slice of the hash than the palette, so two plans
 * sharing a palette still look different — with six palettes and seventeen
 * plans, palette collisions are certain, and identical tiles side by side is
 * exactly what makes a grid unscannable. Six palettes × nine angles happens to
 * give the seeded seventeen a distinct pair each; that is luck, not a promise,
 * and `planHero.test.ts` is what would notice it stop being true.
 *
 * **`>>>`, not `>>`.** The first version shifted signed, so the seven seeded
 * ids whose hash exceeds 2^31 took a negative remainder and landed on angles
 * outside the range this arithmetic reads as producing — one of them at -91°,
 * a near-vertical band nothing in the code accounted for. It looked deliberate
 * on screen, which is why it would never have been reported.
 */
export function bandAngleFor(id: string): number {
  return -44 + ((hash(id) >>> 3) % 9) * 11;
}

export function PlanHero({ id, goal }: { id: string; goal: string | null }) {
  const [from, to] = paletteFor(id);
  const angle = bandAngleFor(id);

  return (
    <LinearGradient
      colors={[from, to]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.hero}
      // Decorative: the plan's name is right beside it, so announcing this
      // would only make a screen reader say "image" before every tile.
      accessible={false}
    >
      {/* The band. Rotated well past the tile's own bounds so its ends are
          always off-canvas — a band whose corners are visible reads as a
          rectangle somebody left there rather than as a graphic. */}
      <RNView
        style={[styles.band, { transform: [{ rotate: `${angle}deg` }] }]}
        pointerEvents="none"
      />
      {/* A corner bloom, to keep the flat fill from looking like a swatch. */}
      <RNView style={styles.bloom} pointerEvents="none" />

      <RNView style={styles.glyph} pointerEvents="none">
        <Icon name={planIcon(goal)} size={30} color={vola.textMuted} strokeWidth={1.4} />
      </RNView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  // No radius of its own: the artwork bleeds into the tile's rounded clip, the
  // way web's does. Rounding it here left four surface-coloured notches where
  // the r12 hero sat inside the r14 tile.
  hero: { aspectRatio: 1, width: '100%', overflow: 'hidden', justifyContent: 'center' },
  band: {
    position: 'absolute',
    // 210% of the tile's width. At the steepest angle the formula produces
    // (44°) the band's short ends still clear the visible edge by ~12% of the
    // tile — at 180% they cleared it by 1.5%, which a rounding error is wide
    // enough to eat. It costs nothing: the tile clips it either way.
    left: '-55%',
    right: '-55%',
    height: '38%',
    top: '18%',
    backgroundColor: '#FFFFFF',
    opacity: 0.05,
  },
  bloom: {
    position: 'absolute',
    top: '-30%',
    right: '-25%',
    width: '75%',
    aspectRatio: 1,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    opacity: 0.06,
  },
  glyph: { position: 'absolute', right: 12, bottom: 10, opacity: 0.85 },
});
