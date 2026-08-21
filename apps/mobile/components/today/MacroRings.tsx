import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';

import { vola } from '@/constants/Colors';
import { ringColor, sweepFor, type RingReading } from '@/lib/macroRings';
import { useReducedMotion } from '@/lib/useReducedMotion';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * The Today card's concentric macro rings.
 *
 * ## Apple's rings, not the reference's
 *
 * The reference draws four arcs at uneven radii, from different start angles,
 * with ragged gaps — they read as scattered strokes rather than as a set. The
 * user's correction was explicit, so what this draws instead is the Apple Watch
 * activity-ring treatment:
 *
 * - **one centre**, with **even gaps** — the spacing is as visible as the
 *   strokes, so it is a constant rather than a per-ring value;
 * - **one start angle**, 12 o'clock, every ring sweeping clockwise;
 * - **thick strokes with round caps**, which is most of what makes a set read
 *   as a set;
 * - **smaller overall** than the reference's. Thicker stroke and smaller
 *   diameter are not in conflict — together they are the whole look.
 *
 * ## No glow. Anywhere.
 *
 * The reference blooms around every ring. The user has said twice that they do
 * not want it, so there is no `shadow*`, no `elevation` and no `accentGlow`
 * here, and the track is a flat low-opacity stroke rather than a halo.
 *
 * ## Past 100%, the ring wraps
 *
 * See {@link sweepFor} for the reasoning — briefly, a ring that stops at 100%
 * makes 144% and 100% identical while an `Over target` pill beside it says
 * otherwise. The second lap is drawn over the first in the same hue, separated
 * from it by a hairline gap of the card's own ground, so "went round again" is
 * legible without a second colour that would need its own place in the palette
 * gate.
 */
export type MacroRingsProps = {
  readings: RingReading[];
  /** Outer diameter in points. */
  size?: number;
  /** Stroke width of each ring. */
  stroke?: number;
  /** Gap between adjacent rings. */
  gap?: number;
  children?: React.ReactNode;
  testID?: string;
};

/**
 * Defaults tuned to the amendment: **smaller than the reference, thicker
 * stroke.** The reference's ring stack is roughly 210pt across with a ~7pt
 * stroke; this is 168 with 13, which is the Apple proportion (stroke is about
 * 8% of diameter) at a diameter that leaves the macro rows their width on a
 * 390pt screen.
 */
const SIZE = 168;
const STROKE = 13;
const GAP = 5;

export function MacroRings({
  readings,
  size = SIZE,
  stroke = STROKE,
  gap = GAP,
  children,
  testID,
}: MacroRingsProps) {
  return (
    <RNView style={[styles.wrap, { width: size, height: size }]} testID={testID}>
      <Svg width={size} height={size}>
        {/*
          Rotate the whole stack once rather than per ring. Every ring therefore
          starts at 12 o'clock by construction — the "one common start angle"
          rule cannot be broken by adding a ring, because no ring carries its
          own rotation to get wrong.
        */}
        <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
          {/*
            Rings whose colour is null are not drawn AT ALL — monochrome's
            calorie ring is the only such case today. Filtering here rather than
            returning null inside `Ring` keeps the radius step contiguous: the
            index feeding the radius is the index among DRAWN rings, so a hidden
            outer ring closes up instead of leaving a gap where it would have
            been.
          */}
          {readings
            .map((reading) => ({ reading, colour: ringColor(reading.key) }))
            .filter((r): r is { reading: RingReading; colour: string } => r.colour !== null)
            .map(({ reading, colour }, i) => (
            <Ring
              key={reading.key}
              reading={reading}
              colour={colour}
              size={size}
              stroke={stroke}
              // Outermost first: index 0 sits at the full radius and each
              // subsequent ring steps in by one stroke plus one gap. Even
              // spacing falls out of this rather than being tuned per ring.
              radius={(size - stroke) / 2 - i * (stroke + gap)}
            />
          ))}
        </G>
      </Svg>
      {children ? <RNView style={styles.centre}>{children}</RNView> : null}
    </RNView>
  );
}

function Ring({
  reading,
  colour,
  size,
  stroke,
  radius,
}: {
  reading: RingReading;
  colour: string;
  size: number;
  stroke: number;
  radius: number;
}) {
  const sweep = sweepFor(reading.percent);
  const circumference = 2 * Math.PI * radius;

  const reduced = useReducedMotion();
  const [base] = useState(() => new Animated.Value(0));
  const [over] = useState(() => new Animated.Value(0));

  const targetBase = sweep ? sweep.base : 0;
  const targetOver = sweep?.overflow ?? 0;

  useEffect(() => {
    // Hold while the OS has not answered. Animating here would sweep the ring
    // for somebody who asked not to be moved, every cold start, because the
    // first frame always precedes the answer.
    if (reduced === null) return;

    if (reduced) {
      // Reduce Motion is a request not to be MOVED, not a request to see
      // nothing — the ring still shows its value, it just arrives there.
      base.setValue(targetBase);
      over.setValue(targetOver);
      return;
    }

    const anim = Animated.parallel([
      Animated.timing(base, {
        toValue: targetBase,
        duration: 620,
        easing: Easing.out(Easing.cubic),
        // strokeDashoffset is not a transform or an opacity, so it cannot go
        // to the native thread. Stated rather than left as a silent `false`.
        useNativeDriver: false,
      }),
      Animated.timing(over, {
        toValue: targetOver,
        duration: 620,
        // The second lap starts only once the first has closed, so it reads as
        // one continuous sweep going round again rather than two racing arcs.
        delay: targetOver > 0 ? 380 : 0,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [reduced, targetBase, targetOver, base, over]);

  const dashOffset = useMemo(
    () =>
      base.interpolate({
        inputRange: [0, 1],
        outputRange: [circumference, 0],
      }),
    [base, circumference],
  );

  const overOffset = useMemo(
    () =>
      over.interpolate({
        inputRange: [0, 1],
        outputRange: [circumference, 0],
      }),
    [over, circumference],
  );

  const common = {
    cx: size / 2,
    cy: size / 2,
    r: radius,
    strokeWidth: stroke,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
  };

  return (
    <>
      {/*
        The track. Always drawn, including when `percent` is null — an empty
        track is what "no target set" looks like, and it is deliberately not the
        same thing as a ring sitting at zero, which would be a claim that
        nothing was eaten.
      */}
      <Circle {...common} stroke={colour} strokeOpacity={sweep ? 0.16 : 0.1} />
      {sweep ? (
        <AnimatedCircle
          {...common}
          stroke={colour}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      ) : null}
      {sweep?.overflow != null ? (
        <>
          {/*
            A hairline of the card's own ground under the second lap, so the
            wrap is legible as a separate pass without inventing a second colour
            that would need its own row in the palette gate. Drawn at the full
            circumference because the first lap beneath it is complete.
          */}
          <AnimatedCircle
            {...common}
            stroke={vola.surface}
            strokeWidth={stroke + 3}
            strokeDasharray={circumference}
            strokeDashoffset={overOffset}
          />
          <AnimatedCircle
            {...common}
            stroke={colour}
            strokeDasharray={circumference}
            strokeDashoffset={overOffset}
          />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  centre: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
