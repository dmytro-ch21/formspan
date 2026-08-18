/**
 * Log something.
 *
 * ## The two-tap repeat
 *
 * The sheet opens with the KEYBOARD DOWN and NOTHING FOCUSED, showing recents
 * ranked for this slot and read straight from SQLite. Tap a row, it is logged.
 * That is the whole interaction for the common case, and it is why the ranking
 * lives in `rankRecents` rather than being "most recent first" — porridge
 * should top breakfast and not appear at dinner.
 *
 * Auto-focusing the search field would replace two taps with a keyboard, a
 * scroll and a decision, on a screen an athlete opens six times a day.
 *
 * ## The escape row
 *
 * Typing something with no match offers `Add "chicken thigh"` as the last row,
 * prefilled. There is no external food database in this build, so the sheet
 * must never imply one — it searches the athlete's own saved foods and nothing
 * else.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { localFoods, logFood, recentsFor, saveFoodLocally } from '@/lib/foodLog';
import {
  MEALS,
  atwater,
  kcalLooksOff,
  rankRecents,
  scale,
  slotForClock,
  todayString,
  type Food,
  type Meal,
} from '@/lib/nutrition';
import { request } from '@/lib/sync';

export default function AddFoodScreen() {
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();

  const date = params.date ?? todayString();
  const [meal, setMeal] = useState<Meal>(
    MEALS.includes(params.meal as Meal) ? (params.meal as Meal) : slotForClock(new Date()),
  );
  const [q, setQ] = useState('');
  const [recents, setRecents] = useState<Food[]>([]);
  const [matches, setMatches] = useState<Food[]>([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    if (!userId) return;
    let live = true;
    recentsFor(userId, meal)
      .then((rs) => {
        if (live) setRecents(rankRecents(rs, date));
      })
      .catch(() => {});
    localFoods(userId, q)
      .then((fs) => {
        if (live) setMatches(fs);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, meal, q, date]);

  useEffect(() => load(), [load]);

  const shown = q.trim() ? matches : recents;
  const exact = useMemo(
    () => matches.some((f) => f.name.toLowerCase() === q.trim().toLowerCase()),
    [matches, q],
  );

  const log = useCallback(
    async (food: Food, servings = 1) => {
      if (!userId) return;
      const m = scale(food, servings);
      await logFood(userId, {
        eaten_on: date,
        meal,
        name: food.name,
        servings,
        serving_label: food.serving_label,
        ...m,
        source_food_id: food.id,
      });
      // Fire-and-forget: the row is already local and the screen behind this
      // one reads it locally. Awaiting a push would put the network back
      // between the tap and the number moving.
      request('food logged');
      router.back();
    },
    [userId, date, meal, router],
  );

  if (creating) {
    return (
      <NewFood
        initialName={q.trim()}
        onCancel={() => setCreating(false)}
        onSave={async (draft) => {
          if (!userId) return;
          const id = await saveFoodLocally(userId, draft);
          await log({ ...draft, id }, 1);
        }}
      />
    );
  }

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Add food' }} />

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
              testID={`add-slot-${m}`}
            >
              <Text style={[styles.slotText, on && { color: accent.on }]}>{mealLabel(m)}</Text>
            </Pressable>
          );
        })}
      </View>

      <TextInput
        style={styles.search}
        value={q}
        onChangeText={setQ}
        placeholder="Search your foods"
        placeholderTextColor={vola.textDim}
        autoCorrect={false}
        accessibilityLabel="Search your saved foods"
        testID="add-search"
      />

      <SectionHeader label={q.trim() ? 'Matches' : 'Recent'} />

      {shown.map((f) => (
        <Pressable
          key={f.id}
          style={styles.row}
          onPress={() => void log(f)}
          accessibilityRole="button"
          accessibilityLabel={`Log ${f.name}`}
          testID={`add-food-${f.id}`}
        >
          <View style={styles.rowMain}>
            <Text style={styles.rowName} numberOfLines={1}>
              {f.name}
            </Text>
            <Text style={styles.rowServing}>{f.serving_label}</Text>
          </View>
          <Text style={styles.rowKcal}>{Math.round(f.kcal)}</Text>
        </Pressable>
      ))}

      {shown.length === 0 && (
        <Text style={styles.empty}>
          {q.trim()
            ? 'Nothing saved by that name.'
            : 'Log something once and it will be here next time.'}
        </Text>
      )}

      {q.trim().length > 0 && !exact && (
        <Pressable
          style={styles.newRow}
          onPress={() => setCreating(true)}
          accessibilityRole="button"
          accessibilityLabel={`Add ${q.trim()}`}
          testID="add-new-food"
        >
          <Icon name="plus" size={14} color={accent.ink} />
          <Text style={[styles.newText, { color: accent.ink }]}>Add “{q.trim()}”</Text>
        </Pressable>
      )}
    </KeyboardAwareScrollView>
  );
}

/**
 * A new food, in one screen.
 *
 * Draft state is TEXT, never numbers: a half-typed `81.` is not a number, and
 * round-tripping through `Number` on every keystroke deletes the decimal point
 * out from under the cursor — the same reason the check-in form and the session
 * logger keep their fields as strings.
 */
function NewFood({
  initialName,
  onCancel,
  onSave,
}: {
  initialName: string;
  onCancel: () => void;
  onSave: (draft: Omit<Food, 'id'>) => Promise<void>;
}) {
  const accent = useAccent();
  const [name, setName] = useState(initialName);
  const [servingLabel, setServingLabel] = useState('100 g');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openFibre, setOpenFibre] = useState(false);
  const [saving, setSaving] = useState(false);

  const num = (k: string): number => {
    const raw = draft[k]?.trim().replace(',', '.');
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const macros = { protein_g: num('protein_g'), carb_g: num('carb_g'), fat_g: num('fat_g') };
  const suggested = atwater(macros);
  const kcal = draft.kcal?.trim() ? num('kcal') : suggested;
  const odd = draft.kcal?.trim() ? kcalLooksOff(num('kcal'), macros) : false;

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'New food' }} />

      <Field label="Name" value={name} onChange={setName} testID="new-name" />
      <Field
        label="One serving is"
        value={servingLabel}
        onChange={setServingLabel}
        hint="How you would say it — “100 g”, “1 scoop (30 g)”, “1 egg”."
        testID="new-serving"
      />

      <View style={styles.macros}>
        {(
          [
            ['kcal', 'Calories'],
            ['protein_g', 'Protein (g)'],
            ['carb_g', 'Carbs (g)'],
            ['fat_g', 'Fat (g)'],
          ] as const
        ).map(([key, fieldLabel]) => (
          <View key={key} style={styles.macroField}>
            <Text style={styles.fieldLabel}>{fieldLabel}</Text>
            <TextInput
              style={styles.input}
              value={draft[key] ?? ''}
              onChangeText={(t) => setDraft((d) => ({ ...d, [key]: t }))}
              keyboardType="decimal-pad"
              inputMode="decimal"
              // The Atwater sum fills the calorie field in when the packet does
              // not state one. A PLACEHOLDER, never a value: a stated kcal
              // always wins, because real labels do not reconcile against
              // 4/4/9.
              placeholder={key === 'kcal' && suggested > 0 ? String(Math.round(suggested)) : '—'}
              placeholderTextColor={vola.textDim}
              accessibilityLabel={fieldLabel}
              testID={`new-${key}`}
            />
          </View>
        ))}
      </View>

      {odd && (
        <Text style={styles.nudge}>
          The macros add to {Math.round(suggested)} kcal — worth checking one of these.
        </Text>
      )}

      <Pressable
        onPress={() => setOpenFibre((v) => !v)}
        style={styles.disclose}
        accessibilityRole="button"
        accessibilityState={{ expanded: openFibre }}
        accessibilityLabel="Fibre"
      >
        <Text style={styles.fieldLabel}>Fibre</Text>
        <Icon name={openFibre ? 'chevron-down' : 'chevron'} size={16} color={vola.textMuted} />
      </Pressable>
      {openFibre && (
        <TextInput
          style={styles.input}
          value={draft.fibre_g ?? ''}
          onChangeText={(t) => setDraft((d) => ({ ...d, fibre_g: t }))}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="—"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Fibre in grams"
          testID="new-fibre_g"
        />
      )}

      <View style={styles.actions}>
        <Pressable
          onPress={async () => {
            if (!name.trim() || saving) return;
            setSaving(true);
            try {
              await onSave({
                kind: 'food',
                name: name.trim(),
                brand: '',
                serving_label: servingLabel.trim() || '1 serving',
                serving_grams: null,
                kcal,
                ...macros,
                // Absent, not zero: a food nobody stated fibre for is not
                // claiming there is none.
                fibre_g: draft.fibre_g?.trim() ? num('fibre_g') : null,
              });
            } finally {
              setSaving(false);
            }
          }}
          style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Save and log"
          testID="new-save"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>
            {saving ? 'Saving…' : 'Save and log'}
          </Text>
        </Pressable>
        <Pressable onPress={onCancel} style={styles.secondary} accessibilityRole="button">
          <Text style={styles.secondaryText}>Back</Text>
        </Pressable>
      </View>
    </KeyboardAwareScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        accessibilityLabel={label}
        testID={testID}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function mealLabel(m: Meal): string {
  return m === 'snack' ? 'Snacks' : m[0].toUpperCase() + m.slice(1);
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
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
  search: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: vola.text,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowServing: { fontSize: 12, color: vola.textDim },
  rowKcal: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  empty: { fontSize: 13, color: vola.textMuted, paddingVertical: 8 },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  newText: { fontSize: 14, fontWeight: '600' },
  field: { gap: 6 },
  fieldLabel: { fontSize: 12, color: vola.textDim, fontWeight: '600' },
  hint: { fontSize: 11, color: vola.textDim },
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
  nudge: { fontSize: 12, color: vola.textMuted },
  disclose: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
