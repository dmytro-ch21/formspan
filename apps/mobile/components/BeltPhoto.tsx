import { Image } from 'expo-image';
import {
  StyleSheet,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Polygon } from 'react-native-svg';

import { stripeQuads } from '@/lib/beltBar';
import { type Belt } from '@/lib/bjj';

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
 * draws — the rank card gives the belt 215pt, which puts the bar at ~24pt and a
 * single stripe under 3pt — a photographic stripe's weave is invisible, while
 * the arithmetic to place 0–4 of them at the right pitch is the same either
 * way. Drawing them means every combination is exact and no combination needs
 * an asset.
 *
 * Where they go is `lib/beltBar.ts`, measured per belt. This file owns only the
 * decision of *what* to draw — degrees or stripes — and the drawing itself.
 *
 * `Belt.tsx` still exists and is still the right thing in a list: a 1024px
 * photograph scaled into a 44pt row is mush, and the drawn belt stays crisp.
 * This is for the one place the belt is the subject.
 */

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
   * difference is which number is being drawn. How many will *fit* is the
   * bar's business, and `stripeQuads` clamps to it.
   */
  const count = belt === 'black' ? degree : stripes;

  return (
    <View
      // Size last: the belt, the stripe geometry and the SVG viewport are all
      // derived from `width`, so a caller overriding it here would letterbox
      // the photograph and leave the stripes where they were.
      style={[style, { width, height }]}
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

      {/*
        Polygons rather than rotated `View`s. The bar reaches the render as a
        quadrilateral in perspective — its long edges converge, and the angle
        between long and short edges is 2.2°–10.6° off square depending on the
        belt — so a single `rotate` cannot lie a stripe flat on it however the
        centre is placed. See `lib/beltBar.ts`, which owns every number.

        `pointerEvents="none"` because an `Svg` **is** a hit target across its
        whole box even where no shape is under the finger — it is the wrapper's
        `accessible` flag that hides it from a screen reader, and that flag has
        nothing to do with touch. The rank card works either way, since the
        responder system bubbles to the `Pressable` above, but relying on that
        is relying on a detail. The sibling `Svg` in `BjjRankHeader` already
        passes this.
      */}
      <Svg
        width={width}
        height={height}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      >
        {stripeQuads(belt, count).map((quad, i) => (
          <Polygon
            key={i}
            points={quad.map(([x, y]) => `${x * width},${y * height}`).join(' ')}
            fill="#F2F0EA"
          />
        ))}
      </Svg>
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
