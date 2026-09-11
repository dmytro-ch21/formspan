/**
 * The amount editor, in a sheet rather than an always-visible field (N426).
 *
 * Reported from a device, against a reference screenshot of a competitor
 * app: the scan-confirm screen used to bury its one editable number in the
 * middle of a card, with no visual weight — the athlete's own words were
 * "why didn't you do it" against a reference where **Amount** is the
 * headline of the screen and editing it is a deliberate, separate action.
 *
 * A plain `children` container rather than one hardcoded to `FoodQuantity`:
 * the scan screen has TWO amount controls depending on the food (`FoodQuantity`
 * when it has an honest gram basis, `ServingsFallback` — a private control in
 * `scan.tsx` — when it does not, N117), and this sheet is the shared shell
 * for whichever one the caller decides to render, not a second copy of that
 * branch. Nothing here recomputes a macro; it only changes which container
 * the athlete's chosen control renders inside.
 *
 * ## The Done button and the keyboard (found in review, from a device)
 *
 * "Done" is a `KeyboardAwareFooter` (`components/KeyboardAwareScroll.tsx`,
 * already built and used elsewhere in this app for exactly this shape —
 * problem 3 in that file's own doc comment: *"a fixed footer is buried [...]
 * it has to move"*) rather than a raw `KeyboardAvoidingView`. Without it, the
 * keyboard that opens for the amount field covers the one button that closes
 * the sheet — reachable by dismissing the keyboard first, but not obviously,
 * which is exactly the "not noticeable" class of bug this file's other fix
 * (the input's border, in `FoodQuantity.tsx`) is also about. `KeyboardAware-
 * Footer` needs no `KeyboardAwareScreen` ancestor to work standalone — that
 * context only coordinates with a sibling `KeyboardAwareScrollView`, which
 * this sheet does not have (its content is short enough to need no scrolling)
 * — it measures and pads itself regardless.
 *
 * ### …and that was not enough, which is the part worth reading
 *
 * The paragraph above shipped with N426 on 2026-08-28. The athlete reported
 * the covered Done button **on 2026-09-04**, from a device, against a build
 * that already had every word of it (#858 item 7). The component was there
 * and the lift was zero.
 *
 * The footer's lift is `measureInWindow` minus the keyboard event's
 * `screenY`, and those are only the same coordinate space when the footer is
 * in the app's own view tree. This one is inside a `Modal` — and an iOS
 * `pageSheet` is inset from the top of the display, so a measurement taken
 * inside it can describe the sheet instead. Under-measure and the footer
 * lifts by less than the overlap, which is a Done button still under the
 * keypad.
 *
 * `anchoredToScreenBottom` is the answer: for a sheet flush with the bottom
 * of the display the overlap is simply the keyboard's height, with no
 * geometry to get wrong. It takes the larger of that and the measured
 * answer, so it cannot lift less than before. See
 * `keyboardInsetForScreenBottom` for the full account and
 * `__tests__/amountSheetKeyboard.test.tsx` for the reproduction.
 *
 * **The claim the prop makes is true here and must be re-checked if this
 * sheet's presentation changes**: `styles.sheet` is `flex: 1` inside a
 * full-height `Modal`, so its last child's bottom edge really is the bottom
 * of the display. A sheet that gained a safe-area gap under the footer, or
 * stopped being full-height, would be over-lifted by exactly that gap.
 */
import { Modal, StyleSheet, View as RNView } from 'react-native';

import { KeyboardAwareFooter } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { PressableScale } from '@/components/ui/PressableScale';

export function AmountSheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const accent = useAccent();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {/* `vola.bg` explicit, same reason `InfoSheet.tsx` already documents: a
          `Modal` is not on the app's own continuous dark ground — iOS gives a
          `pageSheet` the system's (light) sheet background otherwise. */}
      <View style={styles.sheet}>
        <RNView style={styles.head}>
          <Text style={styles.title}>Amount</Text>
          <PressableScale
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="amount-sheet-close"
          >
            <Icon name="close" size={20} color={accent.ink} />
          </PressableScale>
        </RNView>
        <View style={styles.body}>{children}</View>
        {/* Same shape as `add.tsx`'s `pickingFooter` — padding on the footer
            itself, a hairline separating it from the content above. */}
        <KeyboardAwareFooter
          style={styles.footer}
          anchoredToScreenBottom
          testID="amount-sheet-footer"
        >
          <PressableScale
            onPress={onClose}
            style={[styles.done, { backgroundColor: accent.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Done editing the amount"
            testID="amount-sheet-done"
          >
            <Text style={[styles.doneText, { color: accent.on }]}>Done</Text>
          </PressableScale>
        </KeyboardAwareFooter>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: vola.bg },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  title: { fontSize: 20, fontWeight: '800' },
  body: { flex: 1, paddingHorizontal: 20 },
  footer: {
    padding: 16,
    backgroundColor: vola.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.line,
  },
  done: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { fontWeight: '700', fontSize: 15 },
});
