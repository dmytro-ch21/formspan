/**
 * One meal section, as a card — N124/N113, rebuilt to the reference
 * (`IMG_5681`) with VOLA's own visual language rather than its orange accent.
 *
 * ## A thin renderer, on purpose
 *
 * Every figure this component prints is passed in already computed.
 * `nutrition.ts`'s own doc comment on the arithmetic it replaces states the
 * rule this follows: "a rule in a component is a rule no test can reach — the
 * first version of it was in `food.tsx` and its 'tests' asserted on
 * hand-written literals instead, so deleting the function left them all
 * green." `totals` comes from {@link bySlot}; `available` from
 * {@link mealAvailable} — both in `lib/nutrition.ts`, both tested there. This
 * file owns layout and nothing else.
 *
 * ## Populated vs. empty is a DIFFERENT SENTENCE, not the same one at zero
 *
 * A populated section states what was EATEN in it: "145 kcal · 11g protein ·
 * 0g carbs · 11g fat". An empty one states what is still AVAILABLE for it —
 * "938 kcal available · 41g protein · 74g carbs · 16g fat" — never a row of
 * zeroes, which N113's own AC calls out by name: "a zero reads as an
 * achievement, and this project does not present absence as an answer."
 * `available` is null with no target, in which case an empty section shows
 * nothing beneath its header — the same refusal `remaining()` makes one level
 * up, rather than a line built from half an answer.
 *
 * ## The glyph
 *
 * `glyphFor` (N58/#375) — category-derived, never keyword-matched from the
 * name, degrading to a neutral plate for a category this build does not
 * recognise OR an entry with no category to give it. See `Entry.category`'s
 * own doc comment for why null is the ordinary case today.
 *
 * ## The macro dots
 *
 * Small, and deliberately not a bar or a ring per meal — `nutrition-design.md`
 * §5's "dashboard graveyard" objection is to a STACK of those, and four cards
 * each carrying one would be exactly that. `macroColor()` from `macroModel.ts`
 * is the ONE existing site in this app that colours a macro (Goals'
 * `MacroDonut`) — reused here rather than `macroColors` directly, because
 * `macroColor()` is the monochrome-aware wrapper and reaching past it is what
 * breaks that accessibility mode for whichever screen does it.
 */

import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { SwipeToDelete } from '@/components/SwipeToDelete';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { glyphFor } from '@/lib/foodGlyph';
import { loggedAmountLabel } from '@/lib/foodQuantity';
import { macroColor } from '@/lib/macroModel';
import { fmtAmount, type Entry, type Macros, type Meal } from '@/lib/nutrition';
import { useUnits } from '@/lib/useUnits';

function macroLine(protein: number, carb: number, fat: number): { key: string; colour: string; text: string }[] {
  return [
    { key: 'protein', colour: macroColor('protein'), text: `${fmtAmount(protein)}g protein` },
    { key: 'carbs', colour: macroColor('carbs'), text: `${fmtAmount(carb)}g carbs` },
    { key: 'fat', colour: macroColor('fat'), text: `${fmtAmount(fat)}g fat` },
  ];
}

export function MealCard({
  meal,
  label,
  entries,
  totals,
  available,
  addColor,
  onAdd,
  onEntryPress,
  onDelete,
  testID,
}: {
  meal: Meal;
  /** "Breakfast", "Lunch", … — see `MEAL_LABELS` in `food.tsx`. */
  label: string;
  entries: Entry[];
  /** This slot's OWN totals — from {@link bySlot}, derived from `entries`. */
  totals: Macros;
  /** What is still available for this slot, or null with no target. */
  available: Macros | null;
  /** The athlete's accent colour — matches the "Add" affordance every other
   *  actionable control on this screen already uses (`TargetRow`, the old
   *  per-slot "Add" button this replaces). */
  addColor: string;
  onAdd: () => void;
  onEntryPress: (id: string) => void;
  onDelete: (id: string) => void;
  testID?: string;
}) {
  const hasEntries = entries.length > 0;
  const { foodUnit } = useUnits();

  return (
    <RNView style={styles.card} testID={testID}>
      <Text style={styles.header} testID={testID ? `${testID}-header` : undefined}>
        {hasEntries ? `${label} · ${fmtAmount(totals.kcal)} kcal` : label}
      </Text>

      {hasEntries ? (
        <RNView style={styles.macroRow} testID={testID ? `${testID}-macros` : undefined}>
          {macroLine(totals.protein_g, totals.carb_g, totals.fat_g).map((m) => (
            <RNView key={m.key} style={styles.macroCell}>
              <RNView style={[styles.dot, { backgroundColor: m.colour }]} />
              <Text style={styles.macroText}>{m.text}</Text>
            </RNView>
          ))}
        </RNView>
      ) : (
        available && (
          <RNView testID={testID ? `${testID}-available` : undefined}>
            <Text style={styles.availableKcal}>{fmtAmount(available.kcal)} kcal now available</Text>
            <RNView style={styles.macroRow}>
              {macroLine(available.protein_g, available.carb_g, available.fat_g).map((m) => (
                <RNView key={m.key} style={styles.macroCell}>
                  <RNView style={[styles.dot, { backgroundColor: m.colour }]} />
                  <Text style={styles.macroText}>{m.text}</Text>
                </RNView>
              ))}
            </RNView>
          </RNView>
        )
      )}

      {entries.map((e) => (
        <SwipeToDelete
          key={e.id}
          onDelete={() => onDelete(e.id)}
          accessibilityLabel={e.name}
          closeOn={entries.length}
          testID={`food-entry-${e.id}`}
        >
          <Pressable
            style={styles.row}
            onPress={() => onEntryPress(e.id)}
            accessibilityRole="button"
            accessibilityLabel={`${e.name}, ${Math.round(e.kcal)} calories`}
          >
            <Text style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no">
              {glyphFor(e.category)}
            </Text>
            <RNView style={styles.rowMain}>
              <Text style={styles.rowName} numberOfLines={1}>
                {e.name}
              </Text>
              <Text style={styles.rowServing}>{loggedAmountLabel(e.servings, e.serving_label, foodUnit)}</Text>
            </RNView>
            <Text style={styles.rowKcal}>{Math.round(e.kcal)}</Text>
          </Pressable>
        </SwipeToDelete>
      ))}

      <Pressable
        style={styles.add}
        onPress={onAdd}
        accessibilityRole="button"
        accessibilityLabel={`Add food to ${label}`}
        testID={`food-add-${meal}`}
      >
        <Icon name="plus" size={13} color={addColor} />
        <Text style={[styles.addText, { color: addColor }]}>Add Food</Text>
      </Pressable>
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
    gap: 10,
  },
  header: { fontSize: 15, fontWeight: '700' },
  availableKcal: { fontSize: 13, fontWeight: '600', color: vola.textMuted, marginTop: -4 },
  macroRow: { flexDirection: 'row', gap: 14, marginTop: -2 },
  macroCell: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  macroText: { fontSize: 12, color: vola.textMuted },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  glyph: { fontSize: 20 },
  rowMain: { flex: 1, gap: 2 },
  rowName: { fontSize: 14, fontWeight: '600' },
  rowServing: { fontSize: 12, color: vola.textDim },
  rowKcal: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },

  add: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    paddingVertical: 6,
  },
  addText: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
});
