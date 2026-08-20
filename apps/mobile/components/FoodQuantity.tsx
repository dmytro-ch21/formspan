/**
 * "How much of this did you eat" (N90).
 *
 * Before this, tapping a catalog row logged one 100 g serving whatever the
 * athlete actually ate — the reasoning for the number was on screen and the
 * ability to disagree with it was not, which is the exact failure the
 * mobile-first rule in CLAUDE.md was written about.
 *
 * Three ways in, all funnelling through GRAMS:
 *
 *   - type a number, in grams or ounces;
 *   - tap a portion USDA states ("1 large" = 50 g);
 *   - fall back to 100 g, which is always offered.
 *
 * keyboard-container: provided by parent — this is a leaf that is always
 * rendered inside `add.tsx`'s `KeyboardAwareScrollView`, and it owns no scroll
 * container of its own. Wrapping the input here would nest one scroll view
 * inside another rather than fix anything.
 *
 * The g/oz toggle CONVERTS the number rather than relabelling it. Relabelling
 * would turn 150 grams of chicken into 150 ounces — a 28x overcount with no
 * visible change on screen beyond two letters — and there is a test named after
 * that specific failure.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import type { CatalogFood } from '@/lib/catalogApi';
import { macrosForGrams, parseQuantity, quantityOptions } from '@/lib/foodQuantity';
import { useUnits } from '@/lib/UnitsProvider';
import { foodUnitLabel, fromDisplayGrams, toDisplayGrams, type FoodUnit } from '@/lib/units';

const UNITS: FoodUnit[] = ['g', 'oz'];

export function FoodQuantity({
  food,
  onLog,
  busy,
}: {
  food: CatalogFood;
  onLog: (grams: number) => void;
  busy?: boolean;
}) {
  const { foodUnit, setFoodUnit } = useUnits();
  const options = useMemo(() => quantityOptions(food, food.portions), [food]);

  // Grams are the state. The text field is a VIEW of it, which is what makes
  // the unit toggle a conversion rather than a reinterpretation.
  const initial = options[0]?.grams ?? 100;
  const [grams, setGrams] = useState<number>(initial);
  const [text, setText] = useState<string>(String(toDisplayGrams(initial, foodUnit)));

  // **Re-render the field when the unit changes from OUTSIDE this component.**
  //
  // `text` is seeded once at mount and otherwise only rewritten by the toggle
  // and the portion chips. That leaves one path uncovered: the provider adopting
  // a different `food_unit` from the server while this sheet is open. The
  // component re-renders with the new unit — the toggle highlight and the
  // input's accessibility label both flip — while `text` still holds the OLD
  // unit's number. That is precisely the relabel-without-converting state this
  // component exists to prevent, and it is worse than the toggle version because
  // nobody touched anything: the field would read "100" beside a lit `oz`, and
  // editing it to "101" would commit ~2,863 g.
  //
  // Keyed on the unit and NOT on `grams`, so it cannot fight the athlete's own
  // typing — an effect that also watched `grams` would rewrite the field
  // mid-keystroke and make "10" un-typeable on the way to "100".
  const lastUnit = useRef(foodUnit);
  useEffect(() => {
    if (lastUnit.current === foodUnit) return;
    lastUnit.current = foodUnit;
    setText(String(toDisplayGrams(grams, foodUnit)));
    // `grams` is deliberately absent from the deps — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foodUnit]);

  const commitText = useCallback(
    (next: string) => {
      setText(next);
      const typed = parseQuantity(next);
      if (typed != null) setGrams(fromDisplayGrams(typed, foodUnit));
    },
    [foodUnit],
  );

  const switchUnit = useCallback(
    async (u: FoodUnit) => {
      if (u === foodUnit) return;
      // The stored grams are unchanged; only the field's rendering of them
      // moves. Reading the number out of the text box and relabelling it is the
      // bug this ordering avoids.
      setText(String(toDisplayGrams(grams, u)));
      await setFoodUnit(u);
    },
    [foodUnit, grams, setFoodUnit],
  );

  const pickPortion = useCallback(
    (portionGrams: number) => {
      setGrams(portionGrams);
      setText(String(toDisplayGrams(portionGrams, foodUnit)));
    },
    [foodUnit],
  );

  const valid = parseQuantity(text) != null && grams > 0;
  // Recomputed as the athlete types, so what they are about to log is on screen
  // BEFORE they log it.
  const macros = macrosForGrams(food, valid ? grams : 0);

  return (
    <View style={styles.wrap}>
      <Text style={styles.name}>{food.brand ? `${food.brand} ${food.name}` : food.name}</Text>

      <View style={styles.row}>
        <TextInput
          value={text}
          onChangeText={commitText}
          keyboardType="decimal-pad"
          selectTextOnFocus
          style={styles.input}
          placeholderTextColor={vola.textDim}
          accessibilityLabel={`Quantity in ${foodUnit === 'oz' ? 'ounces' : 'grams'}`}
          testID="food-quantity-input"
        />
        <View style={styles.toggle}>
          {UNITS.map((u) => (
            <Pressable
              key={u}
              onPress={() => switchUnit(u)}
              accessibilityRole="button"
              accessibilityState={{ selected: u === foodUnit }}
              accessibilityLabel={u === 'oz' ? 'Ounces' : 'Grams'}
              testID={`food-unit-${u}`}
              style={[styles.unit, u === foodUnit && styles.unitOn]}
            >
              <Text style={[styles.unitText, u === foodUnit && styles.unitTextOn]}>
                {foodUnitLabel(u)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {options.length > 0 && (
        <View style={styles.portions}>
          {options.map((o) => (
            <Pressable
              key={`${o.label}-${o.grams}`}
              onPress={() => pickPortion(o.grams)}
              accessibilityRole="button"
              // The gram weight is in the label, not just the name: "1 large" is
              // not a quantity anybody can check without it.
              accessibilityLabel={`${o.label}, ${o.grams} grams`}
              testID={`food-portion-${o.grams}`}
              style={[styles.chip, o.grams === grams && styles.chipOn]}
            >
              <Text style={styles.chipText}>{o.label}</Text>
              <Text style={styles.chipGrams}>{o.grams} g</Text>
            </Pressable>
          ))}
        </View>
      )}

      <Text style={styles.macros} testID="food-quantity-macros">
        {valid
          ? `${macros.kcal} kcal · ${macros.protein_g}P · ${macros.carb_g}C · ${macros.fat_g}F`
          : 'Enter a quantity'}
      </Text>

      <Pressable
        onPress={() => valid && !busy && onLog(grams)}
        disabled={!valid || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: !valid || busy }}
        testID="food-quantity-log"
        style={[styles.log, (!valid || busy) && styles.logOff]}
      >
        <Text style={styles.logText}>Log</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12, paddingVertical: 8 },
  name: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    flex: 1,
    fontSize: 22,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: vola.surface,
    color: vola.text,
  },
  toggle: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden', backgroundColor: vola.surface },
  unit: { paddingVertical: 12, paddingHorizontal: 16 },
  unitOn: { backgroundColor: vola.accent },
  unitText: { fontSize: 15, color: vola.textMuted },
  unitTextOn: { color: vola.bg, fontWeight: '700' },
  portions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: vola.surface,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  chipOn: { backgroundColor: vola.surfaceRaised },
  chipText: { fontSize: 14 },
  chipGrams: { fontSize: 12, color: vola.textDim },
  macros: { fontSize: 13, color: vola.textMuted },
  log: { paddingVertical: 14, borderRadius: 12, backgroundColor: vola.accent, alignItems: 'center' },
  logOff: { opacity: 0.4 },
  logText: { color: vola.bg, fontWeight: '700', fontSize: 16 },
});
