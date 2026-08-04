import { Image } from 'expo-image';
import { StyleSheet, View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SyncChip } from '@/components/SyncChip';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';

/**
 * The top of every tab screen: the wordmark, then the screen's name.
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
          <Mark />
          <Text style={styles.wordmarkText} accessibilityLabel="VOLA" accessibilityRole="header">
            VOLA
          </Text>
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

/**
 * The brand tick, from the designed logo kit.
 *
 * **This replaced a drawn substitute, and the substitute was the odd one
 * out.** The header used to set "VOL" and then draw its own chevron from two
 * rotated rules to stand in for the A — a workaround from before a real mark
 * existed, with arithmetic in this file to make the two strokes mitre. The
 * actual logo is a faceted tick in three greens (`#D0E950`, `#9CC740`,
 * `#71912F`) sitting *before* the wordmark, not inside it, so the wordmark is
 * now simply "VOLA".
 *
 * A PNG rather than the SVG it was drawn as: this app has no
 * `react-native-svg` (see `Belt.tsx` and `ui/Icon.tsx` for why), and unlike
 * those two the mark is genuinely un-drawable from views — it is overlapping
 * filled polygons, not rules and circles. Exported from
 * `assets/brand/logos/source/vola-mark-color.png`, trimmed to its content box
 * and squared, so it is regenerable rather than hand-cropped.
 */
function Mark() {
  return (
    <Image
      source={require('@/assets/images/vola-mark.png')}
      style={styles.mark}
      contentFit="contain"
      // Decorative: the wordmark beside it already carries the header label.
      alt=""
      accessible={false}
    />
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
  wordmarkText: {
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 3,
    color: vola.text,
  },
  // Wider than tall: the source mark is 550×496, and `contain` letterboxes
  // inside whatever box it is given, so a square one would leave the tick
  // floating in dead space to either side.
  mark: { width: 20, height: 18, marginRight: 7 },
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
