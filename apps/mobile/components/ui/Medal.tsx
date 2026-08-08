import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { activeMedalFace, activeMedalRim, vola, type MedalTier } from '@/constants/Colors';

/**
 * A medal, drawn from views.
 *
 * Drawn from views rather than SVG. **The original reason given here has since
 * expired and is corrected rather than repeated:** it claimed
 * `react-native-svg` was unavailable and that "no gradient library is
 * installed", and both are now in `package.json` (`react-native-svg` 15.15.4,
 * `expo-linear-gradient`). Anyone reading the old note would have designed
 * around a constraint that had lifted.
 *
 * Views are still the right call, just for a smaller reason: a medal is a disc,
 * a rim and two ribbon tails, which views draw exactly, and the metal reads
 * fine from a rim a shade lighter than the face. Reaching for SVG here would
 * buy nothing.
 *
 * **The tier means something.** Gold is a record set in the last 30 days —
 * what the API already calls `is_recent` — and silver is a standing record set
 * before that. That is the distinction worth drawing on this screen: a lifter
 * scanning their bests wants to know which ones are *live*, not merely which
 * exist. A single trophy on every row would be decoration; two tiers is
 * information.
 *
 * Colour is not the only signal. The gold medal also carries a star and the
 * silver does not, so the tiers survive greyscale — the same discipline the
 * calendar's ✓/○ markers follow, and for the same reason.
 */

export type { MedalTier };

/**
 * Warm and cool metals — or two greys, in monochrome.
 *
 * The values moved to `constants/Colors.ts` so the mono swap can reach them.
 * They were literals here, which is exactly why a black-and-white app still had
 * one gold disc on it: `vola` is one object and these were not in it.
 */
const FACE = activeMedalFace;
const RIM = activeMedalRim;

export function Medal({ tier, size = 26 }: { tier: MedalTier; size?: number }) {
  const disc = Math.round(size * 0.72);
  return (
    <View style={[{ width: size, height: size }, styles.wrap]} accessible={false}>
      {/* Ribbon tails, behind the disc — two rules splayed from the top. */}
      <View
        style={[
          styles.ribbon,
          {
            width: Math.max(2, size * 0.1),
            height: size * 0.42,
            backgroundColor: vola.line,
            transform: [{ rotate: '20deg' }],
            left: size * 0.28,
          },
        ]}
      />
      <View
        style={[
          styles.ribbon,
          {
            width: Math.max(2, size * 0.1),
            height: size * 0.42,
            backgroundColor: vola.line,
            transform: [{ rotate: '-20deg' }],
            right: size * 0.28,
          },
        ]}
      />
      <View
        style={{
          width: disc,
          height: disc,
          borderRadius: disc / 2,
          backgroundColor: FACE[tier],
          borderWidth: Math.max(1, size * 0.06),
          borderColor: RIM[tier],
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: size * 0.2,
        }}
      >
        {tier === 'gold' && (
          <Text style={{ fontSize: Math.round(disc * 0.6), lineHeight: disc, color: vola.bg }}>
            ★
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'flex-start' },
  ribbon: { position: 'absolute', top: 0, borderRadius: 1 },
});
