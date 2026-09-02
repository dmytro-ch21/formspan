/**
 * Combine several logged entries into one named meal (N115/#504).
 *
 * "I had a shake so I added milk, protein, berries, ice cream — we should be
 * able to squash them all in one if we want to" — the reported issue,
 * verbatim. This screen is that squash.
 *
 * ## What Save actually does
 *
 * Three things, in order, and all three are what makes this "combine" rather
 * than "save a template":
 *
 * 1. Saves a new recipe — `kind: 'recipe'`, `yield_servings: 1` — whose items
 *    are the selected entries, copied via {@link itemFromEntry}. Fixed at one
 *    serving on purpose: this is not "makes 4 portions" like the recipe editor
 *    next door, it is "this is what I ate as one unit", so there is no yield
 *    to ask about and "one portion" and "the sum of the parts" are the same
 *    number — which is what makes the total on this screen directly checkable
 *    against the rows above it.
 * 2. Logs ONE new entry for that recipe, at today's — or rather, the
 *    selection's own — day and meal slot.
 * 3. Deletes the entries it was built from.
 *
 * That replaces the four rows with one, which is what the athlete's own words
 * ask for ("squash them all in one"), not merely a saved template sitting
 * alongside four untouched rows. The new recipe is still a normal saved food
 * afterward — reachable, editable and re-loggable from `food/saved`, exactly
 * like any other.
 *
 * ## Reversible, on the day it happened
 *
 * Deleting the originals is not permanent: `food/entry/[id]` offers "Split
 * into separate entries" on a combined entry logged TODAY, which rebuilds them
 * from the recipe's own items via {@link entriesFromRecipeItems}. See that
 * screen for why the offer is same-day only.
 *
 * ## Selection is scoped to one meal section
 *
 * `MealCard`'s combine mode never lets two different sections' rows into one
 * selection, so `meal` here is a single value, not a per-entry field — the
 * ticket's own wording is "select entries IN A SECTION".
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { combineEntries, localEntries } from '@/lib/foodLog';
import { fmtAmount, MEALS, type Entry, type Meal } from '@/lib/nutrition';
import {
  draftToFood,
  itemFromEntry,
  problemMessage,
  recipeProblem,
  type RecipeDraft,
} from '@/lib/recipe';
import { request } from '@/lib/sync';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; entries: Entry[] }
  /** Fewer than two of the selected ids resolved — one was deleted from under
   *  this screen (another tab, another device) between selecting and getting
   *  here. Rare, and worth saying plainly rather than combining one thing
   *  with nothing. */
  | { status: 'too_few' };

/** Module-scoped so it is the SAME array on every render — see its call site. */
const EMPTY_ENTRIES: Entry[] = [];

export default function CombineScreen() {
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const { date, meal, ids } = useLocalSearchParams<{ date: string; meal: string; ids: string }>();

  const idSet = useMemo(() => new Set((ids ?? '').split(',').filter(Boolean)), [ids]);
  // The only caller of this route is `food.tsx`, which always sends a real
  // slot — but a route param is still an external input, and an unvalidated
  // one written straight to `logFood` would 400 permanently on push (see
  // `add.tsx`'s identical guard). Checked once, up front, rather than
  // trusted through to `combine()`.
  const mealValid = MEALS.includes(meal as Meal);

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [name, setName] = useState('');
  const [servingLabel, setServingLabel] = useState('1 serving');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // `mealValid` is checked here too, not just at the render branch below —
    // an invalid `meal` must never start the async fetch, or a slow one
    // resolving afterward could still call `setLoad({ status: 'ready' })`
    // over a screen that has already refused to proceed.
    if (!userId || !date || !mealValid) return;
    let live = true;
    void localEntries(userId, date).then((rows) => {
      if (!live) return;
      const matched = rows.filter((e) => idSet.has(e.id));
      setLoad(matched.length >= 2 ? { status: 'ready', entries: matched } : { status: 'too_few' });
    });
    return () => {
      live = false;
    };
    // `idSet` IS in the deps, not excluded: it is `useMemo(() => ..., [ids])`
    // (below), so its identity only changes when the route param itself does
    // — a fixed value for the life of this screen. No disable comment needed.
  }, [userId, date, idSet, mealValid]);

  // A stable empty array rather than a fresh `[]` literal for the "not
  // ready" branch — a new array every render would make `items` below
  // recompute on every render regardless of `load` actually changing.
  const entries = load.status === 'ready' ? load.entries : EMPTY_ENTRIES;
  const items = useMemo(() => entries.map(itemFromEntry), [entries]);

  const draft: RecipeDraft = useMemo(
    () => ({ name, brand: '', serving_label: servingLabel, yield_servings: 1, items }),
    [name, servingLabel, items],
  );
  const problem = load.status === 'ready' ? recipeProblem(draft) : null;
  // One serving of a one-serving recipe IS the sum of its items — computed
  // once here rather than separately in the render and in `combine()`, so
  // the number shown and the number saved can never be two calls that could
  // drift apart.
  const preview = useMemo(() => draftToFood(draft), [draft]);

  const combine = async () => {
    if (!userId || !date || !meal || load.status !== 'ready' || problem || saving) return;
    setSaving(true);
    try {
      const food = preview;
      // `combineEntries` is the ATOMIC version of "save the food, log one
      // entry, delete the originals" — see its own doc comment in
      // `foodLog.ts` for why three separate awaits here was a correctness
      // gap (a mid-loop failure or a retry after one could double-count the
      // day), found in review.
      await combineEntries(userId, {
        food,
        entry: {
          eaten_on: date,
          meal: meal as Meal,
          name: food.name,
          servings: 1,
          serving_label: food.serving_label,
          kcal: food.kcal,
          protein_g: food.protein_g,
          carb_g: food.carb_g,
          fat_g: food.fat_g,
          fibre_g: food.fibre_g,
          saturated_fat_g: food.saturated_fat_g,
          sugar_g: food.sugar_g,
          added_sugar_g: food.added_sugar_g,
          sodium_mg: food.sodium_mg,
          cholesterol_mg: food.cholesterol_mg,
          category: null,
          notes: '',
        },
        removeIds: load.entries.map((e) => e.id),
      });
      request('meal combined');
      router.back();
    } finally {
      setSaving(false);
    }
  };

  // `!mealValid` checked BEFORE `load.status === 'loading'`, and folded into
  // the SAME branch as "too few resolved" — both are "this screen cannot
  // honestly proceed". `mealValid` is derived straight from route params
  // with no async step, so it is knowable on the very first render; ordered
  // first here for that reason, rather than set via a `setLoad` call from
  // the effect above, which would be a synchronous setState with nothing to
  // actually wait for — the cascading-render pattern this codebase's own
  // lint rule holds a line against (`react-hooks/set-state-in-effect`).
  if (!mealValid || load.status === 'too_few') {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Combine into a meal' }} />
        <Text style={styles.note} testID="combine-too-few">
          Some of what you selected is no longer here — go back and select again.
        </Text>
      </View>
    );
  }

  if (load.status === 'loading') {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Combine into a meal' }} />
        <Text style={styles.note} testID="combine-loading">
          Loading…
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Combine into a meal' }} />

      <Text style={styles.intro} testID="combine-intro">
        These {entries.length} entries become one saved meal, logged once today.
        The separate rows they came from are removed — you can split it back
        into them again any time today.
      </Text>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Protein shake"
          placeholderTextColor={vola.textDim}
          style={styles.input}
          accessibilityLabel="Name"
          testID="combine-name"
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>One serving is</Text>
        <TextInput
          value={servingLabel}
          onChangeText={setServingLabel}
          placeholder="1 serving"
          placeholderTextColor={vola.textDim}
          style={styles.input}
          accessibilityLabel="One serving is"
          testID="combine-serving-label"
        />
      </View>

      <SectionHeader label="Made of" />
      {items.map((it, i) => (
        <View key={`${it.name}-${i}`} style={styles.itemRow} testID={`combine-item-${i}`}>
          <View style={styles.itemMain}>
            <Text style={styles.itemName} numberOfLines={2}>
              {it.name}
            </Text>
            <Text style={styles.itemMacros}>
              {fmtAmount(it.protein_g * it.quantity)}P · {fmtAmount(it.carb_g * it.quantity)}C ·{' '}
              {fmtAmount(it.fat_g * it.quantity)}F
            </Text>
          </View>
          <Text style={styles.itemKcal}>{fmtAmount(it.kcal * it.quantity)} kcal</Text>
        </View>
      ))}

      {/* The arithmetic, visible: every row above sums to this one — the
          failure this ticket names by name is a total nobody can check. Every
          macro the label carries, not just calories — the AC says "macros",
          plural. */}
      <View style={styles.totalRow} testID="combine-total">
        <View style={styles.itemMain}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.itemMacros}>
            {fmtAmount(preview.protein_g)}P · {fmtAmount(preview.carb_g)}C · {fmtAmount(preview.fat_g)}F
          </Text>
        </View>
        <Text style={styles.totalKcal}>{fmtAmount(preview.kcal)} kcal</Text>
      </View>

      {problem ? (
        <Text style={styles.problem} testID="combine-problem">
          {problemMessage(problem)}
        </Text>
      ) : null}

      <Pressable
        onPress={() => void combine()}
        disabled={!!problem || saving}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!problem || saving }}
        style={[styles.save, (!!problem || saving) && styles.saveOff, { backgroundColor: accent.accent }]}
        testID="combine-save"
      >
        <Text style={[styles.saveText, { color: accent.on }]}>
          {saving ? 'Combining…' : 'Combine & log'}
        </Text>
      </Pressable>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 48, gap: 4 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  note: { fontSize: 14, color: vola.textMuted, textAlign: 'center' },
  intro: { fontSize: 13, color: vola.textMuted, lineHeight: 19, paddingBottom: 10 },
  field: { gap: 6, marginBottom: 12 },
  fieldLabel: { fontSize: 13, color: vola.textMuted },
  input: {
    fontSize: 16,
    color: vola.text,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.lineSoft,
    backgroundColor: vola.surface,
    marginBottom: 8,
  },
  itemMain: { flex: 1, gap: 2 },
  itemName: { fontSize: 14, fontWeight: '600' },
  itemMacros: { fontSize: 12, color: vola.textDim },
  itemKcal: { fontSize: 13, color: vola.textMuted },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  totalLabel: { fontSize: 15, fontWeight: '700' },
  totalKcal: { fontSize: 20, fontWeight: '800' },
  problem: { fontSize: 13, color: vola.warn, lineHeight: 19, paddingBottom: 8 },
  save: { borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  saveOff: { opacity: 0.4 },
  saveText: { fontSize: 16, fontWeight: '700' },
});
