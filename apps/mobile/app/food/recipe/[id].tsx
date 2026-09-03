/**
 * Build or correct a recipe, on the phone (N87).
 *
 * Multi-ingredient recipes were web-only. The meal an athlete eats most often
 * is the one they assemble themselves, so the one they could not describe was
 * the one they cook every week — they logged four separate foods, or gave up.
 * That is what the mobile-first rule forbids: a capability may be richer on
 * web, it may not be only there.
 *
 * # What happens to a meal already logged, when the recipe is edited
 *
 * **It keeps the numbers it was logged with. Permanently.** The edit changes
 * what the NEXT portion logs and nothing that is already in the diary.
 *
 * That is the same rule `nutrition_entries` has always followed — a logged row
 * owns its numbers, `source_food_id` is provenance, and no query that returns
 * nutrition may follow it — applied one level up. The alternative is genuinely
 * tempting: recompute a logged entry from its recipe and a typo fixed today
 * would fix every meal it ever spoiled. It is refused because the same
 * mechanism, pointed at the ordinary case, silently restates every day the
 * athlete has already used to judge whether their cut is working — and leaves
 * nothing to compare against, so nothing would ever look wrong.
 *
 * A third option was considered and refused too: **versioning** the recipe, so
 * old entries keep pointing at the version they were logged from. It answers
 * the same question copying already answers — the entry HAS its numbers,
 * nothing needs to point anywhere — and it charges the athlete a list full of
 * versions they never asked for.
 *
 * So the screen says so, out loud, where an author can see it. Somebody who
 * assumes a correction propagates is wrong about their own history, and the
 * moment to tell them is while they are editing.
 *
 * # Why this is not the web editor with smaller margins
 *
 * `apps/web`'s `RecipeEditor` composes an ingredient by typing a name and five
 * macro numbers by hand — because when it was built there was no catalog to
 * search, and a thin food picker then would have been something N42 had to
 * replace rather than land in. There are 12,651 foods and 29,634 household
 * portions now, and **this screen is the first consumer of that for authoring**:
 * an ingredient is searched for and weighed, not transcribed. Typing the
 * numbers stays available, because a catalog with an honest not-found answer
 * still has to let somebody add what it does not have.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { ShareToFriend } from '@/components/ShareToFriend';
import { SwipeToDelete } from '@/components/SwipeToDelete';
import { Text } from '@/components/Themed';
import { IngredientPicker } from '@/components/food/IngredientPicker';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { foodSyncState, localFood, saveFoodLocally } from '@/lib/foodLog';
import type { Food, RecipeItem } from '@/lib/nutrition';
import {
  draftToFood,
  perServing,
  problemMessage,
  recipeProblem,
  type RecipeDraft,
} from '@/lib/recipe';
import { shareBlockedReason } from '@/lib/shares';
import { request } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * What we know about the recipe being edited.
 *
 * **Four states, and `loading` is a state rather than the absence of one.** A
 * union with three would make "we have not looked yet" indistinguishable from
 * "it is not here", and the screen would tell somebody their recipe was gone
 * during the millisecond before SQLite answered. That collapse has shipped
 * twice in this app in a single day, in two different screens, and a recipe
 * loaded by id has exactly its shape.
 *
 * `missing` is reachable and real: a recipe deleted on the web, or a stale
 * link. It is deliberately NOT folded into `fresh` — silently opening a blank
 * editor would have the athlete rebuild a recipe under the id of one that no
 * longer exists, and never learn the first one had gone.
 */
type Load =
  | { status: 'loading' }
  | { status: 'fresh' }
  | { status: 'editing'; food: Food }
  | { status: 'missing' };

export default function RecipeScreen() {
  const { id, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const getToken = useAuthToken();

  // **`fresh` is known at RENDER time, so it is the initial state rather than
  // something an effect sets.** Setting it inside the effect worked and cost a
  // cascading render on the commonest path — every new recipe — and the lint
  // rule that flags it is the one this app holds at a fixed budget. A route
  // param is fixed for the life of a screen, so seeding `useState` from it is
  // correct as well as cheaper.
  const [load, setLoad] = useState<Load>(
    fresh === '1' ? { status: 'fresh' } : { status: 'loading' },
  );
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [servingLabel, setServingLabel] = useState('1 portion');
  const [yieldText, setYieldText] = useState('4');
  const [items, setItems] = useState<RecipeItem[]>([]);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  // N116/#505 — same reasoning as the plain-food editor's copy of this pair:
  // `touched` covers this screen's own unsaved edits, `shareSync` covers
  // what the server has (or has not) confirmed.
  const [touched, setTouched] = useState(false);
  const [shareSync, setShareSync] = useState<{ unsynced: boolean; owed: boolean } | null>(null);

  useEffect(() => {
    if (!userId || !id) return;
    // `fresh` is an explicit route parameter rather than something inferred
    // from "the id is not in the database". Inferring it is what makes a
    // deleted recipe reopen as a blank form under its own id.
    if (fresh === '1') return;
    let live = true;
    void localFood(userId, id).then((food) => {
      if (!live) return;
      if (!food || food.kind !== 'recipe') {
        setLoad({ status: 'missing' });
        return;
      }
      setLoad({ status: 'editing', food });
      setName(food.name);
      setNote(food.brand);
      setServingLabel(food.serving_label);
      setYieldText(String(food.yield_servings ?? 4));
      setItems(food.items);
      setTouched(false);
    });
    return () => {
      live = false;
    };
  }, [userId, id, fresh]);

  useEffect(() => {
    if (!userId || !id || fresh === '1') return;
    let live = true;
    foodSyncState(userId, id).then((s) => {
      if (live) setShareSync(s);
    });
    return () => {
      live = false;
    };
  }, [userId, id, fresh]);

  const yieldServings = useMemo(() => {
    const n = Number(yieldText.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }, [yieldText]);

  const draft: RecipeDraft = useMemo(
    () => ({ name, brand: note, serving_label: servingLabel, yield_servings: yieldServings, items }),
    [name, note, servingLabel, yieldServings, items],
  );

  const per = useMemo(() => perServing(items, yieldServings), [items, yieldServings]);
  const problem = recipeProblem(draft);

  // N116/#505. A `fresh` (never-saved) recipe has nothing on the server to
  // share yet — the button below renders only for `editing`, so this is
  // never read in that state.
  const blockedFromSharing = shareSync
    ? shareBlockedReason({ ...shareSync, unsavedOnScreen: touched })
    : 'Loading…';

  const save = useCallback(async () => {
    if (!userId || !id || problem || saving) return;
    setSaving(true);
    try {
      await saveFoodLocally(userId, { ...draftToFood(draft), id });
      setTouched(false);
      // Fire and forget, like every other write here: awaiting the push would
      // put the network between the tap and the recipe existing, and it already
      // exists — locally, which is where it is read from.
      request('recipe saved');
      router.back();
    } finally {
      setSaving(false);
    }
  }, [userId, id, problem, saving, draft, router]);

  if (load.status === 'loading') {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Recipe' }} />
        <Text style={styles.note} testID="recipe-loading">
          Loading…
        </Text>
      </View>
    );
  }

  if (load.status === 'missing') {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Recipe' }} />
        <Text style={styles.note} testID="recipe-missing">
          That recipe is not on this phone. It may have been deleted, or it may
          not have synced yet.
        </Text>
      </View>
    );
  }

  if (picking && userId) {
    return (
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
        <Stack.Screen options={{ title: 'Add an ingredient' }} />
        <IngredientPicker
          userId={userId}
          getToken={getToken}
          onCancel={() => setPicking(false)}
          onPick={(item) => {
            setItems((cur) => [...cur, item]);
            setTouched(true);
            setPicking(false);
          }}
        />
      </KeyboardAwareScrollView>
    );
  }

  return (
    <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
      <Stack.Screen
        options={{ title: load.status === 'fresh' ? 'New recipe' : 'Edit recipe' }}
      />

      <Field
        label="Recipe"
        value={name}
        onChangeText={(t) => {
          setName(t);
          setTouched(true);
        }}
        placeholder="Chicken and rice traybake"
        testID="recipe-name"
      />
      <Field
        label="Note"
        value={note}
        onChangeText={(t) => {
          setNote(t);
          setTouched(true);
        }}
        placeholder="Optional"
        testID="recipe-note"
      />
      <Field
        label="Makes how many portions"
        value={yieldText}
        onChangeText={(t) => {
          setYieldText(t);
          setTouched(true);
        }}
        placeholder="4"
        numeric
        testID="recipe-yield"
      />
      <Field
        label="One portion is"
        value={servingLabel}
        onChangeText={(t) => {
          setServingLabel(t);
          setTouched(true);
        }}
        placeholder="1 portion"
        testID="recipe-serving-label"
      />

      <SectionHeader label="Ingredients" />
      {items.length === 0 ? (
        <Text style={styles.note} testID="recipe-no-items">
          Nothing in it yet. Add what goes in the pot — the per-portion figures
          below are worked out from these.
        </Text>
      ) : (
        items.map((it, i) => (
          <SwipeToDelete
            // Index-keyed on purpose: an ingredient has no id of its own — the
            // server keys these on `(food_id, position)` — and two identical
            // ingredients are a real thing to put in a recipe.
            key={`${it.name}-${i}`}
            onDelete={() => {
              setItems((cur) => cur.filter((_, j) => j !== i));
              setTouched(true);
            }}
            accessibilityLabel={`Remove ${it.name}`}
            testID={`recipe-item-${i}`}
          >
            <View style={styles.itemRow}>
              <View style={styles.itemMain}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {it.name}
                </Text>
                <Text style={styles.itemSub}>
                  {it.quantity === 1 ? it.serving_label : `${it.quantity} × ${it.serving_label}`}
                </Text>
              </View>
              <Text style={styles.itemKcal}>{Math.round(it.kcal * it.quantity)} kcal</Text>
            </View>
          </SwipeToDelete>
        ))
      )}

      <Pressable
        onPress={() => setPicking(true)}
        accessibilityRole="button"
        accessibilityLabel="Add an ingredient"
        style={[styles.addItem, { borderColor: accent.accent }]}
        testID="recipe-add-item"
      >
        <Text style={[styles.addItemText, { color: accent.ink }]}>+ Add an ingredient</Text>
      </Pressable>

      <SectionHeader label="One portion" />
      <View style={styles.perRow}>
        <Text style={styles.perKcal} testID="recipe-per-kcal">
          {Math.round(per.kcal)} kcal
        </Text>
        <Text style={styles.perMacros} testID="recipe-per-macros">
          {Math.round(per.protein_g)}P · {Math.round(per.carb_g)}C · {Math.round(per.fat_g)}F
          {/* "not stated" rather than 0, and this is the same rule the server
              applies: a recipe whose ingredients never mention fibre is not a
              fibre-free recipe — nobody said. */}
          {per.fibre_g == null ? ' · fibre not stated' : ` · ${Math.round(per.fibre_g)} fibre`}
        </Text>
      </View>

      {/* The propagation note. Said here, where the decision is being made,
          rather than in a help screen nobody opens while cooking. */}
      <Text style={styles.warn} testID="recipe-history-note">
        Meals you have already logged from this recipe keep the numbers they were
        logged with. Editing it changes what the next portion logs.
      </Text>

      {problem ? (
        <Text style={styles.problem} testID="recipe-problem">
          {problemMessage(problem)}
        </Text>
      ) : null}

      <Pressable
        onPress={() => void save()}
        disabled={!!problem || saving}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!problem || saving }}
        style={[styles.save, (!!problem || saving) && styles.saveOff, { backgroundColor: accent.accent }]}
        testID="recipe-save"
      >
        <Text style={[styles.saveText, { color: accent.on }]}>
          {load.status === 'fresh' ? 'Save recipe' : 'Save changes'}
        </Text>
      </Pressable>

      {/* N116/#505. Only once there is a saved row to send — a `fresh`
          recipe has nothing on the server yet. Accepting stores this as the
          receiver's OWN saved meal (AC4), independent of this one — see
          nutrition/share.go's FoodCopier. */}
      {load.status === 'editing' ? (
        <View style={styles.shareRow}>
          <ShareToFriend
            resourceType="nutrition_food"
            resourceId={load.food.id}
            disabled={blockedFromSharing !== null}
            disabledReason={blockedFromSharing ?? undefined}
            testID="recipe-share-open"
          />
        </View>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  numeric,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  numeric?: boolean;
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={vola.textDim}
        // Text state, never a number. Round-tripping through `Number` on every
        // keystroke deletes the decimal point out from under the cursor.
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        inputMode={numeric ? 'decimal' : 'text'}
        style={styles.input}
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 48, gap: 4 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
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
  itemName: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  itemSub: { fontSize: 12, color: vola.textDim },
  itemKcal: { fontSize: 13, color: vola.textMuted },
  addItem: {
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 8,
  },
  addItemText: { fontSize: 15, fontWeight: '600' },
  perRow: { gap: 4, paddingVertical: 8 },
  perKcal: { fontSize: 28, fontWeight: '700' },
  perMacros: { fontSize: 13, color: vola.textMuted },
  warn: { fontSize: 12, color: vola.textDim, lineHeight: 18, paddingVertical: 10 },
  problem: { fontSize: 13, color: vola.warn, lineHeight: 19, paddingBottom: 8 },
  note: { fontSize: 13, color: vola.textMuted, lineHeight: 19, paddingVertical: 8 },
  save: { borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  saveOff: { opacity: 0.4 },
  saveText: { fontSize: 16, fontWeight: '700' },
  shareRow: { marginTop: 12, alignItems: 'center' },
});
