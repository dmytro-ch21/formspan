import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { StyleSheet, View as RNView, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SyncChip } from '@/components/SyncChip';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';

/**
 * The top of every tab screen: the wordmark, then the screen's name.
 *
 * **The wordmark is the drawn artwork, not typed letters.** This used to be
 * the brand tick followed by "VOLA" set in the system font at weight 800 with
 * 3pt of tracking — an impersonation of the logo built from the only parts a
 * text node can offer. The real letterforms are a different shape entirely
 * (the A is an apex with no crossbar, the O is a rounded rectangle), so the
 * typed version was not a smaller version of the logo, it was a different
 * logo. It is now `vola-wordmark.png`, lifted from the stacked lockup — which
 * also means the header no longer needs the tick beside it to say what the
 * letters are. The tick still appears where it earns its place: the app icon,
 * and the landing beat of `AnimatedSplash`. It just isn't furniture on every
 * screen any more.
 *
 * Replaces React Navigation's default header, which drew its own surface
 * colour and a hairline rule — two bands of subtly different dark, stacked
 * against a third at the bottom. On a dark theme those seams are the most
 * visible thing on screen, and they were dividing a layout that has no
 * actual sections. Everything now sits on one continuous ground.
 *
 * The wordmark shares a row with the screen name rather than sitting above
 * it at island level. The first attempt put it level with the island and the
 * island simply covered it — it is opaque hardware, not a layer an app can
 * draw into. (Drawing *in* the island proper means a Live Activity via
 * ActivityKit: native code and a custom dev client, neither of which exists
 * here.) One row is also less furniture than two, which is the point.
 *
 * The screen name is small and left-aligned because it's orientation, not a
 * headline — you already know where you are, you just want confirming.
 *
 * It also carries the sync chip, which is why sync state reaches every tab
 * without each screen having to opt in — and why a screen added later gets it
 * for free rather than being the one place that quietly doesn't report.
 *
 * ## The wordmark yields rather than being overlapped
 *
 * This header publishes an `action` slot **with no width contract** while
 * drawing an 88pt image across the middle of the same row, and for a while
 * that was simply a collision waiting for a caller. It got two:
 *
 *   - `you.tsx` passes three text controls (~173pt at 14pt/700). On a 393pt
 *     device the row is 353pt and the wordmark spans ~132.5→220.5 while the
 *     cluster starts at ~180; on a 375pt device "Friends" lands on the
 *     wordmark's tail. `pointerEvents="none"` means taps still worked, so it
 *     read as a smudge rather than a broken control.
 *   - `justifyContent: 'space-between'` with a VARIABLE number of flow
 *     children. Two children (the other three tabs) puts the chip hard right;
 *     three children put it in the row's INTERIOR — the wordmark's band. The
 *     chip is silent when idle, so this half came and went with sync state,
 *     which is why the bug looked intermittent and nobody traced it to layout.
 *
 * The notifications PR then widened the cluster again (`Friends (3)`) without
 * anyone re-checking the geometry, and did it ASYNCHRONOUSLY — the count
 * arrives after paint. That is the proof the contract cannot be kept by
 * callers, so it is kept here.
 *
 * **Two flow children, always.** The chip and the action are one group, so
 * `space-between` can only ever put something at the two ends. This is also
 * what makes the arithmetic below true: only with two children does
 * `space-between` guarantee `rightStart === row − right`.
 *
 * **The wordmark hides when measurement says it cannot fit**, rather than
 * shrinking or being truncated. It keeps its absolute centring, which is the
 * guarantee the original comment was written for — the title's width must not
 * push it off-centre. A flow slot would give that up, and RN's `flexShrink`
 * defaults to 0, so an over-full row would not shrink the image; it would
 * wrap the labels. "Setti/ngs" on two lines is worse than the overlap.
 *
 * **Absolute positioning is what makes hiding safe.** Out of flow, mounting
 * and unmounting the wordmark changes no measured frame, so hiding it cannot
 * re-fire `onLayout` and cannot oscillate. A future refactor to a flow slot
 * would break that silently.
 *
 * **It MEASURES rather than computing, and that is deliberate.** See
 * `fabClearance` in `app/(tabs)/workouts.tsx`, which documents the trap:
 * `PixelRatio.getFontScale()` is a `Dimensions` snapshot, a module-scope const
 * freezes it at bundle load, and iOS does not restart the JS bundle when you
 * change text size and come back. A measured width already EMBODIES the font
 * scale — a `Text` at Accessibility Large simply lays out wider and
 * `onLayout` reports it — so there is no factor here to go stale. The obvious
 * future edit (`if (fontScale > 1.3) hide`) would inherit that trap and
 * re-encode today's labels; do not.
 */

/** The artwork's width, and the clearance it needs on each side. */
const WORDMARK_WIDTH = 88;
const WORDMARK_MIN_GAP = 12;

/**
 * Whether the centred wordmark clears the content on both sides.
 *
 * Pure, and separated from the component because it is the only part of this
 * layout a test can reach: jest runs no Yoga pass, so `onLayout` never fires
 * and a real text measurement is unobtainable. The predicate can still be
 * pinned exactly.
 *
 * BOTH clauses matter. A right-only check passes the case that actually
 * shipped, and would then miss a long title — which is the direction a
 * localised build fails in.
 */
export function wordmarkFits(
  { row, left, right }: { row: number; left: number; right: number },
  wordmark = WORDMARK_WIDTH,
  minGap = WORDMARK_MIN_GAP,
): boolean {
  const centre = row / 2;
  const half = wordmark / 2;
  return left + minGap <= centre - half && centre + half <= row - right - minGap;
}

/**
 * A width from `onLayout`, ignoring the passes that did not change it.
 *
 * Without the equality check every layout pass sets state and re-renders,
 * which on a screen that lays out often is a needless render per pass.
 */
function useMeasuredWidth(): [number | null, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState<number | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width;
    setWidth((prev) => (prev === next ? prev : next));
  }, []);
  return [width, onLayout];
}

export function ScreenHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const accent = useAccent();

  const [rowWidth, onRowLayout] = useMeasuredWidth();
  const [leftWidth, onLeftLayout] = useMeasuredWidth();
  const [rightWidth, onRightLayout] = useMeasuredWidth();

  // OPTIMISTIC until all three are known, so the three tabs that have always
  // fitted never blink the wordmark out and back on mount. The pre-measurement
  // state is exactly the old behaviour, so nothing regresses on the screens
  // that were never wrong.
  const measured = rowWidth !== null && leftWidth !== null && rightWidth !== null;
  const showWordmark =
    !measured || wordmarkFits({ row: rowWidth, left: leftWidth, right: rightWidth });

  return (
    // The row is the positioning context for the centred wordmark, so the
    // title's own width can't push it off-centre.
    <View style={[styles.wrap, { paddingTop: insets.top + 14 }]}>
      <View style={styles.row} onLayout={onRowLayout} testID="screen-header-row">
        <RNView style={styles.titleWrap} onLayout={onLeftLayout}>
          <Text style={styles.title}>{title}</Text>
          {/* A dot, not a word. It marks the current screen in the accent the
              athlete chose, which is the same job the tab bar's underline does
              one row down — the pair is what makes "where am I" answerable from
              either end of the screen. Hidden from assistive tech: it repeats
              the title it sits beside. */}
          <RNView
            style={[styles.dot, { backgroundColor: accent.accent }]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </RNView>
        {/* CONDITIONAL RENDER, not `opacity: 0`. The node below carries
            `accessibilityRole="header"` and the label "VOLA", so hiding it by
            opacity would leave a screen reader announcing a brand name that is
            not on screen. */}
        {showWordmark && (
          <RNView style={styles.wordmark} pointerEvents="none">
            {/* `accessible` sits on this inner view, not on the absolutely
                positioned wrapper. The wrapper is `left: 0, right: 0` so that the
                wordmark centres on the row rather than on whatever space the
                title leaves — but that makes it as wide as the header, and an
                accessibility element is the size of its frame. Put the label out
                there and touch-exploring anywhere across the middle band of the
                row reads "VOLA" instead of the screen name it is sitting on top
                of. Here the element is the 88pt artwork and nothing else. */}
            <RNView accessible accessibilityRole="header" accessibilityLabel="VOLA">
              <Image
                source={require('@/assets/images/vola-wordmark.png')}
                style={styles.wordmarkImage}
                contentFit="contain"
                // The view above carries the label; announcing the image too
                // would read the brand name twice.
                alt=""
                accessible={false}
              />
            </RNView>
          </RNView>
        )}
        {/* ONE flow child for both, which is the fix rather than tidiness: as
            separate children they made three, and `space-between` then places
            the middle one — the chip — inside the wordmark's band. The chip
            still comes first, so a screen's own control stays in the corner it
            has always been in. */}
        <RNView style={styles.rightCluster} onLayout={onRightLayout} testID="screen-header-actions">
          <SyncChip />
          {action}
        </RNView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingBottom: 10 },
  wordmark: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 88 is where the wordmark carries the same weight as the screen title
  // opposite it without starting to compete. The height is derived from the
  // source SVG's 14030:1759 rather than typed, so the box is the artwork's
  // shape and `contain` has almost nothing to letterbox — the PNG's own
  // 2048:257 differs by a rounded-up pixel, which costs 0.08pt of slack, a
  // quarter of a device pixel at 3x. The viewBox ratio rather than the
  // raster's because `AnimatedSplash` derives the whole lockup from the same
  // numbers, and two files disagreeing by a rounding is worse than either.
  wordmarkImage: { width: 88, height: 88 * (1759 / 14030) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 28,
  },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  // The chip and the screen's own control, as one flow child. 12pt is `row`'s
  // own gap, carried over — though as siblings under `space-between` they
  // actually got MORE than that, since the surplus was split around the chip.
  // That surplus was the fault, not a baseline worth preserving: it is what
  // put the chip in the middle of the row. The free space now sits entirely
  // between the title and this group.
  rightCluster: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: vola.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
});

/**
 * Bottom breathing room for a scrolling screen.
 *
 * Small now: the tab bar sits in normal flow rather than floating over the
 * content, so this is margin rather than the clearance it used to be.
 */
export const TAB_BAR_CLEARANCE = 28;
