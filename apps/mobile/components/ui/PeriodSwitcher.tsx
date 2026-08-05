import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon, type IconName } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';

/**
 * The control for "which period am I looking at" — one shape, everywhere.
 *
 * A chevron, a label, a chevron. The chevrons step; the label, when it is
 * pressable, opens the calendar that jumps somewhere distant. Both arrows do
 * the same *kind* of thing in opposite directions, which is what makes the row
 * readable without reading it.
 *
 * **That symmetry is the point, and it is what the Plan header got wrong.**
 * Its first cut was `‹ AUGUST › ›` — the title's disclosure chevron immediately
 * followed by the next-week arrow, two identical glyphs side by side with
 * entirely different jobs. The fix at the time was to separate them: title on
 * the left, a stepper pair on the right. That works and it is asymmetric, and
 * it stops being obvious that the two arrows are a pair.
 *
 * Putting the label *between* the arrows solves the original collision a
 * different way: there is exactly one left-chevron and one right-chevron, they
 * are steppers, and the disclosure is carried by an icon inside the label
 * rather than by a third chevron. Nothing looks like anything else.
 *
 * **Anything that changes which period a screen is showing should use this.**
 * The week on Plan, the month behind it, the day on Today. A screen that
 * invents its own stepper is a screen where the arrows mean something slightly
 * different, and there is no reason for that to be true.
 *
 * **"You have navigated away" is carried by the label, and deliberately by
 * nothing else.** The first cut added a border to the pill for it, which
 * measures 1.38:1 against the screen — a state indicator nobody can see, and
 * the same mistake as the tab thumb that was 1.09:1 from its own track. The
 * label is already the signal: it reads THIS WEEK on the current one and the
 * date range otherwise. That is text, so it is 15.41:1, it survives greyscale,
 * and a screen reader gets it for free. A second channel for the same fact is
 * not worth a colour that fails.
 *
 * The pill's own fill is 1.18:1 and that is fine — it is decoration. What
 * identifies the control is the label and its icon (15.41:1 and 6.26:1), which
 * is what WCAG 1.4.11 actually asks for.
 *
 * **The chevrons depend on what this sits on, and one surface fails.** `textDim`
 * measures 3.96:1 on `bg` and 3.67:1 on `surface` — clear of the 3:1 a
 * meaningful graphic needs — but 3.36:1 on `surfaceRaised` (still passing) and
 * **2.51:1 on a completed set row, which does not**. Anywhere this is adopted
 * onto a raised or tinted surface, re-measure rather than assume.
 *
 * (Every figure above was recomputed after review found the first set 2–3%
 * low across the board. None of them changed a conclusion, but a repo that has
 * deleted a card fill over a single measurement does not get to round.)
 */
export function PeriodSwitcher({
  label,
  onPrev,
  onNext,
  onPress,
  icon,
  prevLabel,
  nextLabel,
  pressLabel,
  testID,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  /** Omit to make the label plain text — a readout rather than a control. */
  onPress?: () => void;
  icon?: IconName;
  prevLabel: string;
  nextLabel: string;
  pressLabel?: string;
  testID?: string;
}) {
  return (
    <RNView style={styles.row} testID={testID}>
      <Pressable
        onPress={onPrev}
        // Generous, because these are 14pt glyphs either side of the one thing
        // on the row anyone aims at.
        hitSlop={16}
        style={({ pressed }) => [styles.step, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={prevLabel}
        testID={testID ? `${testID}-prev` : undefined}
      >
        {/* The icon set has one chevron and it points right; the left arrow is
            that glyph flipped, so the two are guaranteed to be mirror images
            rather than two drawings that nearly match. */}
        <RNView style={styles.flip}>
          <Icon name="chevron" size={14} color={vola.textDim} />
        </RNView>
      </Pressable>

      <Pressable
        onPress={onPress}
        // NOT `disabled` in the readout case. React Native folds that prop into
        // `accessibilityState`, so a month name with nothing to press would be
        // announced "AUGUST 2026, dimmed" — a `Pressable` with no handler is
        // already inert without saying so.
        hitSlop={10}
        style={({ pressed }) => [styles.pill, pressed && onPress && styles.pressed]}
        accessibilityRole={onPress ? 'button' : 'text'}
        // The visible text LEADS the accessible name — WCAG 2.5.3. Naming it
        // only by the sentence version ("August, week of 11 August. Open the
        // month…") means "tap THIS WEEK" does nothing under Voice Control, and
        // on Plan this pill is the only route to the month grid.
        accessibilityLabel={onPress && pressLabel ? `${label}. ${pressLabel}` : label}
        testID={testID ? `${testID}-label` : undefined}
      >
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        {icon && <Icon name={icon} size={13} color={vola.textMuted} />}
      </Pressable>

      <Pressable
        onPress={onNext}
        hitSlop={16}
        style={({ pressed }) => [styles.step, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={nextLabel}
        testID={testID ? `${testID}-next` : undefined}
      >
        <Icon name="chevron" size={14} color={vola.textDim} />
      </Pressable>
    </RNView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  step: { paddingVertical: 6, paddingHorizontal: 8 },
  // Rotating the one chevron rather than shipping a second asset — see above.
  flip: { transform: [{ rotate: '180deg' }] },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: vola.surfaceRaised,
    // Room for a long label without the arrows sliding about as it changes
    // between "THIS WEEK" and "AUG 11 – 17".
    minWidth: 148,
    justifyContent: 'center',
  },
  label: {
    color: vola.text,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  pressed: { opacity: 0.55 },
});
