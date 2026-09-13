/**
 * The day's food, summed — N468/#792.
 *
 * **Distinct from `RemainingBlock`, deliberately.** `RemainingBlock` states
 * what is LEFT (a forward-looking, target-dependent figure) and lives above
 * the day stepper's own target row. This states what has been EATEN so far —
 * how many items, how many calories, and the macro split — which needs no
 * target at all and is true on a day with none set. Two cards answering two
 * different questions, not two copies of one number.
 *
 * A thin renderer, same rule `MealCard.tsx` states for itself: every figure
 * here comes from {@link EatenView}, already computed by `dayTotals` (via
 * `eatenFrom`) — this file owns layout and nothing else.
 *
 * Renders nothing outside the `ready` state. `food.tsx` already draws its own
 * "Loading your meals…" / "could not be read" text for `loading` and
 * `unavailable` — a second, silent copy of that here (an empty card, or one
 * asserting zero items) would be the same "a read that never happened reads
 * as a confident answer" failure N28 exists to prevent, one card up.
 */

import { StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { macroLine } from '@/components/food/MealCard';
import { vola } from '@/constants/Colors';
import { Radius, Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import { fmtAmount, type EatenView } from '@/lib/nutrition';

export function FoodSummaryCard({ eaten, testID }: { eaten: EatenView; testID?: string }) {
  if (eaten.state !== 'ready') return null;
  const { rows, totals } = eaten;
  const itemWord = rows.length === 1 ? 'item' : 'items';

  return (
    <RNView style={styles.card} testID={testID}>
      <Text style={styles.header} testID={testID ? `${testID}-header` : undefined}>
        {/* A genuine zero is a real answer here, not the "achievement" zero
            `MealCard`'s own doc comment refuses — nobody has logged nothing
            is exactly what "0 items" says, honestly, on a day so far empty. */}
        {rows.length} {itemWord} logged · {fmtAmount(totals.kcal)} kcal
      </Text>
      <RNView style={styles.macroRow} testID={testID ? `${testID}-macros` : undefined}>
        {macroLine(totals.protein_g, totals.carb_g, totals.fat_g).map((m) => (
          <RNView key={m.key} style={styles.macroCell}>
            <RNView style={[styles.dot, { backgroundColor: m.colour }]} />
            <Text style={styles.macroText}>{m.text}</Text>
          </RNView>
        ))}
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.card,
    backgroundColor: vola.surface,
    padding: Spacing.cardPadding,
    gap: Spacing.sm,
  },
  header: { ...Typography.emphasis, fontWeight: '700' },
  macroRow: { flexDirection: 'row', gap: Spacing.cardPadding, flexWrap: 'wrap' },
  macroCell: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  macroText: { ...Typography.caption, color: vola.textMuted, fontWeight: '400' },
});
