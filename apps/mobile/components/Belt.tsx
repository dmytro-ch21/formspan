import { StyleSheet, View } from 'react-native';

import { activeRankBar, activeStrap, vola } from '@/constants/Colors';

/**
 * A jiu-jitsu belt, drawn rather than illustrated.
 *
 * **No SVG, and not for want of trying to be fancy.** A belt is three
 * rectangles — the strap, the rank bar sewn near one end, and the stripes
 * inside it — so plain views draw it exactly. That avoids adding
 * `react-native-svg` (a native dependency, and therefore a prebuild and a
 * fresh device build for everyone) to render four straight lines, and it
 * means the web and admin versions are the same shapes in CSS rather than a
 * separate asset pipeline nobody remembers to regenerate.
 *
 * **The rank bar is black on coloured belts and red on a black belt.** That is
 * how belts are actually made, and getting it wrong is the kind of detail a
 * grappler notices immediately and reads as "written by someone who doesn't
 * train".
 *
 * **The white belt carries a border.** Every other belt is legible on VOLA's
 * near-black ground; a white strap needs an edge or it reads as a floating
 * rank bar with nothing attached.
 */

export type Belt = 'white' | 'blue' | 'purple' | 'brown' | 'black';

// Strap and rank-bar colours live in `constants/Colors.ts` now, so the
// monochrome mode can reach them — they were literals here, which is why a
// black-and-white app still drew a blue belt. `active*` resolves per launch.
const STRAP = activeStrap;
const RANK_BAR = activeRankBar;

/** Stripes are white tape on every belt — already achromatic, mono or not. */
const STRIPE = '#EDEAE3';

export function Belt({
  belt,
  stripes = 0,
  degree = 0,
  width = 220,
  label,
}: {
  belt: Belt;
  /** 0–4 on any belt. Clamped rather than trusted — see below. */
  stripes?: number;
  /** Black-belt degrees, 0–6. Rendered in the rank bar exactly like stripes. */
  degree?: number;
  width?: number;
  /** Accessible name. Callers pass the same text they show beside it. */
  label?: string;
}) {
  const height = Math.round(width * 0.17);
  const barWidth = Math.round(width * 0.3);

  // Clamped here, not trusted from the caller. The server validates on write,
  // but a belt rendered from a cached row written by an older build should
  // degrade to a sensible belt rather than draw seven stripes off the end of
  // the strap.
  const count = Math.max(0, Math.min(belt === 'black' ? degree : stripes, 6));

  const strap = STRAP[belt] ?? STRAP.white;
  const bar = RANK_BAR[belt] ?? RANK_BAR.white;

  return (
    <View
      style={[
        styles.strap,
        {
          width,
          height,
          backgroundColor: strap,
          // Only the white belt needs an edge; giving every belt one would
          // read as a UI border rather than as the belt's own shape.
          borderWidth: belt === 'white' ? StyleSheet.hairlineWidth : 0,
          borderColor: vola.textDim,
        },
      ]}
      accessibilityRole="image"
      accessibilityLabel={label ?? describeBelt(belt, stripes, degree)}
      testID={`belt-${belt}`}
    >
      <View
        style={[
          styles.rankBar,
          {
            width: barWidth,
            backgroundColor: bar,
            // Numeric, not a percentage. RN's types accept a percentage gap
            // but it is not honoured the way a percentage padding is, and a
            // silently-ignored gap bunches four stripes into one thick line —
            // which reads as a different rank.
            gap: Math.max(2, Math.round(barWidth * 0.08)),
            paddingHorizontal: Math.max(3, Math.round(barWidth * 0.1)),
          },
        ]}
      >
        {Array.from({ length: count }, (_, i) => (
          <View key={i} style={styles.stripe} />
        ))}
      </View>
    </View>
  );
}

/**
 * "Purple belt, two stripes" — the sentence a screen reader should read.
 *
 * Exported because the same wording belongs in text beside the belt, and two
 * independently-written descriptions of one rank is how they end up
 * disagreeing.
 */
export function describeBelt(belt: Belt, stripes = 0, degree = 0): string {
  const name = belt.charAt(0).toUpperCase() + belt.slice(1);
  if (belt === 'black' && degree > 0) {
    return `${name} belt, ${degree}${ordinal(degree)} degree`;
  }
  if (stripes > 0) {
    return `${name} belt, ${stripes} ${stripes === 1 ? 'stripe' : 'stripes'}`;
  }
  return `${name} belt`;
}

function ordinal(n: number): string {
  return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
}

const styles = StyleSheet.create({
  strap: {
    borderRadius: 3,
    justifyContent: 'center',
    // The rank bar sits near one end of a real belt, not in the middle.
    alignItems: 'flex-end',
    paddingRight: '10%',
    overflow: 'hidden',
  },
  rankBar: {
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripe: {
    // Flex rather than a fixed width so one stripe and four stripes both fill
    // the bar proportionally, at any `width` the caller asks for.
    flex: 1,
    maxWidth: 6,
    height: '62%',
    backgroundColor: STRIPE,
    borderRadius: 1,
  },
});
