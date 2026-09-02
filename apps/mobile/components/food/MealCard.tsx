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
 * `mealAvailableForDay` — both in `lib/nutrition.ts`, both tested there. This
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
 *
 * ## Combine-select mode (N115)
 *
 * "Combine" appears in the header once a section has two or more rows — tapping
 * it turns every row in THIS card into a checkbox, via `selecting`. Scoped to
 * one card on purpose: the ticket's own words are "select entries IN A SECTION",
 * and a shake is milk + protein + berries + ice cream from ONE sitting, never a
 * breakfast item merged with a dinner one. `food.tsx` owns which meal is
 * currently selecting (there is only ever one) and passes it down; this
 * component owns nothing about *why* a row is selectable, only how it looks
 * once it is. `enabled={!selecting}` on `SwipeToDelete` is what stops a swipe
 * gesture fighting a tap-to-select gesture on the same row, rather than
 * unmounting it — unmounting would drop its open/closed animation state on
 * every mode change, which is the same "component instance outlives what it is
 * showing" trap `closeOn` already exists to avoid one level up.
 *
 * ## Collapsible — N468/#792
 *
 * **Default is EXPANDED, always, regardless of whether the slot has anything
 * logged.** The tempting default — collapse an empty slot, since there is
 * nothing in it yet — was rejected: the populated-vs-available sentence this
 * component exists to draw (see the section above) is exactly the kind of
 * fact N113 fought to make unconditionally visible, and hiding it behind a
 * default nobody chose would reintroduce "absence reads as an answer" one
 * level up, wearing a collapse instead of a zero. So every section opens the
 * same way every time, and an athlete who wants to declutter collapses it
 * themselves — a state this component owns locally (`useState`, not a prop),
 * which is also why `food.tsx` keys each card on the DAY as well as the
 * slot: switching days remounts the card, so yesterday's manual collapse
 * does not carry over as today's default.
 *
 * Collapsing hides the macro/available line and the logged rows — the two
 * things that actually cost vertical space. The header (which already states
 * the slot's own total once it has entries) and the "Add Food" button both
 * stay visible either way: collapsing is for re-reading a section that is
 * already logged, not for making the one thing an athlete does most (adding
 * food) cost an extra tap first.
 *
 * **Collapsing and combine-select compose, not collide.** The Combine link is
 * only offered while a section is expanded — starting a selection on rows you
 * cannot see makes no sense — and once `selecting` is true this component
 * forces itself open (`effectiveExpanded = selecting || expanded`) and the
 * header's own toggle stops responding, so a section mid-selection cannot be
 * collapsed out from under it by a stray tap on its own header.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { SwipeToDelete } from '@/components/SwipeToDelete';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { glyphFor } from '@/lib/foodGlyph';
import { loggedAmountLabel } from '@/lib/foodQuantity';
import { macroColor } from '@/lib/macroModel';
import { fmtAmount, type Entry, type Macros, type Meal } from '@/lib/nutrition';
import { useUnits } from '@/lib/useUnits';

/**
 * The three-macro-dot line — shared with {@link FoodSummaryCard}, which
 * states the SAME three macros for the whole day rather than one slot. Kept
 * as one function so the two never drift into different wording or colours
 * for the same three macros on the same screen.
 */
export function macroLine(protein: number, carb: number, fat: number): { key: string; colour: string; text: string }[] {
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
  selecting = false,
  selectedIds,
  onToggleSelect,
  onStartCombine,
  onCancelCombine,
  onConfirmCombine,
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
  /**
   * N115 — whether THIS card is the one currently combining. `food.tsx` keeps
   * one `{ meal, selected }` slot for the whole day, so at most one card is
   * ever `selecting` at a time. The five combine props default to
   * undefined/no-op-shaped so every existing caller (and every test written
   * before N115) keeps compiling and rendering exactly as before.
   */
  selecting?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  onStartCombine?: () => void;
  onCancelCombine?: () => void;
  onConfirmCombine?: () => void;
  testID?: string;
}) {
  const hasEntries = entries.length > 0;
  const { foodUnit } = useUnits();
  const accent = useAccent();
  const selectedCount = selectedIds?.size ?? 0;
  // Local, not derived from props — see the doc comment above for why the
  // default is unconditionally expanded, and why `food.tsx` keys this card on
  // the day so a manual collapse does not survive a day switch.
  const [expanded, setExpanded] = useState(true);
  // Selecting forces the section open — collapsing away rows the athlete is
  // mid-selection on is confusing, and the Combine link itself is only ever
  // offered while expanded (below), so this mainly guards the header's own
  // toggle from closing a section combine-select is already using.
  const effectiveExpanded = selecting || expanded;

  return (
    <RNView style={styles.card} testID={testID}>
      <RNView style={styles.headerRow}>
        <Pressable
          style={styles.headerToggle}
          onPress={() => {
            if (!selecting) setExpanded((e) => !e);
          }}
          accessibilityRole="button"
          // The STATE is carried by `accessibilityState` alone, below — not
          // duplicated in the label too. **frontend-reviewer, N468 review**:
          // a label reading "Breakfast, expanded" next to
          // `accessibilityState={{ expanded }}` had VoiceOver announcing the
          // same fact twice on one control (this app's own `TrackerCard`
          // states the identical rule for its glyph's `checked` state — "the
          // LABEL is what carries the state" was true there because iOS
          // ignores `checked` on a plain button role; a toggle role like this
          // one, which iOS DOES read `expanded` from, is the one case where
          // the state prop is the single source and the label must not repeat
          // it).
          accessibilityLabel={label}
          accessibilityHint="Toggles whether this meal's items are shown"
          accessibilityState={{ expanded: effectiveExpanded }}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <Text style={styles.header} testID={testID ? `${testID}-header` : undefined}>
            {hasEntries ? `${label} · ${fmtAmount(totals.kcal)} kcal` : label}
          </Text>
          <Icon name={effectiveExpanded ? 'chevron-down' : 'chevron'} size={13} color={vola.textDim} />
        </Pressable>
        {/* Two or more rows only — combining one thing with nothing is not a
            meal, it is the entry that is already there. Offered only while
            expanded: starting a selection on rows the section is currently
            hiding makes no sense. */}
        {effectiveExpanded && !selecting && entries.length >= 2 && onStartCombine ? (
          <Pressable
            onPress={onStartCombine}
            accessibilityRole="button"
            accessibilityLabel={`Combine entries in ${label}`}
            testID={testID ? `${testID}-combine-start` : undefined}
          >
            <Text style={[styles.combineLink, { color: addColor }]}>Combine</Text>
          </Pressable>
        ) : null}
      </RNView>

      {effectiveExpanded && (
        <>
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

          {entries.map((e) => {
            const isSelected = selecting && !!selectedIds?.has(e.id);
            return (
              <SwipeToDelete
                key={e.id}
                onDelete={() => onDelete(e.id)}
                accessibilityLabel={e.name}
                enabled={!selecting}
                closeOn={entries.length}
                testID={`food-entry-${e.id}`}
              >
                <Pressable
                  style={styles.row}
                  onPress={() => (selecting ? onToggleSelect?.(e.id) : onEntryPress(e.id))}
                  // Selecting: a checkbox, not a button — `{ checked }` is what
                  // announces "toggleable, currently on/off" rather than the
                  // generic "button, selected" a `selected` state on a button
                  // role reads as. Found in review.
                  accessibilityRole={selecting ? 'checkbox' : 'button'}
                  accessibilityLabel={`${e.name}, ${Math.round(e.kcal)} calories`}
                  accessibilityState={selecting ? { checked: isSelected } : undefined}
                  testID={selecting ? `food-entry-${e.id}-select` : undefined}
                >
                  {selecting ? (
                    <RNView
                      style={[
                        styles.checkbox,
                        isSelected && { backgroundColor: addColor, borderColor: addColor },
                      ]}
                      accessibilityElementsHidden
                      importantForAccessibility="no"
                    >
                      {isSelected ? (
                        <Text style={[styles.checkboxTick, { color: accent.on }]}>✓</Text>
                      ) : null}
                    </RNView>
                  ) : (
                    <Text style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no">
                      {glyphFor(e.category)}
                    </Text>
                  )}
                  <RNView style={styles.rowMain}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {e.name}
                    </Text>
                    <Text style={styles.rowServing}>{loggedAmountLabel(e.servings, e.serving_label, foodUnit)}</Text>
                  </RNView>
                  <Text style={styles.rowKcal}>{Math.round(e.kcal)}</Text>
                </Pressable>
              </SwipeToDelete>
            );
          })}
        </>
      )}

      {selecting ? (
        <RNView style={styles.combineBar} testID={testID ? `${testID}-combine-bar` : undefined}>
          <Pressable
            onPress={onCancelCombine}
            style={styles.combineCancel}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Cancel combining"
            testID={testID ? `${testID}-combine-cancel` : undefined}
          >
            <Text style={styles.combineCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={onConfirmCombine}
            disabled={selectedCount < 2}
            accessibilityRole="button"
            accessibilityState={{ disabled: selectedCount < 2 }}
            accessibilityLabel={
              selectedCount < 2
                ? 'Combine into a meal — select at least two entries first'
                : `Combine ${selectedCount} entries into a meal`
            }
            style={[
              styles.combineConfirm,
              { backgroundColor: addColor },
              selectedCount < 2 && styles.combineConfirmOff,
            ]}
            testID={testID ? `${testID}-combine-confirm` : undefined}
          >
            <Text style={[styles.combineConfirmText, { color: accent.on }]}>
              {selectedCount < 2 ? 'Combine into a meal' : `Combine ${selectedCount} into a meal`}
            </Text>
          </Pressable>
        </RNView>
      ) : (
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
      )}
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
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headerToggle: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  header: { fontSize: 15, fontWeight: '700' },
  combineLink: { fontSize: 13, fontWeight: '600' },
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

  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxTick: { fontSize: 12, fontWeight: '700' },

  add: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    paddingVertical: 6,
  },
  addText: { fontSize: 13, fontWeight: '600', color: vola.textMuted },

  combineBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 2 },
  combineCancel: { paddingVertical: 10, paddingHorizontal: 4 },
  combineCancelText: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
  combineConfirm: { flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  combineConfirmOff: { opacity: 0.4 },
  combineConfirmText: { fontSize: 13, fontWeight: '700' },
});
