import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';

/**
 * A section whose header folds it away.
 *
 * ## Why this exists, and why it does NOT default to collapsed
 *
 * The reported bug on Goals is that it *"scrolls on and on"*. #484 measured it
 * and found no layout fault at all — the extent equals the content to the pixel
 * in every state — so the length is the design's, not a bug's: **1,662–2,179pt
 * against a 666pt viewport at default text, and 7,759–9,492pt at accessibility
 * sizes.** Twelve to fifteen screens.
 *
 * The suggested answer was #446's: everything collapsed on arrival, so the
 * screen opens as a shape rather than a wall. This takes the mechanism and not
 * the default, for a measured reason. **The supplied N106 reference is exactly
 * one iPhone viewport** — 853×1844 at the 19.5:9 aspect of the device it is
 * drawn for, status bar to tab bar, everything visible at once. Building it
 * faithfully is therefore *already* the fix at ordinary text sizes; opening it
 * pre-folded would hide an argument the athlete can currently see, on a screen
 * whose entire purpose is being inspectable, to solve a problem the rebuild has
 * already solved.
 *
 * What the reference cannot fix is accessibility sizes, where the same content
 * is unavoidably several screens. So the control ships, it opens expanded, and
 * **the choice persists** — fold the ladder once and it stays folded. A reader
 * who needs large text pays one tap, not one per visit.
 *
 * A size-derived default was considered and rejected: `PixelRatio.getFontScale()`
 * is a `Dimensions` snapshot that a module-scope const freezes at bundle load,
 * and iOS does not restart the JS bundle when text size changes — the trap
 * `workouts.tsx` records in full.
 *
 * ## The header is the control
 *
 * The whole label row toggles, not just the chevron: a 12pt glyph is not a
 * touch target, and an athlete who has understood that the section folds will
 * tap the words. `accessibilityState.expanded` carries the state, and the
 * chevron points down when open and right when closed — the direction of what
 * happens next is ambiguous, the direction of the content is not.
 *
 * `info` renders inside the header but outside the toggle's press, so the ⓘ
 * explains rather than folds.
 */
export function CollapsibleSection({
  label,
  open,
  onToggle,
  info,
  trailing,
  children,
  testID,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  info?: React.ReactNode;
  /** A static badge at the right — the reference's `g per day` pill. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <RNView style={styles.wrap}>
      <RNView style={styles.head}>
        <Pressable
          onPress={onToggle}
          hitSlop={{ top: 8, bottom: 8 }}
          style={styles.toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={label}
          accessibilityHint={open ? 'Folds this section away' : 'Opens this section'}
          testID={testID}
        >
          <Text style={styles.label}>{label.toUpperCase()}</Text>
          <Icon name={open ? 'chevron-down' : 'chevron'} size={12} color={vola.textDim} />
        </Pressable>
        {info}
        <RNView style={styles.trailing}>{trailing}</RNView>
      </RNView>
      {/*
        Unmounted rather than hidden. `display: 'none'` would keep every child
        mounted and measured, so a folded ladder would still cost its layout —
        which is the thing being folded away.
      */}
      {open ? children : null}
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24 },
  // `flexShrink` so a long label at a large text size wraps rather than pushing
  // the badge off the right edge.
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, paddingVertical: 3 },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: vola.textDim,
    flexShrink: 1,
  },
  trailing: { marginLeft: 'auto' },
});
