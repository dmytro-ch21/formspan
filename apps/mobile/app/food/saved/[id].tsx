/**
 * Correct a SAVED FOOD — the thing future logs are made from.
 *
 * ## Why this screen exists (N114)
 *
 * Confirming an AI draft now stores the food, so the next entry of it is
 * reused rather than re-generated. That is only an improvement if a wrong
 * number can be fixed: a stored mistake is worse than a fresh guess, because it
 * comes back with the athlete's own authority behind it and stops asking to be
 * checked. This is where it gets fixed.
 *
 * ## The one rule this screen must not break
 *
 * **Correcting a food changes what you eat NEXT. It does not change what you
 * ate.** An entry stores the numbers it was logged with, and `source_food_id`
 * is provenance that nothing ever reads nutrition back through — see the
 * nutrition module's package doc, which spends a paragraph on why the tempting
 * join would silently rewrite every average an athlete has ever looked at.
 *
 * That is stated on the screen rather than only in this comment, because "does
 * this rewrite last month?" is the first thing an athlete wonders when they
 * change a saved figure, and a rule they cannot see is one they have to guess.
 *
 * ## Per serving, always
 *
 * These numbers are what ONE serving contains — unlike the entry editor next
 * door, where they are the total for the quantity eaten. The two screens look
 * alike and mean different things, so the unit is on the label of every field
 * rather than inferred from the heading.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { ShareToFriend } from '@/components/ShareToFriend';
import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { foodSyncState, localFood, saveFoodLocally } from '@/lib/foodLog';
import type { Food } from '@/lib/nutrition';
import { shareBlockedReason } from '@/lib/shares';
import { request } from '@/lib/sync';

/** The four numbers, in the order a packet prints them. */
const FIELDS = [
  ['kcal', 'Calories per serving'],
  ['protein_g', 'Protein (g) per serving'],
  ['carb_g', 'Carbs (g) per serving'],
  ['fat_g', 'Fat (g) per serving'],
] as const;

export default function EditSavedFoodScreen() {
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [food, setFood] = useState<Food | null>(null);
  const [missing, setMissing] = useState(false);
  /**
   * Set when the id turns out to name a recipe — see the effect below.
   *
   * **A declarative `<Redirect>` rather than `router.replace()` in the effect**,
   * and that is not style. `useRouter()` returns a NEW object on every render,
   * so a `router.replace` whose effect lists `router` as a dependency
   * re-navigates on every render forever: the first attempt at this guard
   * OOM-ed the test runner rather than failing, which is the loop showing up as
   * a crash instead of an assertion. Rendering a redirect has no dependency to
   * get wrong.
   */
  const [sendToRecipe, setSendToRecipe] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [servingLabel, setServingLabel] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // N116/#505. Set on any edit, cleared on load and on a successful save —
  // sharing sends what the SERVER holds, and an athlete mid-correction on
  // this exact screen is the one case that is never true.
  const [touched, setTouched] = useState(false);
  const [shareSync, setShareSync] = useState<{ unsynced: boolean; owed: boolean } | null>(null);

  useEffect(() => {
    if (!userId || !id) return;
    let live = true;
    localFood(userId, id)
      .then((f) => {
        if (!live) return;
        if (!f) {
          setMissing(true);
          return;
        }
        // **A RECIPE MUST NOT BE EDITED HERE (N87), and the guard belongs on
        // this screen rather than on each caller.**
        //
        // This form knows about per-serving macros and nothing about a yield or
        // an ingredient list, so saving a recipe through it writes an empty
        // `items` and a null `yield_servings` — the local upsert replaces both
        // rather than COALESCEing them, deliberately, because that is the only
        // way an athlete can take an ingredient OUT of a recipe. The push then
        // sends `kind: 'recipe'` with no yield, the server refuses it 400, and
        // `classify` reads a 400 as permanent: `dirty` is cleared and the
        // correction is gone. The athlete never saw the ingredient list they
        // just destroyed.
        //
        // `add.tsx` routes recipes away from here too, which avoids the bounce.
        // This is the backstop, and it is the half that matters: review found a
        // SECOND caller — `describe.tsx`'s "fix these numbers for next time",
        // which passes whatever `savedmatch` returned, and the server's saved
        // match really does return recipes (`TestReusingARecipeGivesOnePortionOfIt`
        // pins that). A per-caller guard is one somebody forgets to add.
        if (f.kind === 'recipe') {
          setSendToRecipe(f.id);
          return;
        }
        setFood(f);
        setName(f.name);
        setServingLabel(f.serving_label);
        setDraft({
          kcal: String(round(f.kcal)),
          protein_g: String(round(f.protein_g)),
          carb_g: String(round(f.carb_g)),
          fat_g: String(round(f.fat_g)),
          fibre_g: f.fibre_g == null ? '' : String(round(f.fibre_g)),
        });
        setTouched(false);
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [userId, id]);

  // N116/#505 — same reasoning as the entry screen's own copy of this
  // effect: sync flags can change (a background push landing) without any
  // of `food`'s own fields changing.
  useEffect(() => {
    if (!userId || !id) return;
    let live = true;
    foodSyncState(userId, id).then((s) => {
      if (live) setShareSync(s);
    });
    return () => {
      live = false;
    };
  }, [userId, id]);

  const save = useCallback(async () => {
    if (!userId || !food || saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      // Checked here rather than left to the server, because the outbox would
      // accept it locally, fail the push with a 400, and the athlete would be
      // three screens away by the time anything said so.
      setProblem('Give it a name — that is what a later entry of it matches on.');
      return;
    }
    // **A malformed number is REFUSED, not coerced to zero** — and this screen
    // is the one place that matters most. `parse` reads "12..5" or a stray
    // paste as 0, and a stored 0 kcal comes back with the athlete's own
    // authority behind it, on the row every future log is made from. The entry
    // editor next door can afford the coercion; a saved food cannot. Raised in
    // review.
    const bad = ['kcal', 'protein_g', 'carb_g', 'fat_g', 'fibre_g'].find(
      (k) => !readable(draft[k]),
    );
    if (bad) {
      setProblem('One of those numbers cannot be read. Fix it, or clear it to leave it unrecorded.');
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await saveFoodLocally(userId, {
        // The SAME id, so this is an update rather than a second food. A new id
        // would leave the athlete with two rows under one name and make the
        // next reuse a choice between them.
        id: food.id,
        kind: food.kind,
        name: trimmed,
        brand: food.brand,
        serving_label: servingLabel.trim() || food.serving_label,
        serving_grams: food.serving_grams,
        kcal: parse(draft.kcal),
        protein_g: parse(draft.protein_g),
        carb_g: parse(draft.carb_g),
        fat_g: parse(draft.fat_g),
        // Blank stays absent. Clearing the field means "I never recorded this",
        // which is not the claim that this food contains no fibre.
        fibre_g: draft.fibre_g?.trim() ? parse(draft.fibre_g) : null,
        // This screen has no fields for the N52 label macros, and unlike
        // `source` below the local upsert writes these with `excluded.*`, not
        // a COALESCE — so sending null here would BLANK them, not leave them
        // alone. Carried through from the stored food instead, which is the
        // `updateWithin` trap this repo has paid for three times on a
        // different table, avoided here by never sending a value this screen
        // did not read.
        saturated_fat_g: food.saturated_fat_g,
        sugar_g: food.sugar_g,
        added_sugar_g: food.added_sugar_g,
        sodium_mg: food.sodium_mg,
        cholesterol_mg: food.cholesterol_mg,
        // **DELIBERATELY NOT SENT.** An unstated source means "keep what is
        // stored" all the way down — here, in the local upsert, and in the
        // server's own ON CONFLICT clause. Sending `food.source` back would
        // work today and would be the exact shape that has silently blanked
        // authored data three times in this repo: a field a screen does not
        // own, restated by a screen that happens to have read it.
      });
      setTouched(false);
      request('saved food corrected');
      router.back();
    } catch {
      setProblem('That could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  }, [userId, food, saving, name, servingLabel, draft, router]);

  // Before `missing`, and before the form: a recipe must never render this
  // screen even for one frame. See the note on `sendToRecipe`.
  if (sendToRecipe) {
    return <Redirect href={{ pathname: '/food/recipe/[id]', params: { id: sendToRecipe } }} />;
  }

  if (missing) {
    return (
      <View style={styles.gone}>
        <Stack.Screen options={{ title: 'Saved food' }} />
        <Text style={styles.goneText} testID="saved-missing">
          This food is not saved on this device.
        </Text>
      </View>
    );
  }
  if (!food) {
    return (
      <View style={styles.gone}>
        <Stack.Screen options={{ title: 'Saved food' }} />
        <Text style={styles.goneText}>Loading…</Text>
      </View>
    );
  }

  // N116/#505 — same reasoning as the entry screen: unknown reads as
  // blocked, not permitted.
  const blockedFromSharing = shareSync
    ? shareBlockedReason({ ...shareSync, unsavedOnScreen: touched })
    : 'Loading…';

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: food.name }} />

      {/* THE RULE, ON THE SCREEN. See the docstring — an athlete changing a
          stored calorie figure wants to know whether last month moves, and the
          answer has to be readable rather than trusted. */}
      <Text style={styles.rule} testID="saved-scope">
        These numbers are what one serving contains, and they apply to what you
        log from now on. Days you have already logged keep the numbers they were
        logged with — a log is what you ate that day.
      </Text>

      {food.source === 'ai' ? (
        <Text style={styles.provenance} testID="saved-provenance">
          Drafted by AI, not measured. Worth checking against the packet.
        </Text>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={(t) => {
            setName(t);
            setTouched(true);
          }}
          accessibilityLabel="Name"
          testID="saved-name"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>What one serving is</Text>
        <TextInput
          style={styles.input}
          value={servingLabel}
          onChangeText={(t) => {
            setServingLabel(t);
            setTouched(true);
          }}
          placeholder="100 g"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="What one serving is"
          testID="saved-serving"
        />
      </View>

      <View style={styles.macros}>
        {FIELDS.map(([key, label]) => (
          <View key={key} style={styles.macroField}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
              style={styles.input}
              value={draft[key] ?? ''}
              onChangeText={(t) => {
                setDraft((d) => ({ ...d, [key]: t }));
                setTouched(true);
              }}
              keyboardType="decimal-pad"
              inputMode="decimal"
              placeholder="—"
              placeholderTextColor={vola.textDim}
              accessibilityLabel={label}
              testID={`saved-${key}`}
            />
          </View>
        ))}
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Fibre (g) per serving — blank if you do not know</Text>
        <TextInput
          style={styles.input}
          value={draft.fibre_g ?? ''}
          onChangeText={(t) => {
            setDraft((d) => ({ ...d, fibre_g: t }));
            setTouched(true);
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="—"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Fibre in grams per serving"
          testID="saved-fibre_g"
        />
      </View>

      {problem ? (
        <Text style={styles.problem} testID="saved-problem">
          {problem}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={() => void save()}
          style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Save"
          disabled={saving}
          accessibilityState={{ disabled: saving }}
          testID="saved-save"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>
            {saving ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
        {/* N116/#505. The receiver gets their own copy of this saved food,
            independently editable — see nutrition/share.go's FoodCopier. */}
        <ShareToFriend
          resourceType="nutrition_food"
          resourceId={food.id}
          disabled={blockedFromSharing !== null}
          disabledReason={blockedFromSharing ?? undefined}
          testID="saved-share-open"
        />
      </View>
    </KeyboardAwareScrollView>
  );
}

/**
 * Whether a field holds something this screen may save.
 *
 * Blank is fine — it means "not recorded", which is a real state for fibre and
 * reads as 0 for the four required macros. Anything non-blank has to be an
 * actual non-negative number; `parse` below would silently turn it into 0.
 */
function readable(raw: string | undefined): boolean {
  const t = raw?.trim() ?? '';
  if (t === '') return true;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n >= 0;
}

/** Blank, a stray comma, or nonsense reads as 0 rather than NaN. */
function parse(raw: string | undefined): number {
  const n = Number(raw?.trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** One decimal at most: nobody corrects a food to a tenth of a gram. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
  gone: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  goneText: { fontSize: 14, color: vola.textMuted, textAlign: 'center' },
  rule: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  provenance: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  problem: { fontSize: 13, color: vola.danger, lineHeight: 18 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 12, color: vola.textDim, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: vola.text,
    fontSize: 15,
  },
  macros: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  macroField: { flexBasis: '47%', flexGrow: 1, gap: 6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  primary: {
    minHeight: 46,
    paddingHorizontal: 22,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
});
