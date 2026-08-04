import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { Icon } from '@/components/ui/Icon';

/**
 * The label above a group of cards, with an optional way out of it.
 *
 * The eyebrow treatment (small, uppercase, tracked, dim) is already the house
 * style — `TrainingSummary`, `You` and the old Today screen each declared it
 * separately, at three slightly different sizes. This is that rule in one
 * place; the drift is the reason it's a component rather than a copied style
 * block.
 *
 * `action` is only rendered when there is somewhere to go. A chevron pointing
 * at nothing is the same broken promise as a tappable-looking day cell.
 */
export function SectionHeader({
  label,
  action,
  onAction,
  testID,
}: {
  label: string;
  /** The link's words, e.g. "All". Omit for a plain label. */
  action?: string;
  onAction?: () => void;
  testID?: string;
}) {
  return (
    <RNView style={styles.head}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      {action && onAction && (
        <Pressable
          onPress={onAction}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={action}
          style={styles.action}
          testID={testID}
        >
          <Text style={styles.actionText}>{action}</Text>
          <Icon name="chevron" size={12} color={vola.textMuted} />
        </Pressable>
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 20,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: vola.textDim,
  },
  action: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  actionText: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
});
