import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon, type IconName } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { withAlpha } from '@/lib/palette';
import { PRESS_OPACITY } from '@/constants/Motion';
import { slopFor } from '@/constants/Spacing';

/**
 * The one rounded-label shape — a chip you can select, or a badge you can't.
 *
 * N444 (#741): the user's own device screenshots showed the date pill on
 * Today, the date pill on Food, the water/coffee cup toggles, the "Public"
 * badge and at least fifteen independently-declared filter-chip
 * `StyleSheet` blocks all drawing the same idea — a labelled, rounded token
 * — with different radii (999, 12, 10, 6 all seen), different padding, and
 * no shared component behind any of them. "If we want to change a style of
 * all buttons we do it in one place" was the explicit brief; this is that
 * place for anything pill-shaped.
 *
 * **Radius is always `999` — never a prop.** Confirmed directly: one radius
 * for every pill/chip/badge in the app, not a tiered scale. A caller that
 * wants a different shape wants a different component, not a parameter that
 * reopens the inconsistency this one exists to end.
 *
 * ## Chip vs badge is `onPress`, not a variant flag
 *
 * Passing `onPress` makes this a `Pressable` chip — `accessibilityRole:
 * "button"`, an `active` state that tints toward the athlete's chosen
 * accent, a pressed-state dim. Omitting it makes this a plain `View` badge —
 * static, no press feedback, no button semantics to announce. One prop
 * decides the whole shape, so a badge can never accidentally end up with
 * button semantics nobody wired a handler for, and a chip can never render
 * inert by forgetting a prop — the two are exhaustive over `onPress`, not
 * over a separately-settable `variant`.
 *
 * ## Accent, not a hardcoded fill
 *
 * `active` tints via `useAccent()`, so a chip selected in the app follows
 * whichever of the six accents the athlete chose — the same seam N444's
 * audit found broken on `food/add.tsx`'s "Log" button (hardcoded
 * `vola.accent`, ignoring the athlete's own choice). `withAlpha` derives the
 * tint from the SAME accent hex the fill uses, per the token-derivation
 * rule — never a second, arbitrary colour for "selected".
 */
export type PillProps = {
  label: string;
  /** Present → an interactive, selectable chip. Absent → a static badge. */
  onPress?: () => void;
  /** Only meaningful with `onPress` — a badge has no selected state. */
  active?: boolean;
  icon?: IconName;
  /**
   * Screen-reader name, when `label` alone would not say enough — e.g. a
   * badge that is genuinely just "Public" is fine read literally, but a
   * count badge like "3" needs "3 friends waiting".
   */
  accessibilityLabel?: string;
  testID?: string;
};

export function Pill({ label, onPress, active, icon, accessibilityLabel, testID }: PillProps) {
  const accent = useAccent();

  if (!onPress) {
    // The badge path: no button semantics, no press feedback — a label,
    // not a control. `accessibilityLabel` still applies (a raw "3" is not a
    // sentence a screen reader should have to guess the subject of).
    return (
      <RNView
        style={styles.base}
        accessible={!!accessibilityLabel}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        {icon && <Icon name={icon} size={12} color={vola.textMuted} />}
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </RNView>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      hitSlop={slopFor(CHIP_HEIGHT)}
      style={({ pressed }) => [
        styles.base,
        styles.chip,
        active && { backgroundColor: withAlpha(accent.accent, 0.22), borderColor: accent.accent },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
    >
      {icon && (
        <Icon name={icon} size={12} color={active ? accent.ink : vola.textMuted} />
      )}
      <Text style={[styles.label, active && { color: accent.ink, fontWeight: '700' }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The chip's vertical padding. The style below uses this, not a literal. */
export const CHIP_PADDING_V = 6;

/** The 12pt label's line box, rounded. The one figure here that is an estimate. */
export const CHIP_LABEL_LINE = 15;

/**
 * The chip's painted height — 27pt, which asks {@link slopFor} for 9 and
 * gives 27 + 18 = 45pt against the 44pt floor. Before F42 this was
 * `hitSlop={6}`, an effective 39pt.
 *
 * **Composed from the two constants above rather than restated, and the
 * stylesheet consumes the same ones**, so the height cannot drift from the
 * padding it is derived from — an earlier draft wrote `6 + 15 + 6` here
 * beside a separate `paddingVertical: 6` literal, which is three places to
 * change in lockstep and exactly the drift this ticket exists to end.
 * `CHIP_LABEL_LINE` is still an estimate; React Native gives no cheap way to
 * measure a text line box without an `onLayout` round trip, and `hitSlop` is
 * a static prop that needs a number before layout happens.
 *
 * **If this is ever dropped into a ROW of chips, the row needs a `gap` of at
 * least 18pt** — `slopFor(27)` is 9, applied to all four edges, so two
 * adjacent chips any closer have overlapping touch rectangles and a tap
 * resolves to whichever is on top rather than the one under the thumb. See
 * {@link slopFor}'s own note. Not a live concern yet: as of F42 this
 * component has no call sites at all (N444 built it as foundation and
 * deliberately did not migrate the ~15 ad-hoc pills), so the first person to
 * adopt it is the first person this matters to.
 */
export const CHIP_HEIGHT = CHIP_PADDING_V * 2 + CHIP_LABEL_LINE;

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingVertical: CHIP_PADDING_V,
    paddingHorizontal: 12,
    backgroundColor: vola.surfaceRaised,
  },
  // A hairline border only on the interactive (chip) path — a badge sitting
  // on a card already has the card's own edge; a second outline around a
  // static label reads as a control that isn't one.
  chip: { borderWidth: 1, borderColor: 'transparent' },
  pressed: { opacity: PRESS_OPACITY },
  label: { fontSize: 12, color: vola.textMuted },
});
