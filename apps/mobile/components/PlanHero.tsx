import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View as RNView } from 'react-native';

import { Icon, type IconName } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';

/**
 * The artwork on a public plan's card.
 *
 * **Nothing is bundled, downloaded or decoded.** The brief asked for something
 * that looks good and is not expensive in memory, and the cheapest possible
 * answer to that is not a small image — it is no image: a two-stop gradient and
 * one stroked icon, both drawn from values already in the binary. Sixteen plans
 * cost zero bytes of assets and zero decode time, and a seventeenth costs the
 * same.
 *
 * That also sidesteps the thing photography would have dragged in. Stock images
 * of people training carry licences, they date, and picking them for sixteen
 * plans is sixteen small judgements about who a plan is "for" that nobody asked
 * this app to make.
 *
 * ## Deterministic, not random
 *
 * The palette is chosen by hashing the plan's id, so a plan looks the same on
 * every launch, on every device, and in a screenshot taken last week. A random
 * pick would shimmer between renders; a per-goal pick would make the whole
 * bodyweight section one colour and the browse list harder to scan, not easier.
 */

/**
 * Deep, low-saturation pairs. Dark enough that the white plan name sits on top
 * of them at readable contrast without a scrim — a bright gradient would need
 * one, and a scrim over a gradient is two effects doing one job.
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
 * Which brand glyph sits on the plan.
 *
 * Read off the goal rather than the name, so it never has to be authored per
 * plan and cannot drift when one is renamed. `workout` is the fallback and the
 * common case; the others mark the two plans that are genuinely a different
 * kind of session.
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
 * needed is that the same id always lands on the same palette, and that two
 * adjacent plans in the list rarely collide.
 */
export function paletteFor(id: string): readonly [string, string] {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTES[n % PALETTES.length];
}

export function PlanHero({
  id,
  goal,
  height = 76,
}: {
  id: string;
  goal: string | null;
  height?: number;
}) {
  const [from, to] = paletteFor(id);
  return (
    <LinearGradient
      colors={[from, to]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.hero, { height }]}
      // Decorative: the plan's name is right beside it, so announcing this
      // would just make a screen reader say "image" before every card.
      accessible={false}
    >
      <RNView style={styles.glyph}>
        <Icon name={planIcon(goal)} size={26} color={vola.textMuted} strokeWidth={1.4} />
      </RNView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: 12, overflow: 'hidden', justifyContent: 'center' },
  glyph: { position: 'absolute', right: 14, bottom: 12, opacity: 0.8 },
});
