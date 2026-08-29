import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon, type IconName } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
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
 * other filled control already uses, just not fully solid. This is safe for
 * the LABEL specifically because alpha blending only affects what the fill
 * composites against (the card or screen behind the button); the label text
 * is drawn on top of the already-composited fill, so its contrast against
 * that fill is unchanged by the button's own transparency — only how much
 * of the ground behind the button shows through changes.
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

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
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
      testID={testID}
    >
      {icon && <Icon name={icon} size={16} color={labelColor} />}
      <Text numberOfLines={1} style={[styles.label, { color: labelColor }]}>
        {label}
      </Text>
    </Pressable>
  );
}

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
  pressed: { opacity: 0.85 },
  label: { fontWeight: '700', fontSize: 15 },
});
