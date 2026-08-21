import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { Icon } from '@/components/ui/Icon';
import { useAccent } from '@/lib/AccentProvider';

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
  info,
  trailing,
  testID,
}: {
  label: string;
  /** The link's words, e.g. "All". Omit for a plain label. */
  action?: string;
  onAction?: () => void;
  /**
   * A mark that sits WITH the label rather than opposite it — in practice an
   * `InfoMark`. It belongs beside the words it qualifies, not in the corner
   * where the way-out lives, because it is not a way out: tapping it explains
   * this section instead of leaving it.
   */
  info?: React.ReactNode;
  /**
   * A static badge at the right — the reference's `g per day` pill, which
   * states the unit the section is drawn in.
   *
   * Deliberately separate from `action`, which is a LINK and renders a chevron.
   * Passing a non-interactive badge as an action would draw an arrow pointing
   * nowhere, which is the exact broken promise `action`'s own note forbids.
   * Ignored when an action is present, so one header cannot claim both corners.
   */
  trailing?: React.ReactNode;
  testID?: string;
}) {
  const accent = useAccent();

  return (
    <RNView style={styles.head}>
      <RNView style={styles.labelWrap}>
        <Text style={styles.label}>{label.toUpperCase()}</Text>
        {info}
      </RNView>
      {!(action && onAction) && trailing}
      {action && onAction && (
        <Pressable
          onPress={onAction}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={action}
          style={styles.action}
          testID={testID}
        >
          <Text style={[styles.actionText, { color: accent.ink }]}>{action}</Text>
          <Icon name="chevron" size={12} color={accent.ink} />
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
  // `flexShrink` on the wrapper rather than the text: an uppercase tracked
  // label at accessibility sizes is wider than the row, and without this the
  // trailing badge is pushed off the right edge instead of the label wrapping.
  labelWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: vola.textDim,
    flexShrink: 1,
  },
  action: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  // Colour is set inline, from the chosen accent — this is a way out of the
  // section, and the accent is what marks "act here" everywhere else.
  actionText: { fontSize: 13, fontWeight: '700' },
});
