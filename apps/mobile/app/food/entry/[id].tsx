/**
 * Correct one logged entry.
 *
 * ## What this screen may change, and what it may not
 *
 * Servings, meal slot and the numbers themselves. It does NOT reach back into
 * the saved food the entry came from: `source_food_id` is provenance, and a
 * correction here is a correction to what was eaten, not to the athlete's
 * catalog. Editing the food instead would silently rewrite every day it has
 * ever appeared on — the one rule the whole module is built around.
 *
 * ## Servings drive the numbers, until you touch a number
 *
 * The common correction is "that was one and a half, not one", so changing
 * servings rescales the macros from the per-serving figures the entry already
 * carries. Type into a macro field and that link is cut for the rest of the
 * edit: an explicit number always beats a derived one, and re-deriving under
 * the cursor is how a form fights its user.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { editEntry, localEntry, removeEntry } from '@/lib/foodLog';
import { MEALS, rescale, type Entry, type Meal } from '@/lib/nutrition';
import { request } from '@/lib/sync';

/** The four editable numbers, in the order a packet prints them. */
const FIELDS = [
  ['kcal', 'Calories'],
  ['protein_g', 'Protein (g)'],
  ['carb_g', 'Carbs (g)'],
  ['fat_g', 'Fat (g)'],
] as const;

type Key = (typeof FIELDS)[number][0];

export default function EditEntryScreen() {
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [entry, setEntry] = useState<Entry | null>(null);
  const [missing, setMissing] = useState(false);
  const [meal, setMeal] = useState<Meal>('lunch');
  const [servings, setServings] = useState('1');
  const [draft, setDraft] = useState<Record<string, string>>({});
  // Once a macro is typed, servings stop rescaling. See the docstring.
  const [manual, setManual] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userId || !id) return;
    let live = true;
    localEntry(userId, id)
      .then((e) => {
        if (!live) return;
        if (!e) {
          setMissing(true);
          return;
        }
        setEntry(e);
        setMeal(e.meal);
        setServings(String(e.servings));
        setDraft({
          kcal: String(round(e.kcal)),
          protein_g: String(round(e.protein_g)),
          carb_g: String(round(e.carb_g)),
          fat_g: String(round(e.fat_g)),
          fibre_g: e.fibre_g == null ? '' : String(round(e.fibre_g)),
        });
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [userId, id]);

  /**
   * Rescale from the entry's own PER-SERVING figures rather than from what is
   * currently in the fields. Scaling the displayed numbers would compound the
   * rounding every time the stepper moved.
   */
  const setServingCount = useCallback(
    (next: string) => {
      setServings(next);
      if (manual || !entry) return;
      const n = parse(next);
      if (!(n > 0)) return;
      const m = rescale(entry, n);
      setDraft((d) => ({
        ...d,
        kcal: String(m.kcal),
        protein_g: String(m.protein_g),
        carb_g: String(m.carb_g),
        fat_g: String(m.fat_g),
        fibre_g: m.fibre_g == null ? (d.fibre_g ?? '') : String(m.fibre_g),
      }));
    },
    [entry, manual],
  );

  if (missing) {
    return (
      <View style={styles.gone}>
        <Stack.Screen options={{ title: 'Entry' }} />
        <Text style={styles.goneText}>This entry is no longer here.</Text>
      </View>
    );
  }
  if (!entry) {
    return (
      <View style={styles.gone}>
        <Stack.Screen options={{ title: 'Entry' }} />
        <Text style={styles.goneText}>Loading…</Text>
      </View>
    );
  }

  const save = async () => {
    if (!userId || saving) return;
    const n = parse(servings);
    setSaving(true);
    try {
      await editEntry(userId, entry.id, {
        eaten_on: entry.eaten_on,
        meal,
        name: entry.name,
        servings: n > 0 ? n : entry.servings,
        serving_label: entry.serving_label,
        kcal: parse(draft.kcal),
        protein_g: parse(draft.protein_g),
        carb_g: parse(draft.carb_g),
        fat_g: parse(draft.fat_g),
        // Blank stays absent. Clearing the field is "I never recorded this",
        // which is not the same claim as zero grams of fibre.
        fibre_g: draft.fibre_g?.trim() ? parse(draft.fibre_g) : null,
        source_food_id: entry.source_food_id,
        notes: entry.notes,
      });
      request('food edited');
      router.back();
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: entry.name }} />

      <Text style={styles.serving}>
        {entry.serving_label} · logged {entry.eaten_on}
      </Text>

      <View style={styles.slots}>
        {MEALS.map((m) => {
          const on = m === meal;
          return (
            <Pressable
              key={m}
              onPress={() => setMeal(m)}
              style={[styles.slotPill, on && { backgroundColor: accent.accent }]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={mealLabel(m)}
              testID={`edit-slot-${m}`}
            >
              <Text style={[styles.slotText, on && { color: accent.on }]}>{mealLabel(m)}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Servings</Text>
        <View style={styles.stepRow}>
          {['0.5', '1', '1.5', '2'].map((s) => (
            <Pressable
              key={s}
              onPress={() => setServingCount(s)}
              style={[styles.chip, servings === s && { borderColor: accent.accent }]}
              accessibilityRole="button"
              accessibilityState={{ selected: servings === s }}
              accessibilityLabel={`${s} servings`}
              testID={`edit-servings-${s}`}
            >
              <Text style={styles.chipText}>{s}</Text>
            </Pressable>
          ))}
          <TextInput
            style={[styles.input, styles.stepInput]}
            value={servings}
            onChangeText={setServingCount}
            keyboardType="decimal-pad"
            inputMode="decimal"
            accessibilityLabel="Servings"
            testID="edit-servings"
          />
        </View>
      </View>

      <View style={styles.macros}>
        {FIELDS.map(([key, label]) => (
          <View key={key} style={styles.macroField}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
              style={styles.input}
              value={draft[key] ?? ''}
              onChangeText={(t) => {
                setManual(true);
                setDraft((d) => ({ ...d, [key as Key]: t }));
              }}
              keyboardType="decimal-pad"
              inputMode="decimal"
              placeholder="—"
              placeholderTextColor={vola.textDim}
              accessibilityLabel={label}
              testID={`edit-${key}`}
            />
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => void save()}
          style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Save"
          testID="edit-save"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>
            {saving ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            if (!userId) return;
            await removeEntry(userId, entry.id);
            request('food deleted');
            router.back();
          }}
          style={styles.secondary}
          accessibilityRole="button"
          accessibilityLabel="Delete this entry"
          testID="edit-delete"
        >
          <Text style={styles.secondaryText}>Delete</Text>
        </Pressable>
      </View>
    </KeyboardAwareScrollView>
  );
}

/** Blank, a stray comma, or nonsense reads as 0 rather than NaN. */
function parse(raw: string | undefined): number {
  const n = Number(raw?.trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** One decimal at most: nobody corrects a lunch to a tenth of a gram. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function mealLabel(m: Meal): string {
  return m === 'snack' ? 'Snacks' : m[0].toUpperCase() + m.slice(1);
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
  gone: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  goneText: { fontSize: 14, color: vola.textMuted },
  serving: { fontSize: 12, color: vola.textDim },
  slots: { flexDirection: 'row', gap: 8 },
  slotPill: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
  },
  slotText: { fontSize: 12, fontWeight: '600', color: vola.textMuted },
  field: { gap: 6 },
  fieldLabel: { fontSize: 12, color: vola.textDim, fontWeight: '600' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
  },
  chipText: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
  stepInput: { flex: 1, minWidth: 70 },
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
  secondary: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
  },
  secondaryText: { fontSize: 13, color: vola.textMuted, fontWeight: '600' },
});
