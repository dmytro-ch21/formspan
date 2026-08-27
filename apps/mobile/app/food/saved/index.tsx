/**
 * "Saved foods" — the phone half of N79.
 *
 * ## The gap this closes
 *
 * `apps/web`'s `nutrition/recipes` page could list, edit and delete an
 * athlete's own saved things; the phone could create them (`food/add.tsx`,
 * `food/describe.tsx`, the barcode flow — collectively N78) and, since N114,
 * correct one it already knew the id of (`food/saved/[id].tsx`,
 * `food/recipe/[id].tsx`) — but nothing let an athlete BROWSE the whole list
 * or remove one. `deleteFood` in `lib/nutritionApi.ts` had been sitting there
 * since the wire contract was written with a comment saying, literally, "no
 * production caller." This screen is that caller's other half — `removeFood`
 * in `lib/foodLog.ts` is the one that actually calls it, through the same
 * outbox every other mutation here goes through.
 *
 * ## Editing is not duplicated here
 *
 * A row's edit affordance pushes straight to the screens that already do this
 * correctly — `food/saved/[id]` for a plain food, `food/recipe/[id]` for a
 * recipe, exactly the split `food/add.tsx`'s own Edit button uses and for the
 * identical reason (N87): a recipe edited through the plain-food form loses
 * its ingredient list. This screen does not re-implement either editor, it
 * only has to route to the right one.
 *
 * ## Deleting: a hold, not a swipe or a dialog
 *
 * `HoldToConfirm` is what every other irreversible-on-this-screen delete in
 * this app uses (`trackers/archived.tsx`, `curriculum/edit/[id].tsx`) — a
 * screen-reader user gets the tap-and-confirm-dialog fallback it already
 * carries, so this screen does not need a second confirmation path. The body
 * says what survives: a day already logged keeps its own copied numbers,
 * because `source_food_id` is `ON DELETE SET NULL` and an entry never reads
 * nutrition back through it. Same sentence `apps/web`'s recipes page prints
 * under its own list.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View as RNView } from 'react-native';

import { HoldToConfirm } from '@/components/HoldToConfirm';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { localFoods, removeFood } from '@/lib/foodLog';
import type { Food } from '@/lib/nutrition';
import { request as requestSync } from '@/lib/sync';

export default function SavedFoodsScreen() {
  const { userId } = useAuth();
  const router = useRouter();

  const [q, setQ] = useState('');
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (query: string) => {
      if (!userId) return;
      try {
        const rows = await localFoods(userId, query);
        setFoods(rows);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read your saved foods.');
      }
    },
    [userId],
  );

  /**
   * The CURRENT query, read by the focus effect below without being a
   * dependency of it.
   *
   * `useFocusEffect` needs a memoised callback — an unmemoised one would give
   * it a new identity on every render, and its own effect re-runs whenever
   * that identity changes, which turns "reload on focus" into "reload after
   * every keystroke sets state and re-renders": a loop. So the callback can
   * only depend on `load` (stable unless `userId` changes) — and reading `q`
   * from a ref rather than from that closure is what keeps the value current
   * without needing `q` back in the dependency array to get there.
   */
  const qRef = useRef('');
  useEffect(() => {
    qRef.current = q;
  }, [q]);

  // On focus, not on mount — deleting one and coming straight back here has to
  // show the list without it, the same reason `curriculum/index.tsx` reloads
  // on focus rather than once. Reads `qRef` so a search typed before leaving
  // (to edit a row, say) is still the search in effect on the way back.
  useFocusEffect(
    useCallback(() => {
      void load(qRef.current);
    }, [load]),
  );

  async function onSearch(text: string) {
    setQ(text);
    await load(text);
  }

  async function onDelete(f: Food) {
    if (!userId) return;
    try {
      await removeFood(userId, f.id);
      requestSync('saved food deleted');
      setError(null);
      await load(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be deleted.');
    }
  }

  function edit(f: Food) {
    // **A recipe must not open the plain-food editor (N87).** Identical guard
    // to `food/add.tsx`'s own Edit button — see that screen's comment for the
    // failure this prevents.
    if (f.kind === 'recipe') {
      router.push({ pathname: '/food/recipe/[id]', params: { id: f.id } });
    } else {
      router.push({ pathname: '/food/saved/[id]', params: { id: f.id } });
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Saved foods' }} />
      <KeyboardAwareScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          Everything you have saved from logging, describing or scanning — plus
          any recipe you built here or on the web. Edit one to fix a number for
          next time; delete one to clear it off this list. Days you have
          already logged keep the numbers they were logged with.
        </Text>

        <TextInput
          style={styles.search}
          value={q}
          onChangeText={(t) => void onSearch(t)}
          placeholder="Search your saved foods"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Search your saved foods"
          testID="saved-foods-search"
          autoCorrect={false}
          autoCapitalize="none"
        />

        {error ? (
          <Text style={styles.error} accessibilityLiveRegion="polite" testID="saved-foods-error">
            {error}
          </Text>
        ) : null}

        {foods === null && !error ? (
          <ActivityIndicator style={styles.loading} accessibilityLabel="Loading your saved foods" />
        ) : null}

        {foods !== null && foods.length === 0 ? (
          <Text style={styles.empty} testID="saved-foods-empty">
            {q.trim()
              ? 'Nothing saved by that name.'
              : 'Nothing saved yet. Log something once, describe a plate, or scan a barcode, and it will be here to reuse and correct.'}
          </Text>
        ) : null}

        {(foods ?? []).map((f) => (
          <RNView key={f.id} style={styles.card} testID={`saved-foods-row-${f.id}`}>
            <Pressable
              onPress={() => edit(f)}
              style={styles.tap}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${f.name}`}
              testID={`saved-foods-edit-${f.id}`}
            >
              <RNView style={styles.head}>
                <Text style={styles.name} numberOfLines={1}>
                  {f.name}
                </Text>
                {f.kind === 'recipe' ? (
                  <RNView style={styles.badge}>
                    <Text style={styles.badgeText}>Recipe</Text>
                  </RNView>
                ) : null}
              </RNView>
              <Text style={styles.meta}>
                {f.kind === 'recipe'
                  ? `Makes ${f.yield_servings ?? '?'} × ${f.serving_label} · ${f.items.length} ${
                      f.items.length === 1 ? 'ingredient' : 'ingredients'
                    }`
                  : `per ${f.serving_label}`}
                {f.brand ? ` · ${f.brand}` : ''}
              </Text>
              <Text style={styles.macros}>
                {Math.round(f.kcal)} kcal · {Math.round(f.protein_g)}P / {Math.round(f.carb_g)}C /{' '}
                {Math.round(f.fat_g)}F
              </Text>
            </Pressable>

            <HoldToConfirm
              label={`Delete ${f.name}`}
              holdingLabel="Keep holding to delete…"
              onConfirm={() => void onDelete(f)}
              confirmTitle={`Delete ${f.name}?`}
              confirmBody="This removes it from your saved list. Days you have already logged it on keep the numbers they were logged with — a logged entry owns its own numbers."
              destructive
              fillColor={vola.danger}
              style={styles.delete}
              textStyle={styles.deleteText}
              testID={`saved-foods-delete-${f.id}`}
            />
          </RNView>
        ))}
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  container: { padding: 16, gap: 12, paddingBottom: 60 },
  intro: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  search: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: vola.text,
    fontSize: 15,
  },
  error: { color: vola.danger, fontSize: 13 },
  loading: { marginTop: 24 },
  empty: { fontSize: 13, color: vola.textMuted, lineHeight: 19, paddingVertical: 16 },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 8,
  },
  tap: { gap: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 15, fontWeight: '700', color: vola.text, flexShrink: 1 },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: vola.line,
  },
  badgeText: { fontSize: 10, fontWeight: '700', color: vola.textMuted },
  meta: { fontSize: 12, color: vola.textDim },
  macros: { fontSize: 13, color: vola.textMuted },
  delete: { alignItems: 'center', paddingVertical: 10, marginTop: 2 },
  deleteText: { color: vola.danger, fontWeight: '600', fontSize: 13 },
});
