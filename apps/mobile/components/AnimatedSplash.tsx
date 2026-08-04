import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';

import { vola } from '@/constants/Colors';

/**
 * The opening animation: VOLA writes itself letter by letter, then the mark
 * lands above it and the finished lockup fades out into the app.
 *
 * **It is drawn, not played.** There is no video and no Lottie file — the two
 * PNGs it composes are the same brand assets the header already uses, and
 * every position below is measured off the stacked lockup rather than eyeballed
 * (see the constants). That matters because the artwork will be re-exported
 * eventually and a baked animation would silently keep showing the old logo.
 *
 * **Why a wipe and not a stroke.** "Writes letter by letter" suggests animating
 * a pen along each glyph, but the wordmark is a set of *filled outlines* — there
 * is no centreline to travel down, so there is no stroke to draw. Each letter is
 * instead uncovered left-to-right by a rectangle in the background colour that
 * shrinks onto its own right edge. On a solid ground the rectangle is invisible
 * and the letter simply appears to be written.
 *
 * Every animated property here is `opacity` or `transform`, which is what lets
 * all of it run with `useNativeDriver` — the animation keeps its frames while
 * the JS thread is busy doing the actual work of launching (fonts, Clerk,
 * SQLite migrations). A width animation would have been the obvious way to
 * write the wipe and would have run on the JS thread, i.e. stuttered during
 * precisely the launch it exists to cover.
 *
 * No `react-native-svg`: this app deliberately has none (see `Belt.tsx` and
 * `ui/Icon.tsx` for why), and nothing here needs it.
 */

// The lockup's proportions, measured off `vola-stacked-color.svg` in its own
// coordinate space, so what is reproduced here is the designed relationship:
//
//   wordmark  x 3568..17598 (w 14030)   y 12529..14288 (h 1759)
//   mark      x 7328..14035 (w  6707)   y  5088..11132 (h 6044)
//
// Everything is a ratio of the wordmark's width, because that is the single
// dimension the splash actually chooses.
const WORDMARK_W = 240;
const WORDMARK_H = WORDMARK_W * (1759 / 14030);
const MARK_W = WORDMARK_W * (6707 / 14030);
const MARK_GAP = WORDMARK_W * (1397 / 14030); // mark's bottom edge to the wordmark's top
// The lockup centres the mark on *itself*, not on the wordmark — 98.5 units to
// the right of the wordmark's centre. Under two points at this size, and kept
// only because reproducing the lockup is the whole job.
const MARK_DX = WORDMARK_W * (98.5 / 14030);

// `vola-mark.png` is trimmed to its content box and then squared with
// transparent padding — ScreenHeader's convention, and this file follows it so
// there is one mark asset rather than two that can drift apart. A `contain` fit
// therefore draws the artwork at its own 4645:4185 aspect with the slack split
// evenly above and below. That slack is inside the image, so it has to come out
// of the gap or the mark floats too high.
const MARK_SLACK = (MARK_W - MARK_W * (4185 / 4645)) / 2;

// Where each letter sits across the wordmark, normalised — again measured off
// the artwork (origin 3568, width 14030): V 3568..5941, O 7675..9858,
// L 11677..13648, A 15226..17598.
//
// The cuts fall at the *midpoint of each gap* rather than on the glyph edges, so
// the four curtains tile the strip with no seam between them. Cut on the glyph
// edges instead and the gaps are left permanently uncovered — harmless for the
// gaps themselves, which are empty, but it means curtain n+1 starts flush
// against letter n+1 with nothing hiding the join, and any half-pixel of
// rounding shows as a sliver of the next letter arriving early.
const CUTS = [0, 0.230934, 0.513151, 0.774662, 1];

const LETTER_MS = 260;
const STAGGER_MS = 110;
const MARK_MS = 300;
// Long enough for the completed lockup to register as the logo rather than as a
// frame the animation happened to pass through.
const HOLD_MS = 280;
const FADE_MS = 320;

type Props = {
  /**
   * Whether the app behind the splash is ready to be looked at. False while
   * fonts and Clerk are still resolving; the finished lockup holds until it
   * flips, so a slow cold start reads as a held logo rather than as a blank
   * screen the animation dumped the user onto.
   */
  ready: boolean;
  /** Called once the fade-out has finished, so the parent can unmount this. */
  onFinish: () => void;
};

export function AnimatedSplash({ ready, onFinish }: Props) {
  // One value per curtain: 1 is fully covering, 0 fully withdrawn.
  const curtains = useRef(CUTS.slice(1).map(() => new Animated.Value(1))).current;
  // One value for the mark, interpolated three ways below rather than animated
  // three times, so opacity/lift/scale cannot drift out of step.
  const markIn = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;

  const [played, setPlayed] = useState(false);
  // `null` until the OS answers. Rendering the first frame before the answer is
  // fine — the first frame is a bare background either way.
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);

  // Held in a ref so a parent that passes an inline arrow doesn't restart the
  // fade-out on every one of its renders.
  const finish = useRef(onFinish);
  useEffect(() => {
    finish.current = onFinish;
  }, [onFinish]);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (alive) setReduceMotion(enabled);
      })
      // An OS that won't answer shouldn't cost the user the splash entirely.
      .catch(() => {
        if (alive) setReduceMotion(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (reduceMotion === null) return;

    // Reduce Motion is a request not to be moved, not a request to see nothing:
    // the lockup is still shown and still fades, it just doesn't assemble.
    if (reduceMotion) {
      curtains.forEach((curtain) => curtain.setValue(0));
      markIn.setValue(1);
      setPlayed(true);
      return;
    }

    const anim = Animated.sequence([
      Animated.stagger(
        STAGGER_MS,
        curtains.map((curtain) =>
          Animated.timing(curtain, {
            toValue: 0,
            duration: LETTER_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ),
      ),
      Animated.timing(markIn, {
        toValue: 1,
        duration: MARK_MS,
        // Overshoots 1 on the way in, which is what gives the mark its landing.
        easing: Easing.out(Easing.back(1.6)),
        useNativeDriver: true,
      }),
    ]);

    anim.start(({ finished }) => {
      if (finished) setPlayed(true);
    });
    return () => anim.stop();
  }, [reduceMotion, curtains, markIn]);

  useEffect(() => {
    if (!played || !ready) return;

    const anim = Animated.timing(fade, {
      toValue: 0,
      duration: FADE_MS,
      delay: HOLD_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished) finish.current();
    });
    return () => anim.stop();
  }, [played, ready, fade]);

  // Clamped, because `Easing.back` takes markIn past 1 and an opacity above 1
  // is not a thing. The other two are deliberately left to extrapolate — the
  // overshoot is the point.
  const markOpacity = markIn.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const markScale = markIn.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });
  const markLift = markIn.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}
      // Nothing underneath should take a tap while this is still on screen,
      // least of all during the fade when the app is visible but not yet
      // meaningfully interactive.
      pointerEvents="auto"
      // One label for the whole thing; the two images below opt out
      // individually so a screen reader reads "VOLA" rather than the lockup's
      // parts.
      accessible
      accessibilityRole="image"
      accessibilityLabel="VOLA"
    >
      <View style={styles.lockup}>
        <Animated.View
          style={[
            styles.markWrap,
            {
              opacity: markOpacity,
              transform: [{ translateX: MARK_DX }, { translateY: markLift }, { scale: markScale }],
            },
          ]}
        >
          <Image
            source={require('@/assets/images/vola-mark.png')}
            style={styles.mark}
            contentFit="contain"
            alt=""
            accessible={false}
          />
        </Animated.View>

        <View style={styles.wordmark}>
          <Image
            source={require('@/assets/images/vola-wordmark.png')}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            alt=""
            accessible={false}
          />
          {curtains.map((curtain, i) => (
            <Animated.View
              key={CUTS[i]}
              style={[
                styles.curtain,
                {
                  left: CUTS[i] * WORDMARK_W,
                  width: (CUTS[i + 1] - CUTS[i]) * WORDMARK_W,
                  transform: [{ scaleX: curtain }],
                },
              ]}
            />
          ))}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: vola.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockup: { alignItems: 'center' },
  // The margin sits on the wrapper rather than the image so the scale below
  // pivots on the mark's own centre instead of the centre of mark-plus-gap.
  markWrap: { marginBottom: MARK_GAP - MARK_SLACK },
  mark: { width: MARK_W, height: MARK_W },
  wordmark: { width: WORDMARK_W, height: WORDMARK_H },
  curtain: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: vola.bg,
    // Shrink onto the right edge, so the letter is uncovered left-to-right —
    // the direction it would have been written in.
    transformOrigin: ['100%', '50%', 0],
  },
});
