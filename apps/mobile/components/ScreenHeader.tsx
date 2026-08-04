import { Image } from 'expo-image';
import { StyleSheet, View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SyncChip } from '@/components/SyncChip';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';

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
 */
export function ScreenHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    // The row is the positioning context for the centred wordmark, so the
    // title's own width can't push it off-centre.
    <View style={[styles.wrap, { paddingTop: insets.top + 14 }]}>
      <View style={styles.row}>
        <Text style={styles.title}>{title}</Text>
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
        {/* Before `action`, so a screen's own control stays in the corner it
            has always been in. The chip is silent unless there is something
            to say, so most of the time this row is unchanged. */}
        <SyncChip />
        {action}
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
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: vola.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});

/**
 * Bottom breathing room for a scrolling screen.
 *
 * Small now: the tab bar sits in normal flow rather than floating over the
 * content, so this is margin rather than the clearance it used to be.
 */
export const TAB_BAR_CLEARANCE = 28;
