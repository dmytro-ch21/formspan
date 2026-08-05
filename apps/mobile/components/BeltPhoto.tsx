import { Image } from 'expo-image';
import {
  StyleSheet,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { MAX_DEGREE, MAX_STRIPES, type Belt } from '@/lib/bjj';

/**
 * The belt as a photograph, with its stripes drawn on.
 *
 * The five renders are supplied artwork, not generated — unlike everything else
 * in `assets/images/`, there is no SVG upstream and no script that rebuilds
 * them. They are cut-outs on a transparent ground at 1024×683, one per colour,
 * identical in framing so they can be swapped.
 *
 * **The stripes are code, not artwork, and that is a deliberate trade.** A
 * stripe render was supplied too and is not used: at the size this actually
 * draws — the masthead gives the belt ~295pt, so the rank bar is ~40pt and a
 * single stripe about 8pt — a photographic stripe's weave is invisible, while
 * the arithmetic to place 0–4 of them at the right pitch is the same either
 * way. Drawing them means every combination is exact and no combination needs
 * an asset.
 *
 * `Belt.tsx` still exists and is still the right thing in a list: a 1024px
 * photograph scaled into a 44pt row is mush, and the drawn belt stays crisp.
 * This is for the one place the belt is the subject.
 */

/**
 * Where the rank bar sits on the render.
 *
 * Measured off the **black belt's red bar**, by the pixel distribution's
 * principal axis rather than its bounding box — a bbox diagonal is not an
 * angle, and taking one put the first attempt at 42° instead of 28.5°.
 *
 * One geometry for all five, which took two wrong turns to arrive at. The
 * renders share a framing, but the *bars* segment differently: a red bar on
 * black is cleanly separable, while a dark bar on a dark belt is not. A second
 * measurement taken from the purple belt came out at 20.7°, and rendering the
 * coloured belts against it put the stripes off the bar's lower edge — the
 * predicate had caught the belt's own shading and skewed the axis. The red
 * bar's numbers render correctly on all five; the purple ones do not.
 *
 * All fractions of the image's *width*, so they survive any render size.
 *
 * `across` is deliberately narrower than the bar it was measured from (0.083 →
 * 0.076): a stripe sits *inside* the bar, and at the measured full width the
 * ends hung over both edges. It was 0.062 at first, which was clear of the
 * edges and also visibly short of them.
 */
const BAR = {
  cx: 0.7816,
  cy: 0.6433,
  angle: 28.48,
  /** Along the belt — the axis stripes are spaced down. */
  length: 0.1352,
  /** Across the belt — how long each stripe is. */
  across: 0.076,
};

/** The render's own aspect, so a caller only ever passes a width. */
const ASPECT = 683 / 1024;

export function BeltPhoto({
  belt,
  stripes,
  degree,
  width,
  label,
  style,
}: {
  belt: Belt;
  stripes: number;
  degree: number;
  width: number;
  /** The whole thing is one image to a screen reader; this is what it says. */
  label: string;
  /** Placement is the caller's; the component only owns its own size. */
  style?: StyleProp<ViewStyle>;
}) {
  const height = width * ASPECT;

  /**
   * Black belts count degrees on the red bar; every other belt counts stripes.
   * Both render identically — a white band across the bar — so the only
   * difference is which number is being drawn and how many can fit.
   */
  const count = Math.min(
    belt === 'black' ? degree : stripes,
    belt === 'black' ? MAX_DEGREE : MAX_STRIPES,
  );

  // A stripe's thickness is a fraction of the bar rather than a constant: the
  // bar has to hold six degrees on a black belt and four stripes elsewhere, so
  // a fixed pitch would overflow one or look sparse on the other.
  //
  // 0.6 of the pitch, not 0.42. At the size the card actually renders — a 215pt
  // belt puts the bar at ~29pt — the first ratio drew 2pt marks that read as
  // scratches rather than stripes. 0.6 leaves a gap just under half a stripe
  // wide, which is about what a real belt shows.
  const slots = belt === 'black' ? MAX_DEGREE : MAX_STRIPES;
  const pitch = (BAR.length * width) / (slots + 1);
  const thickness = Math.max(2, pitch * 0.6);

  return (
    <View
      style={[{ width, height }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <Image
        source={BELT_IMAGES[belt]}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        // The renders are bundled, so there is nothing to fetch and nothing to
        // fade in from; a transition here reads as the belt loading late.
        transition={0}
      />

      {Array.from({ length: count }, (_, i) => {
        // Centred on the bar and spread symmetrically, so one stripe sits in
        // the middle rather than at an end, and four fill it evenly.
        const offset = (i - (count - 1) / 2) * pitch;
        const rad = (BAR.angle * Math.PI) / 180;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: BAR.cx * width + offset * Math.cos(rad) - thickness / 2,
              top: BAR.cy * height + offset * Math.sin(rad) - (BAR.across * width) / 2,
              width: thickness,
              height: BAR.across * width,
              backgroundColor: '#F2F0EA',
              transform: [{ rotate: `${BAR.angle}deg` }],
              borderRadius: 1,
            }}
          />
        );
      })}
    </View>
  );
}

/**
 * `require` rather than a map built from the belt name, because Metro resolves
 * these at build time — a computed path bundles nothing and fails at runtime.
 */
const BELT_IMAGES: Record<Belt, ImageSourcePropType> = {
  white: require('@/assets/images/belts/white.webp'),
  blue: require('@/assets/images/belts/blue.webp'),
  purple: require('@/assets/images/belts/purple.webp'),
  brown: require('@/assets/images/belts/brown.webp'),
  black: require('@/assets/images/belts/black.webp'),
};

/**
 * The hero image on the Today card — one belt, everyone's screen.
 *
 * Deliberately not the athlete's own rank: it is decoration behind a session
 * card, not a statement about them, and there is one render rather than five.
 * If that ever changes, this is the only export to touch.
 */
export const BELT_HERO = require('@/assets/images/belts/hero.webp');
