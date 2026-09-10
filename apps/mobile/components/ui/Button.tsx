import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { cubicBezier, type CSSStyle } from 'react-native-reanimated';

import { Text } from '@/components/Themed';
import { Icon, type IconName } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { PRESS_BEZIER, PRESS_MS, PRESS_RETENTION, PRESS_SCALE } from '@/constants/Motion';
import { useAccent } from '@/lib/AccentProvider';
import { withAlpha } from '@/lib/palette';

/**
 * The one filled/secondary/ghost control — Today's "New log", Workouts'
 * "New workout", Food's "Log" and everything shaped like them, in one place.
 *
 * N444 (#741): user's own words, from device screenshots — "Buttons like
 * New Log one has glow another doesnt - they both should be more modern
 * and a bit transparent... if you need to change a style of all buttons we
 * do it in one place." Before this, "New log" and "New workout" were two
 * independently hand-declared `StyleSheet` blocks that happened to agree on
 * radius/padding and disagreed on one shadow property nobody had turned
 * into a rule — see `lib/palette.ts`'s retired `accentGlow` for the fix.
 *
 * ## No glow. Confirmed, not assumed.
 *
 * Asked directly whether "modern and a bit transparent" meant reopening
 * N108's no-haze ruling with a glow, or keeping glow off and fixing the
 * ONE remaining inconsistency (Workouts' FAB) instead — the answer was the
 * latter. So `primary`'s "modern" quality is the semi-transparent fill
 * below, never a `shadow*`/`elevation` property. If a future screen wants a
 * shadow back, that is a new decision to raise with the user, not a
 * parameter to add here.
 *
 * ## The transparency, and why it is safe
 *
 * `primary`'s fill is the athlete's own accent at 92% opacity
 * (`withAlpha`, `lib/palette.ts`) — not a new colour, the same accent every
 * other filled control already uses, just not fully solid. The label
 * composites against the BLEND of the accent and whatever is behind the
 * button, not against the solid accent — so contrast does move a little,
 * not zero. Measured (`frontend-reviewer`, N444's own review) against
 * `vola.bg`, the darkest ground in the app and the worst case: every accent
 * stays AA for this label's size/weight at 0.92, `blue` the closest at
 * ~4.5:1 (from ~5.15:1 solid). The reason 8% see-through is safe is that
 * **every surface in this app is darker than every accent** — the ground
 * showing through can only pull a light fill toward dark, which is the
 * direction that helps a dark-on-light or light-on-dark label's contrast,
 * never hurts it past the floor. If a future change lowers the opacity
 * further than 0.92, re-check `blue` first — it is the accent with the
 * least headroom.
 *
 * ## Radius is always `999`
 *
 * Every current primary action this replaces (`New log`, `New workout`)
 * already used a full capsule; `secondary`/`ghost` match it so switching
 * variants never also changes shape.
 *
 * ## Migration is NOT this ticket
 *
 * This component exists and is tested; it does not yet replace anything.
 * `food/add.tsx`/`FoodQuantity.tsx`'s hardcoded-`vola.accent` "Log" buttons,
 * `MomentumCard.tsx`'s "Log food", and the FAB call sites are each their own
 * follow-up ticket, on purpose — see N444's acceptance criteria for why a
 * fifteen-file migration is a sequence, not this one PR.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  fullWidth,
  floating,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  /** Stretches to fill its container — `MomentumCard`'s "Log food" shape. */
  fullWidth?: boolean;
  /**
   * Positions this as the app's one floating primary action — bottom-right,
   * matching Today's "New log" and Workouts' "New workout" placement
   * exactly (`right: 16, bottom: 16`), so a screen adopting this for its own
   * FAB cannot end up at a different height than the other two.
   */
  floating?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}) {
  const accent = useAccent();

  // `on` is the ink `accents` already defines for text drawn on a SOLID
  // fill (constants/Colors.ts) — reused as-is for the semi-transparent one,
  // because the alpha blend changes what shows through the fill, not what
  // the fill itself is made of; the label still sits on that colour.
  const primaryLabelColor = accent.on;

  const fillStyle =
    variant === 'primary'
      ? { backgroundColor: withAlpha(accent.accent, 0.92) }
      : variant === 'secondary'
        ? { backgroundColor: vola.surfaceRaised, borderWidth: 1, borderColor: vola.line }
        : null; // ghost: no fill at all

  const labelColor =
    variant === 'primary' ? primaryLabelColor : variant === 'secondary' ? vola.text : accent.ink;

  /*
    F38/#1037 — a press that answers the finger.

    `useState` rather than a shared value, deliberately: this fires twice per
    press, not per frame, so a worklet would be the mobile equivalent of
    installing a motion library for a fade. A two-state change with no gesture
    is a CSS TRANSITION — Reanimated 4.5.1 is already here, so this adds no
    dependency.

    **0ms in, 120ms out**, which is the whole reason press feedback is allowed
    on a control tapped forty times a session. The shrink is a press STATE,
    not an animation: it must already be there when the athlete looks. Only
    the release is worth easing, because nothing is waiting on it.

    `scale` and not `opacity` because scale takes the label and the icon with
    it, which is what makes a control read as a physical thing rather than a
    rectangle that dimmed.
  */
  const [pressed, setPressed] = useState(false);

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={disabled}
      style={[
        styles.base,
        pressTransition,
        fullWidth && styles.fullWidth,
        floating && styles.floating,
        fillStyle,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      // Matches the two FABs' own `hitSlop` — the target this replaces
      // first, and the one most often tapped one-handed.
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      // Baked in here rather than left to each call site: zero controls in
      // this app set it before F38, and "remember it per button" is a rule
      // every screen re-forgets independently. A thumb drifting between sets
      // no longer cancels a press the athlete meant.
      pressRetentionOffset={PRESS_RETENTION}
      testID={testID}
    >
      {icon && <Icon name={icon} size={16} color={labelColor} />}
      <Text numberOfLines={1} style={[styles.label, { color: labelColor }]}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/*
  Declared outside `StyleSheet.create`, and that is not a style preference:
  React Native's own `NamedStyles` has no `transitionProperty`, so putting
  this in the sheet is a type error. These are Reanimated's CSS transition
  properties and `CSSStyle` is where they are typed.

  The transition sits on the RESTING style, not the pressed one — that is what
  makes the press instant and only the release eased. Declared on `pressed` it
  would animate the way IN as well, which is the half nobody should wait for.

  `transitionProperty: 'transform'` and nothing else: transform and opacity are
  the two free properties, and anything else here re-runs layout on every frame
  of every press.
*/
const pressTransition: CSSStyle = {
  transform: [{ scale: 1 }],
  transitionProperty: 'transform',
  transitionDuration: `${PRESS_MS}ms`,
  transitionTimingFunction: cubicBezier(...PRESS_BEZIER),
};

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignSelf: 'flex-start',
  },
  fullWidth: { alignSelf: 'stretch' },
  floating: { position: 'absolute', right: 16, bottom: 16 },
  disabled: { opacity: 0.4 },
  pressed: { transform: [{ scale: PRESS_SCALE }] },
  label: { fontWeight: '700', fontSize: 15 },
});
