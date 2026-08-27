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
 */
import { Modal, Pressable, StyleSheet, View as RNView } from 'react-native';

import { KeyboardAwareFooter } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';

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
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="amount-sheet-close"
          >
            <Icon name="close" size={20} color={accent.ink} />
          </Pressable>
        </RNView>
        <View style={styles.body}>{children}</View>
        {/* Same shape as `add.tsx`'s `pickingFooter` — padding on the footer
            itself, a hairline separating it from the content above. */}
        <KeyboardAwareFooter style={styles.footer}>
          <Pressable
            onPress={onClose}
            style={[styles.done, { backgroundColor: accent.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Done editing the amount"
            testID="amount-sheet-done"
          >
            <Text style={[styles.doneText, { color: accent.on }]}>Done</Text>
          </Pressable>
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
