/**
 * The 3-dot menu behind a food entry row — N531/#962.
 *
 * Exactly three actions, in the user's own order: **Duplicate**, **Remove**,
 * **Share**. Nothing else lives here, and the ticket says so in as many
 * words — "the sheet offers Duplicate / Remove / Share and nothing else".
 * Opening the entry is the row's own tap; changing its meal is the drag (or
 * the entry screen's meal picker); neither belongs in an overflow menu that
 * exists to be short.
 *
 * ## The same sheet as the Library's, not a fourth
 *
 * Structure and tokens follow `app/library.tsx`'s facet and extras sheets
 * (N469): a `transparent` `Modal`, a dimming backdrop that is a SIBLING of the
 * sheet (an accessibility element does not expose its descendants on iOS, so
 * a backdrop wrapping the sheet had VoiceOver reading the whole thing as one
 * "Close" button — that file records the bug), a glass sheet anchored to the
 * bottom with a grabber, a head row with the title and Done, and rows at 46pt.
 * `accessibilityViewIsModal` + `onAccessibilityEscape` are what make focus
 * containment certain rather than likely.
 *
 * ## Share is gated HERE, with the same gate the entry screen had
 *
 * Sharing copies what the SERVER holds (`lib/shares.ts`), so an entry this
 * device has not pushed, or has edited since, is refused with the reason —
 * `shareBlockedReason` over `entrySyncState`, exactly the pair
 * `app/food/entry/[id].tsx` used before this ticket moved the button. The
 * caller resolves the reason (it owns the sync-state read and `lastSyncAt`);
 * this sheet only draws it: the row is disabled, the reason sits under it,
 * and — as `ShareToFriend` already does — the reason is IN THE LABEL, because
 * a hint on a disabled control is not reliably announced.
 *
 * `shareBlocked === undefined` is "still finding out", and reads as blocked
 * with "Loading…" — the safe default while the answer is unknown, matching
 * the entry screen's `'Loading…'` fallback. `null` is the only value that
 * enables Share.
 */

import { Modal, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { withAlpha } from '@/lib/palette';

export function EntryMenuSheet({
  open,
  entryName,
  shareBlocked,
  onDuplicate,
  onRemove,
  onShare,
  onClose,
  testID = 'entry-menu',
}: {
  open: boolean;
  /** Names the entry in the title, so the athlete knows which row they hit. */
  entryName: string;
  /**
   * Why Share is refused, `null` when it is allowed, `undefined` while the
   * caller is still reading the sync flags.
   */
  shareBlocked: string | null | undefined;
  onDuplicate: () => void;
  onRemove: () => void;
  onShare: () => void;
  onClose: () => void;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const shareReason = shareBlocked === undefined ? 'Loading…' : shareBlocked;
  const shareDisabled = shareReason !== null;

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID={`${testID}-backdrop`}
      />
      <RNView
        style={styles.sheetWrap}
        pointerEvents="box-none"
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
      >
        <RNView style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 6 }]} testID={testID}>
          <RNView style={styles.grabber} />
          <RNView style={styles.head}>
            <Text style={styles.title} numberOfLines={1}>
              {entryName}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID={`${testID}-close`}
            >
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </RNView>

          <Pressable
            onPress={onDuplicate}
            style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
            accessibilityRole="button"
            accessibilityLabel={`Duplicate ${entryName}`}
            accessibilityHint="Logs it again in the same meal"
            testID={`${testID}-duplicate`}
          >
            <Text style={styles.optionText}>Duplicate</Text>
          </Pressable>

          <Pressable
            onPress={onRemove}
            style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${entryName}`}
            testID={`${testID}-remove`}
          >
            <Text style={[styles.optionText, styles.optionDanger]}>Remove</Text>
          </Pressable>

          <Pressable
            onPress={onShare}
            disabled={shareDisabled}
            style={({ pressed }) => [
              styles.option,
              pressed && !shareDisabled && styles.optionPressed,
              shareDisabled && styles.optionOff,
            ]}
            accessibilityRole="button"
            accessibilityLabel={shareDisabled ? `Share. ${shareReason}` : `Share ${entryName}`}
            accessibilityState={{ disabled: shareDisabled }}
            testID={`${testID}-share`}
          >
            <Text style={styles.optionText}>Share</Text>
            {shareDisabled ? (
              <Text
                style={styles.reason}
                // Already in the button's label — hidden here so it is not
                // read twice in a row. Visible for everyone else.
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                testID={`${testID}-share-reason`}
              >
                {shareReason}
              </Text>
            ) : null}
          </Pressable>
        </RNView>
      </RNView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: withAlpha(vola.bg, 0.62),
  },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: withAlpha(vola.surfaceRaised, 0.93),
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.07)',
    overflow: 'hidden',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginTop: 8,
    marginBottom: 4,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  title: { flex: 1, fontSize: 16, fontWeight: '800' },
  done: { fontSize: 14, fontWeight: '700', color: vola.lime },
  option: {
    paddingHorizontal: 20,
    // 46pt tall, over the 44 the HIG asks — matching the Library's rows.
    paddingVertical: 14,
    gap: 2,
  },
  optionPressed: { backgroundColor: 'rgba(255,255,255,0.05)' },
  optionOff: { opacity: 0.45 },
  optionText: { fontSize: 15, fontWeight: '600' },
  optionDanger: { color: vola.danger },
  reason: { fontSize: 12, color: vola.textMuted },
});
