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
 */
import { Modal, Pressable, StyleSheet, View as RNView } from 'react-native';

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
        <Pressable
          onPress={onClose}
          style={[styles.done, { backgroundColor: accent.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Done editing the amount"
          testID="amount-sheet-done"
        >
          <Text style={[styles.doneText, { color: accent.on }]}>Done</Text>
        </Pressable>
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
  done: {
    marginHorizontal: 20,
    marginBottom: 24,
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { fontWeight: '700', fontSize: 15 },
});
