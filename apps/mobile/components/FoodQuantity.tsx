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
import {
  displayName,
  macrosForGrams,
  parseQuantity,
  quantityOptions,
  type NaturalUnit,
  type QuantifiableFood,
} from '@/lib/foodQuantity';
import type { Macros } from '@/lib/nutrition';
import { useUnits } from '@/lib/UnitsProvider';
import { foodUnitLabel, fromDisplayGrams, toDisplayGrams, type FoodUnit } from '@/lib/units';

const UNITS: FoodUnit[] = ['g', 'oz'];

export function FoodQuantity({
  food,
  onLog,
  busy,
  cta = 'Log',
  onQuantityChange,
  hideBuiltInFooter,
  hideName,
  initialGrams,
  naturalUnit,
  initialUsingNatural,
  onUnitModeChange,
}: {
  food: QuantifiableFood;
  onLog: (grams: number) => void;
  busy?: boolean;
  /**
   * What the button DOES, in the athlete's words.
   *
   * Defaulted to `Log` because that is what every caller meant before N87
   * needed the same control to add an ingredient to a recipe — where "Log"
   * would claim a meal had been recorded when nothing had. The default keeps
   * the existing callers honest rather than making them restate themselves.
   */
  cta?: string;
  /**
   * N59: reports the CURRENT quantity and its scaled macros on every change —
   * this component already computes both for its own one-line summary, and a
   * caller building a richer panel around it (the food-detail nutrition
   * panel) reads the same numbers rather than keeping a second, potentially
   * drifting copy of this component's state.
   */
  onQuantityChange?: (state: { grams: number; valid: boolean; macros: Macros }) => void;
  /**
   * N59: suppresses the built-in one-line summary AND the inline Log button,
   * rendering nothing in their place. For `add.tsx`'s food-detail screen,
   * where the confirm action has to live in a sticky footer above the
   * keyboard rather than scroll away with the quantity fields — the caller
   * drives its own button off `onQuantityChange` instead. Existing callers
   * (the recipe ingredient picker) leave this unset and keep the original
   * inline summary and button.
   */
  hideBuiltInFooter?: boolean;
  /**
   * N426: suppresses this component's own name/brand line — for a caller
   * (the scan screen's amount sheet) that already shows the food's name on
   * the screen behind this control, where repeating it would be the second
   * copy of the exact duplicate-display bug that motivated this prop.
   * Existing callers (the recipe ingredient picker, `add.tsx`'s `picking`
   * screen, which show the name nowhere else) leave this unset and keep
   * today's single name line, now via the shared `displayName` guard below
   * rather than a raw `${brand} ${name}` that could repeat the brand.
   */
  hideName?: boolean;
  /**
   * N426, found in review: the amount an already-open draft is AT, so a
   * remount (the scan screen's amount sheet unmounts this component on
   * close — `Modal`'s children are gone while `visible={false}`, not merely
   * hidden) resumes from what the athlete already chose rather than
   * resetting to the packet's default every time the sheet reopens.
   * Concretely: open, type 80 g, tap Done (the card correctly shows
   * "80 g"), tap Amount again — without this prop the control remounts
   * fresh and silently drops back to 25 g, which is then what gets logged
   * if Done is tapped again without re-typing. Existing callers (the
   * recipe ingredient picker, `add.tsx`'s `picking` screen, which never
   * unmount and remount this control mid-edit) leave this unset and keep
   * today's behaviour — the packet-or-100g default, unaffected.
   */
  initialGrams?: number;
  /**
   * N426: a discrete unit derived from the packet's own stated serving
   * ("2 pieces (25 g)" → 12.5 g/piece) — see `naturalUnitFor`'s own doc for
   * why this is deliberately narrow. `null`/unset (every existing caller)
   * keeps today's g/oz-only toggle exactly as it was.
   */
  naturalUnit?: NaturalUnit | null;
  /**
   * N426, found in review: without this, the sheet always reopened in
   * `naturalUnit` mode even when the athlete had explicitly switched to
   * g/oz last time — `initialGrams` resumes the right NUMBER, but a fresh
   * `Boolean(naturalUnit)` default forgot which UNIT they'd chosen to see
   * it in. Mirrors `initialGrams` exactly: unset (every existing caller)
   * keeps today's behaviour, `Boolean(naturalUnit)`.
   */
  initialUsingNatural?: boolean;
  /**
   * N426: fires whenever the athlete explicitly changes unit/mode (g, oz,
   * or the natural unit) — the caller's own record of "what they chose",
   * fed back in as `initialUsingNatural` on the next mount. Not fired on
   * mount itself; only on an actual switch.
   */
  onUnitModeChange?: (usingNatural: boolean) => void;
}) {
  const { foodUnit, setFoodUnit } = useUnits();
  const options = useMemo(() => quantityOptions(food, food.portions), [food]);

  // Grams are the state. The text field is a VIEW of it, which is what makes
  // the unit toggle a conversion rather than a reinterpretation.
  const initial = initialGrams ?? options[0]?.grams ?? 100;
  const [grams, setGrams] = useState<number>(initial);
  /**
   * Whether the field is currently displayed in `naturalUnit` rather than
   * g/oz. Defaults ON when a natural unit exists — the packet's own terms
   * ("2 pieces") are what the athlete actually read on the box, so that is
   * what the field should open showing, matching the reference screenshot
   * this ticket was reported against.
   */
  const [usingNatural, setUsingNatural] = useState<boolean>(
    initialUsingNatural ?? Boolean(naturalUnit),
  );
  const [text, setText] = useState<string>(
    usingNatural && naturalUnit
      ? formatNatural(initial, naturalUnit)
      : String(toDisplayGrams(initial, foodUnit)),
  );

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
    // Natural-unit display is not the global weight preference and is not
    // affected by it changing from outside — only an explicit tap on g/oz
    // below leaves natural mode.
    if (usingNatural) return;
    // This is the same "sync local display state from an external value"
    // effect the file already had (see the `exhaustive-deps` suppression a
    // few lines down, on the same effect, for the same reasoning) — adding
    // the branch above is what newly trips the linter's heuristic for this
    // call, not a change in what the effect actually does.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(String(toDisplayGrams(grams, foodUnit)));
    // `grams` is deliberately absent from the deps — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foodUnit]);

  const commitText = useCallback(
    (next: string) => {
      setText(next);
      const typed = parseQuantity(next);
      if (typed == null) return;
      setGrams(
        usingNatural && naturalUnit ? typed * naturalUnit.gramsPerUnit : fromDisplayGrams(typed, foodUnit),
      );
    },
    [foodUnit, usingNatural, naturalUnit],
  );

  const switchUnit = useCallback(
    async (u: FoodUnit) => {
      const leavingNatural = usingNatural;
      setUsingNatural(false);
      onUnitModeChange?.(false);
      // The stored grams are unchanged; only the field's rendering of them
      // moves. Reading the number out of the text box and relabelling it is the
      // bug this ordering avoids. Recomputed even when `u === foodUnit`: the
      // field may have been showing the natural unit, and tapping g/oz while
      // already on that weight unit still has to leave natural mode.
      setText(String(toDisplayGrams(grams, u)));
      if (u === foodUnit && !leavingNatural) return;
      if (u !== foodUnit) await setFoodUnit(u);
    },
    [foodUnit, grams, setFoodUnit, usingNatural, onUnitModeChange],
  );

  /** N426: the packet's own unit ("pieces"), when `naturalUnit` offers one. */
  const switchToNatural = useCallback(() => {
    if (!naturalUnit) return;
    setUsingNatural(true);
    onUnitModeChange?.(true);
    setText(formatNatural(grams, naturalUnit));
  }, [naturalUnit, grams, onUnitModeChange]);

  const pickPortion = useCallback(
    (portionGrams: number) => {
      setGrams(portionGrams);
      setText(
        usingNatural && naturalUnit
          ? formatNatural(portionGrams, naturalUnit)
          : String(toDisplayGrams(portionGrams, foodUnit)),
      );
    },
    [foodUnit, usingNatural, naturalUnit],
  );

  const valid = parseQuantity(text) != null && grams > 0;
  // Recomputed as the athlete types, so what they are about to log is on screen
  // BEFORE they log it.
  const macros = macrosForGrams(food, valid ? grams : 0);

  // Reports on every change to the numbers themselves, never on a re-render
  // that leaves them the same — `onLog`/`busy` are read fresh inside the
  // callback the caller gets, so they are deliberately not in the dep list.
  // `food` IS in the dep list, even though `add.tsx`'s only in-place swap
  // (the partial search result upgrading to the full catalog fetch) carries
  // identical per-100g figures either way: a future caller whose food's
  // numbers genuinely change while mounted must not see a stale report.
  useEffect(() => {
    onQuantityChange?.({ grams: valid ? grams : 0, valid, macros });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grams, valid, food]);

  return (
    <View style={styles.wrap}>
      {!hideName && <Text style={styles.name}>{displayName(food)}</Text>}

      <View style={styles.row}>
        <TextInput
          value={text}
          onChangeText={commitText}
          keyboardType="decimal-pad"
          selectTextOnFocus
          // N426, found in review: a plain surface-coloured box read as
          // static text, not something tappable — no border, no visible
          // "this is a field" cue. A border matching the app's other
          // editable numeric fields (`entry/[id].tsx`'s `input` style) is
          // the fix, not a novel affordance.
          style={styles.input}
          placeholderTextColor={vola.textDim}
          accessibilityLabel={`Quantity in ${
            usingNatural && naturalUnit ? naturalUnit.wordPlural : foodUnit === 'oz' ? 'ounces' : 'grams'
          }`}
          testID="food-quantity-input"
        />
        <View style={styles.toggle}>
          {/* N426: the packet's own unit, when one is derivable — first,
              since it is the primary/default reading, matching what the
              athlete actually saw printed on the box. */}
          {naturalUnit && (
            <Pressable
              onPress={switchToNatural}
              accessibilityRole="button"
              accessibilityState={{ selected: usingNatural }}
              accessibilityLabel={capitalize(naturalUnit.wordPlural)}
              testID="food-unit-natural"
              style={[styles.unit, usingNatural && styles.unitOn]}
            >
              <Text style={[styles.unitText, usingNatural && styles.unitTextOn]}>
                {naturalUnit.wordPlural}
              </Text>
            </Pressable>
          )}
          {UNITS.map((u) => (
            <Pressable
              key={u}
              onPress={() => switchUnit(u)}
              accessibilityRole="button"
              accessibilityState={{ selected: !usingNatural && u === foodUnit }}
              accessibilityLabel={u === 'oz' ? 'Ounces' : 'Grams'}
              testID={`food-unit-${u}`}
              style={[styles.unit, !usingNatural && u === foodUnit && styles.unitOn]}
            >
              <Text style={[styles.unitText, !usingNatural && u === foodUnit && styles.unitTextOn]}>
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

      {!hideBuiltInFooter && (
        <>
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
            <Text style={styles.logText}>{cta}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

/** "{grams}" as a count of `unit`, rounded to a sane number of decimals. */
function formatNatural(grams: number, unit: NaturalUnit): string {
  return String(Math.round((grams / unit.gramsPerUnit) * 100) / 100);
}

/** "pieces" → "Pieces", for the toggle pill's accessibility label. */
function capitalize(word: string): string {
  return word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word;
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
    // N426, found in review: "not noticeable you can actually change the
    // grams" — a plain surface fill with no border read as static text.
    // Matches `entry/[id].tsx`'s `input` style, this app's other editable
    // numeric field, rather than inventing a new affordance.
    borderWidth: 1,
    borderColor: vola.line,
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
