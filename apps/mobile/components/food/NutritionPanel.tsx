/**
 * The real nutrition panel on food detail (N59).
 *
 * A big calorie number on the left, and a nutrition-label-style breakdown on
 * the right: Total Fat / Sat Fat (indented) / Cholesterol / Sodium / Total
 * Carbs / Fiber (indented) / Sugars (indented, with Added Sugars indented once
 * more under it) / Protein.
 *
 * **`n/a`, never `0`, for a value this food does not state.** A zero here is a
 * specific, false claim — "this food has no sodium" — that the data does not
 * support, and it is the single most-repeated defect in this codebase's own
 * history (`fibre_g`, then N52's wider macro set arriving at exactly the same
 * rule). Every figure below is rendered by one shared helper for that reason:
 * a second inline `?? 0` anywhere on this screen is how the mistake comes
 * back.
 *
 * **There is deliberately no "View Full Nutrition Label" button below this.**
 * The design reference asks for one, and it would have nowhere real to go: it
 * exists on a label to disclose figures a summary view left out, and this
 * panel already renders every figure this app tracks — the five N52 label
 * macros plus the four this screen always had. A button promising a fuller
 * label than the one already on screen is exactly the failure N39 records: an
 * affordance that filters or reveals nothing is worse than no affordance,
 * because the athlete cannot tell it apart from one that works. If a genuinely
 * fuller label ever exists (per-100g figures, ingredients, allergens), this
 * button is the right place for it — not before then.
 */
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import type { Macros } from '@/lib/nutrition';

/** `n/a` for null — never `0`, which would be a claim the data does not make. */
function amount(v: number | null, unit: string): string {
  if (v == null) return 'n/a';
  const rounded = Math.round(v * 10) / 10;
  return `${rounded}${unit}`;
}

function Row({
  label,
  value,
  indent = 0,
  strong = false,
  testID,
}: {
  label: string;
  value: string;
  indent?: number;
  strong?: boolean;
  testID: string;
}) {
  return (
    <View style={styles.row} testID={testID}>
      <Text
        style={[styles.label, strong && styles.labelStrong, indent > 0 && { paddingLeft: indent * 14 }]}
      >
        {label}
      </Text>
      <Text style={[styles.value, strong && styles.valueStrong]} testID={`${testID}-value`}>
        {value}
      </Text>
    </View>
  );
}

export function NutritionPanel({ macros }: { macros: Macros }) {
  return (
    <View style={styles.wrap} testID="nutrition-panel">
      <View style={styles.kcalCol}>
        <Text style={styles.kcalNumber} testID="nutrition-panel-kcal">
          {Math.round(macros.kcal)}
        </Text>
        <Text style={styles.kcalLabel}>Calories</Text>
      </View>
      <View style={styles.breakdown}>
        <Row
          label="Total Fat"
          value={amount(macros.fat_g, 'g')}
          strong
          testID="nutrition-panel-fat_g"
        />
        <Row
          label="Sat Fat"
          value={amount(macros.saturated_fat_g, 'g')}
          indent={1}
          testID="nutrition-panel-saturated_fat_g"
        />
        <Row
          label="Cholesterol"
          value={amount(macros.cholesterol_mg, 'mg')}
          strong
          testID="nutrition-panel-cholesterol_mg"
        />
        <Row
          label="Sodium"
          value={amount(macros.sodium_mg, 'mg')}
          strong
          testID="nutrition-panel-sodium_mg"
        />
        <Row
          label="Total Carbs"
          value={amount(macros.carb_g, 'g')}
          strong
          testID="nutrition-panel-carb_g"
        />
        <Row
          label="Fiber"
          value={amount(macros.fibre_g, 'g')}
          indent={1}
          testID="nutrition-panel-fibre_g"
        />
        <Row
          label="Sugars"
          value={amount(macros.sugar_g, 'g')}
          indent={1}
          testID="nutrition-panel-sugar_g"
        />
        <Row
          label="Added Sugars"
          value={amount(macros.added_sugar_g, 'g')}
          indent={2}
          testID="nutrition-panel-added_sugar_g"
        />
        <Row
          label="Protein"
          value={amount(macros.protein_g, 'g')}
          strong
          testID="nutrition-panel-protein_g"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: 16, paddingVertical: 8 },
  kcalCol: { alignItems: 'center', justifyContent: 'center', minWidth: 76 },
  kcalNumber: { fontSize: 34, fontWeight: '800', color: vola.text },
  kcalLabel: { fontSize: 12, color: vola.textDim, fontWeight: '600' },
  breakdown: { flex: 1, borderLeftWidth: 1, borderLeftColor: vola.line, paddingLeft: 14, gap: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  label: { fontSize: 13, color: vola.textMuted },
  labelStrong: { color: vola.text, fontWeight: '700' },
  value: { fontSize: 13, color: vola.textMuted },
  valueStrong: { color: vola.text, fontWeight: '700' },
});
