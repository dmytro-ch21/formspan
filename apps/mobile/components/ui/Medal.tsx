import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';

/**
 * A medal, drawn from views.
 *
 * Same rule as `ui/Icon` and `Belt`: no `react-native-svg`, because it is a
 * native dependency and therefore a prebuild and a fresh device build for
 * everyone. A medal is a disc, a rim and two ribbon tails, which views draw
 * exactly — and no gradient library is installed, so the metal is suggested by
 * a rim a shade lighter than the face rather than by a sheen.
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

export type MedalTier = 'gold' | 'silver';

/** Warm and cool metals. Both clear 3:1 against `surface` on this dark ground. */
const FACE: Record<MedalTier, string> = { gold: '#C9A227', silver: '#8A94A6' };
const RIM: Record<MedalTier, string> = { gold: '#F2D98A', silver: '#C3CAD6' };

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
