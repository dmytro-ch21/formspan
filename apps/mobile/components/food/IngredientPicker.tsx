/**
 * Choosing one ingredient for a recipe (N87).
 *
 * Two sources, kept as two sections, exactly as the quick-add sheet keeps them
 * — and for the same three reasons. A saved food carries the athlete's OWN
 * serving size while a catalog row carries a reference one; a saved food can
 * record provenance when it is used and a catalog row cannot, because
 * `source_food_id` is a foreign key into the personal table and a catalog slug
 * lives in a different id space; and merging them would hide which of the two
 * a tap is about to add, when the two contribute different numbers.
 *
 * # An empty answer has five meanings and only one is about the food
 *
 * The catalog answers with an `outcome`, not just an array, and this screen
 * renders a different sentence for each. `no_match` is the only one that
 * licenses "we do not have that food"; `catalog_empty` is OUR failure and
 * reporting it as a missing food would send the athlete off to type their whole
 * recipe by hand while nothing surfaced the real cause. A transport failure is
 * a sixth case that sits outside the enum — it throws, so it can never be
 * rendered as an empty catalog.
 *
 * **And the empty state keys on the ANSWER's emptiness, not on the deduped
 * list.** Gating on the post-dedupe count is a bug this repo has already
 * shipped and fixed once: when every catalog row collides with something the
 * athlete has already saved — the mainline case for anyone with common foods —
 * an `ok` answer fell through to the failure copy and said "the catalog could
 * not answer that one" directly beneath the saved row that had just answered
 * it.
 *
 * keyboard-container: provided by parent — this renders a search field and a
 * quantity field and provides no scroll container of its own. Its only mount
 * point is `app/food/recipe/[id].tsx`, which wraps it in the shared
 * `KeyboardAwareScrollView`; a second container here would nest two scroll
 * views and break the one that works. **If this ever gains a second caller,
 * that caller has to provide the container too** — the claim this marker makes
 * is about where the component is mounted, not about the component.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { FoodQuantity } from '@/components/FoodQuantity';
import { CatalogCard, spokenName } from '@/components/food/CatalogCard';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  emptySearchMessage,
  fetchCatalogFood,
  searchCatalog,
  type CatalogFood,
  type CatalogSearch,
} from '@/lib/catalogApi';
import { localFoods } from '@/lib/foodLog';
import type { Food, RecipeItem } from '@/lib/nutrition';
import { clampName, itemFromCatalog, itemFromSavedFood } from '@/lib/recipe';
import type { TokenGetter } from '@/lib/useAuthToken';

/**
 * The by-hand ingredient form, as data.
 *
 * A table rather than eight copies of the same JSX, so a field cannot pick up a
 * different keyboard or lose its `testID` by being edited in only one place.
 */
const MANUAL_FIELDS: { key: string; label: string; placeholder: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Ingredient', placeholder: "Nan's tomato sauce" },
  { key: 'quantity', label: 'How many', placeholder: '1', numeric: true },
  { key: 'serving_label', label: 'Of what', placeholder: '100 g' },
  { key: 'kcal', label: 'Calories in one', placeholder: '—', numeric: true },
  { key: 'protein_g', label: 'Protein in one', placeholder: '—', numeric: true },
  { key: 'carb_g', label: 'Carbs in one', placeholder: '—', numeric: true },
  { key: 'fat_g', label: 'Fat in one', placeholder: '—', numeric: true },
  { key: 'fibre_g', label: 'Fibre in one (optional)', placeholder: 'Not stated', numeric: true },
];

/** The answer to the query that is currently typed, or nothing yet. */
type CatalogState = { forQuery: string; result: CatalogSearch | 'unreachable' };

/** The key two food lists are deduped on — brand AND name, lowercased. */
function foodKey(brand: string, name: string): string {
  return `${brand.trim().toLowerCase()}|${name.trim().toLowerCase()}`;
}

export function IngredientPicker({
  userId,
  getToken,
  onPick,
  onCancel,
}: {
  userId: string;
  getToken: TokenGetter;
  onPick: (item: RecipeItem) => void;
  onCancel: () => void;
}) {
  const accent = useAccent();
  const [q, setQ] = useState('');
  const [mine, setMine] = useState<Food[]>([]);
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [searching, setSearching] = useState(false);
  /** A catalog food whose weight is being chosen. */
  const [picking, setPicking] = useState<CatalogFood | null>(null);
  /** A saved food whose quantity is being chosen, with the typed quantity. */
  const [savedPick, setSavedPick] = useState<{ food: Food; text: string } | null>(null);
  /**
   * An ingredient being typed out by hand.
   *
   * **Not a fallback for when search fails — a first-class route.** A catalog
   * of 12,651 foods still does not contain somebody's grandmother's sauce, and
   * a recipe builder that can only compose things we already know about is not
   * one an athlete can put their own cooking into. Without it the only way out
   * of a `no_match` is to leave for the quick-add sheet and create the food
   * there — which LOGS it as a meal on the way past, a side effect nobody
   * assembling a recipe wants.
   *
   * Text, never numbers: round-tripping a draft through `Number` on every
   * keystroke deletes the decimal point out from under the cursor.
   */
  const [manual, setManual] = useState<Record<string, string> | null>(null);

  const searched = q.trim();

  // The athlete's own foods, straight out of SQLite — instant on every
  // keystroke, no debounce and no network. Recipes are excluded: a recipe
  // inside a recipe would need the server to derive one from the other's
  // derived figures, and nothing models that. A saved plain food is the unit
  // this composes from.
  useEffect(() => {
    let live = true;
    void localFoods(userId, searched).then((rows) => {
      if (live) setMine(rows.filter((f) => f.kind !== 'recipe'));
    });
    return () => {
      live = false;
    };
  }, [userId, searched]);

  // The catalog, debounced. Everything including the empty-query reset happens
  // INSIDE the timer — a synchronous setState in an effect body trips the
  // `set-state-in-effect` rule this app holds at a fixed budget.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      if (!live) return;
      if (!searched) {
        setCatalog(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      searchCatalog(getToken, { q: searched, limit: 20 })
        .then((result) => {
          if (live) setCatalog({ forQuery: searched, result });
        })
        .catch(() => {
          // A throw is NOT an empty catalog. Rendering it as one would tell the
          // athlete we do not stock a food we simply could not ask about.
          if (live) setCatalog({ forQuery: searched, result: 'unreachable' });
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [getToken, searched]);

  // Only ever render an answer to the query that is CURRENTLY typed. Without
  // this the results for "chi" flash under "chicken breast" as each request
  // lands out of order.
  const answer = catalog && catalog.forQuery === searched ? catalog.result : null;

  const catalogOnly = useMemo(() => {
    if (!answer || answer === 'unreachable') return [];
    const seen = new Set(mine.map((f) => foodKey(f.brand, f.name)));
    // Deduped on NAME AND BRAND rather than on id — the two id spaces can never
    // collide, so an id dedupe would silently do nothing. Brand is in the key
    // because on name alone a brandless saved "Greek Yogurt" suppresses every
    // branded one in the catalog, which is the opposite of what dedupe is for.
    return answer.foods.filter((f) => !seen.has(foodKey(f.brand, f.name)));
  }, [answer, mine]);

  const openCatalog = useCallback(
    async (food: CatalogFood) => {
      // Shown immediately from the search row, then upgraded with `portions`,
      // which search results deliberately do not carry. A failed upgrade is
      // swallowed: grams are always offered regardless.
      setPicking(food);
      try {
        const full = await fetchCatalogFood(getToken, food.id);
        setPicking((cur) => (cur && cur.id === full.id ? full : cur));
      } catch {
        /* the row we already have is enough to weigh something */
      }
    },
    [getToken],
  );

  if (picking) {
    return (
      <View style={styles.wrap}>
        <Pressable
          onPress={() => setPicking(null)}
          accessibilityRole="button"
          accessibilityLabel="Back to the ingredient search"
          testID="ingredient-quantity-cancel"
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <FoodQuantity
          food={picking}
          cta="Add to recipe"
          onLog={(grams) => {
            onPick(itemFromCatalog(picking, grams));
            setPicking(null);
          }}
        />
      </View>
    );
  }

  if (savedPick) {
    const n = Number(savedPick.text.replace(',', '.'));
    const valid = Number.isFinite(n) && n > 0 && n < 10000;
    return (
      <View style={styles.wrap}>
        <Pressable
          onPress={() => setSavedPick(null)}
          accessibilityRole="button"
          accessibilityLabel="Back to the ingredient search"
          testID="ingredient-saved-cancel"
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.pickName}>{savedPick.food.name}</Text>
        <Text style={styles.hint}>How many × {savedPick.food.serving_label}?</Text>
        <TextInput
          value={savedPick.text}
          onChangeText={(text) => setSavedPick((cur) => (cur ? { ...cur, text } : cur))}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="—"
          placeholderTextColor={vola.textDim}
          style={styles.qtyInput}
          accessibilityLabel="How many servings"
          testID="ingredient-saved-quantity"
        />
        <Pressable
          onPress={() => {
            if (!valid) return;
            onPick(itemFromSavedFood(savedPick.food, n));
            setSavedPick(null);
          }}
          disabled={!valid}
          accessibilityRole="button"
          accessibilityState={{ disabled: !valid }}
          style={[styles.add, !valid && styles.addOff, { backgroundColor: accent.accent }]}
          testID="ingredient-saved-add"
        >
          <Text style={[styles.addText, { color: accent.on }]}>Add to recipe</Text>
        </Pressable>
      </View>
    );
  }

  if (manual) {
    const num = (k: string) => Number((manual[k] ?? '').replace(',', '.'));
    const ok = (k: string) => Number.isFinite(num(k)) && num(k) >= 0;
    const qty = num('quantity');
    const valid =
      manual.name.trim() !== ''
      && manual.serving_label.trim() !== ''
      && Number.isFinite(qty) && qty > 0 && qty < 10000
      && ['kcal', 'protein_g', 'carb_g', 'fat_g'].every(ok)
      // Fibre may be left blank — "not stated" is a real answer and is not the
      // same as zero. Only a value that cannot be read is a problem.
      && (manual.fibre_g.trim() === '' || ok('fibre_g'));

    return (
      <View style={styles.wrap}>
        <Pressable
          onPress={() => setManual(null)}
          accessibilityRole="button"
          accessibilityLabel="Back to the ingredient search"
          testID="ingredient-manual-cancel"
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.hint}>
          The numbers for ONE of what you name below — the quantity multiplies them.
        </Text>
        {MANUAL_FIELDS.map((f) => (
          <View key={f.key} style={styles.manualField}>
            <Text style={styles.manualLabel}>{f.label}</Text>
            <TextInput
              value={manual[f.key]}
              onChangeText={(t) => setManual((cur) => (cur ? { ...cur, [f.key]: t } : cur))}
              keyboardType={f.numeric ? 'decimal-pad' : 'default'}
              inputMode={f.numeric ? 'decimal' : 'text'}
              placeholder={f.placeholder}
              placeholderTextColor={vola.textDim}
              style={styles.manualInput}
              accessibilityLabel={f.label}
              testID={`ingredient-manual-${f.key}`}
            />
          </View>
        ))}
        <Pressable
          onPress={() => {
            if (!valid) return;
            onPick({
              name: clampName(manual.name),
              quantity: qty,
              serving_label: manual.serving_label.trim(),
              kcal: num('kcal'),
              protein_g: num('protein_g'),
              carb_g: num('carb_g'),
              fat_g: num('fat_g'),
              fibre_g: manual.fibre_g.trim() === '' ? null : num('fibre_g'),
              // Nothing to point at: this ingredient came from the athlete's
              // head, not from a row anything else owns.
              source_food_id: null,
            });
            setManual(null);
          }}
          disabled={!valid}
          accessibilityRole="button"
          accessibilityState={{ disabled: !valid }}
          style={[styles.add, !valid && styles.addOff, { backgroundColor: accent.accent }]}
          testID="ingredient-manual-add"
        >
          <Text style={[styles.addText, { color: accent.on }]}>Add to recipe</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Back to the recipe"
        testID="ingredient-cancel"
      >
        <Text style={styles.back}>← Back to the recipe</Text>
      </Pressable>

      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Search for an ingredient"
        placeholderTextColor={vola.textDim}
        autoCorrect={false}
        style={styles.search}
        accessibilityLabel="Search for an ingredient"
        testID="ingredient-search"
      />

      {mine.length > 0 ? (
        <>
          <SectionHeader label="Your saved foods" />
          {mine.map((f) => (
            <Pressable
              key={f.id}
              style={styles.savedRow}
              onPress={() => setSavedPick({ food: f, text: '1' })}
              accessibilityRole="button"
              accessibilityLabel={`Add ${f.name} to the recipe`}
              testID={`ingredient-mine-${f.id}`}
            >
              <View style={styles.savedMain}>
                <Text style={styles.savedName} numberOfLines={2}>
                  {f.name}
                </Text>
                <Text style={styles.savedServing}>
                  {Math.round(f.kcal)} cals per {f.serving_label}
                </Text>
              </View>
            </Pressable>
          ))}
        </>
      ) : null}

      {searched && catalogOnly.length > 0 ? (
        <>
          <SectionHeader label="From the food catalog" />
          {catalogOnly.map((f) => (
            <CatalogCard
              key={f.id}
              food={f}
              testIDPrefix="ingredient-catalog"
              onOpen={() => void openCatalog(f)}
              openLabel={`Choose how much ${spokenName(f)} goes in the recipe`}
              // **No `+` circle here, deliberately.** On the quick-add sheet the
              // circle is a one-tap log at the food's reference serving, which
              // is a sensible default for a meal. There is no such default for
              // an ingredient — "some chicken" is not a recipe — so a circle
              // would either guess 100 g silently or do nothing. An affordance
              // that guesses is worse than one that is absent.
            />
          ))}
          {answer && answer !== 'unreachable' && answer.total > catalogOnly.length ? (
            <Text style={styles.note} testID="ingredient-catalog-more">
              Showing {catalogOnly.length} of {answer.total}. Keep typing to narrow it.
            </Text>
          ) : null}
        </>
      ) : null}

      {/* The five-meanings block. Gated on the ANSWER being empty rather than on
          the deduped list, so a query the catalog answered perfectly well —
          every row of which the athlete had already saved — renders nothing
          here instead of a failure message. */}
      {searched && answer && !searching && (answer === 'unreachable' || answer.foods.length === 0) ? (
        <Text style={styles.note} testID="ingredient-empty">
          {answer === 'unreachable'
            ? 'Could not reach the food catalog. Your own saved foods are still searched.'
            : emptySearchMessage(answer, searched)}
        </Text>
      ) : null}

      {/* "Nothing typed yet" is its OWN state, and it is not the same as "we
          looked and found nothing". Saying "no ingredients found" over an empty
          search box is the collapse this file exists to avoid. */}
      {!searched && mine.length === 0 ? (
        <Text style={styles.note} testID="ingredient-idle">
          Search the food catalog, or pick from foods you have saved.
        </Text>
      ) : null}

      {/* Always offered, not only after a search comes back empty. Somebody
          adding their own sauce knows the catalog will not have it and should
          not have to prove that first. */}
      <Pressable
        onPress={() =>
          setManual({
            name: searched,
            quantity: '1',
            serving_label: '100 g',
            kcal: '',
            protein_g: '',
            carb_g: '',
            fat_g: '',
            fibre_g: '',
          })
        }
        accessibilityRole="button"
        accessibilityLabel="Add an ingredient by typing its numbers"
        style={styles.byHand}
        testID="ingredient-by-hand"
      >
        <Text style={[styles.byHandText, { color: accent.ink }]}>
          Not in the catalog? Type it in
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, paddingVertical: 8 },
  back: { fontSize: 15, color: vola.textMuted, paddingVertical: 6 },
  search: {
    fontSize: 16,
    color: vola.text,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.lineSoft,
    backgroundColor: vola.surface,
    marginBottom: 8,
  },
  savedMain: { flex: 1, gap: 2 },
  savedName: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  savedServing: { fontSize: 12, color: vola.textDim },
  note: { fontSize: 13, color: vola.textMuted, lineHeight: 19, paddingVertical: 8 },
  pickName: { fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 13, color: vola.textMuted },
  qtyInput: {
    fontSize: 22,
    color: vola.text,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  manualField: { gap: 6, marginBottom: 10 },
  manualLabel: { fontSize: 13, color: vola.textMuted },
  manualInput: {
    fontSize: 16,
    color: vola.text,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  byHand: { paddingVertical: 14, alignItems: 'center' },
  byHandText: { fontSize: 14, fontWeight: '600' },
  add: { borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  addOff: { opacity: 0.4 },
  addText: { fontSize: 16, fontWeight: '700' },
});
