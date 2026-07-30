import { StyleSheet, View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
          <Text style={styles.wordmarkText} accessibilityLabel="VOLA" accessibilityRole="header">
            VOL
          </Text>
          <Chevron />
        </RNView>
        {action}
      </View>
    </View>
  );
}

/**
 * The A, as a bare chevron — no crossbar.
 *
 * Drawn from two rotated rules rather than set as a glyph: the Greek lambda
 * renders at a different weight and width to the rest of the wordmark in
 * most faces, so "VOLΛ" comes out visibly mismatched. Two strokes match the
 * text's weight exactly because that weight is a number we choose.
 */
function Chevron() {
  return (
    <RNView style={styles.chevron} accessible={false}>
      <RNView style={[styles.stroke, styles.strokeLeft]} />
      <RNView style={[styles.stroke, styles.strokeRight]} />
    </RNView>
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
  // Width is derived, not guessed. Each stroke rotates about its own centre,
  // so a 12pt leg at 22° carries its top end 12/2 * sin(22°) ≈ 2.25pt inward
  // from a centre inset 2pt from the edge. The two apexes meet when the box
  // is 2 * (2 + 2.25) = 8.5pt wide; 9 gives them a hair of overlap so the
  // join reads as solid rather than as two strokes that nearly touch.
  chevron: { width: 9, height: 12, marginLeft: 2, marginBottom: 1 },
  stroke: {
    position: 'absolute',
    width: 2,
    height: 12,
    borderRadius: 1,
    backgroundColor: vola.text,
    top: 0,
  },
  strokeLeft: { left: 1, transform: [{ rotate: '22deg' }] },
  strokeRight: { right: 1, transform: [{ rotate: '-22deg' }] },
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
