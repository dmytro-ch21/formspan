/**
 * One row of the food catalog, as a card (N58).
 *
 * Extracted from `app/food/add.tsx` by N87, which needed the same card for
 * picking a recipe's ingredients. The extraction is the point rather than a
 * tidy-up: this card carries four rules that were each arrived at by being
 * wrong first, and a second hand-written copy of it would drift off every one
 * of them silently.
 *
 * The rules, so they travel with the component:
 *
 * 1. **The glyph comes from the CATEGORY, never the name.** Name matching puts
 *    a steak on "beef-flavoured tofu".
 * 2. **The glyph is hidden from the accessibility tree.** It is decoration —
 *    the name carries the meaning — and "seedling, Beef-flavoured tofu" before
 *    every row is noise in a list that has to be fast to move through. `aria-
 *    hidden` maps to BOTH the iOS and Android strong forms; the weaker Android
 *    prop is invisible to RNTL, so a test claiming to cover it would pass while
 *    the Android half did nothing.
 * 3. **Two lines then truncate.** A USDA description is routinely long and one
 *    line hides the half that distinguishes it from its neighbour.
 * 4. **The brand line is omitted when absent, not rendered empty.** Every
 *    seeded USDA food is generic, so an empty line would be the common case.
 *
 * What is NOT baked in is what a tap DOES. `add.tsx` opens a quantity sheet on
 * the body and logs one reference serving on the `+`; the ingredient picker
 * opens a quantity sheet on both. The labels are props for the same reason — a
 * row that says "Log X" and then opens a sheet is lying to a screen reader.
 */

import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import type { CatalogFood } from '@/lib/catalogApi';
import { glyphFor } from '@/lib/foodGlyph';

export type CatalogCardProps = {
  food: CatalogFood;
  /** Prefix for this surface's testIDs — `add-catalog`, `ingredient`, … */
  testIDPrefix: string;
  /** Body press. */
  onOpen: () => void;
  /** What the body press does, said as an action. */
  openLabel: string;
  /**
   * The trailing circle. **Omit it to render no circle at all** rather than a
   * disabled one — an affordance that does nothing is the thing this codebase
   * refuses elsewhere as "a chip that filters nothing".
   */
  onQuickAdd?: () => void;
  quickAddLabel?: string;
  /** The accent to draw the circle in. Passed in because it is a user setting. */
  accentBorder?: string;
  accentText?: string;
};

/** Calories against the food's OWN serving, never an invented unit. */
export function servingLine(food: CatalogFood): string {
  return `${Math.round(food.kcal)} cals per ${food.serving_label}`;
}

/**
 * The name to SAY, as opposed to the name to show.
 *
 * Brand plus name, unless the name already contains the brand. The row displays
 * the two on separate lines; announcing them joined is what a person would say
 * out loud, and it is also what the log records — a row that reads one thing
 * and files another is a real bug this repo has already fixed once.
 */
export function spokenName(food: CatalogFood): string {
  if (!food.brand) return food.name;
  return food.name.toLowerCase().includes(food.brand.toLowerCase())
    ? food.name
    : `${food.brand} ${food.name}`;
}

export function CatalogCard({
  food,
  testIDPrefix,
  onOpen,
  openLabel,
  onQuickAdd,
  quickAddLabel,
  accentBorder,
  accentText,
}: CatalogCardProps) {
  return (
    <Pressable
      style={styles.card}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={openLabel}
      testID={`${testIDPrefix}-row-${food.id}`}
    >
      <Text style={styles.cardGlyph} testID={`${testIDPrefix}-glyph-${food.id}`} aria-hidden>
        {glyphFor(food.category)}
      </Text>

      <View style={styles.cardMain}>
        <Text style={styles.cardName} numberOfLines={2}>
          {food.name}
        </Text>
        {food.brand ? <Text style={styles.cardBrand}>{food.brand}</Text> : null}
        <Text style={styles.cardServing}>{servingLine(food)}</Text>
      </View>

      {onQuickAdd ? (
        <Pressable
          onPress={onQuickAdd}
          style={[styles.cardAdd, { borderColor: accentBorder }]}
          accessibilityRole="button"
          accessibilityLabel={quickAddLabel}
          // Bigger than it looks. The circle is 32pt and a thumb is not, and it
          // sits at the edge of the screen where a miss scrolls the list.
          hitSlop={10}
          testID={`${testIDPrefix}-${food.id}`}
        >
          <Text style={[styles.cardAddText, { color: accentText }]}>+</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.lineSoft,
    backgroundColor: vola.surface,
    marginBottom: 8,
  },
  cardGlyph: { fontSize: 26 },
  cardMain: { flex: 1, gap: 2 },
  cardName: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  cardBrand: { fontSize: 12, color: vola.textMuted },
  cardServing: { fontSize: 12, color: vola.textDim },
  cardAdd: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardAddText: { fontSize: 20, lineHeight: 22, fontWeight: '600' },
});
