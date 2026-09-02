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
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 8,
  },
  header: { fontSize: 15, fontWeight: '700' },
  macroRow: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  macroCell: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  macroText: { fontSize: 12, color: vola.textMuted },
});
