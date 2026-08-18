/**
 * Describe a meal, or photograph it, and correct what comes back.
 *
 * ## The draft is the point, not the estimate
 *
 * Nothing is logged until the athlete taps Log. The rows arrive editable and
 * the two fields that make them correctable — how sure the model is about the
 * PORTION, and the assumption it had to make — are shown next to the numbers
 * rather than hidden behind a disclosure. A confident-looking wrong number is
 * worse than an obviously uncertain one, because the athlete has no reason to
 * check it.
 *
 * ## Why confidence is about quantity only
 *
 * Naming a food is reliable; judging how much of it is on the plate is not.
 * A misnamed food is obvious the moment you read it. A portion wrong by a
 * factor of two is invisible and moves the day's remaining figure by hundreds
 * of calories. So `low` gets a visible mark and the servings field is where
 * the eye is sent.
 *
 * ## The photo disclosure is not fine print
 *
 * A photo leaves the device and goes to a third party. That is stated on the
 * button's own screen, before the camera opens, because a privacy consequence
 * discovered afterwards is not a choice the athlete made.
 */

import { useAuth } from '@clerk/clerk-expo';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  describeMeal,
  itemToEntry,
  photographMeal,
  type EstimateQuota,
  type EstimatedItem,
  type MealEstimate,
} from '@/lib/estimateApi';
import { logFood } from '@/lib/foodLog';
import { MEALS, slotForClock, todayString, type Meal } from '@/lib/nutrition';
import { request as requestSync } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';

export default function DescribeMealScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const params = useLocalSearchParams<{ meal?: string; date?: string; q?: string }>();

  const date = params.date ?? todayString();
  const [meal, setMeal] = useState<Meal>(
    MEALS.includes(params.meal as Meal) ? (params.meal as Meal) : slotForClock(new Date()),
  );

  // Seeded from the quick-add search box: whatever they typed there is
  // already the start of a description, and retyping it is the kind of
  // friction that sends people back to the form.
  const [description, setDescription] = useState(params.q ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<MealEstimate | null>(null);
  const [quota, setQuota] = useState<EstimateQuota | null>(null);
  // Drafted rows the athlete can edit before logging. Held separately from the
  // estimate so the original stays readable — the assumption beside a number
  // makes no sense once the number has been changed.
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [saving, setSaving] = useState(false);

  const receive = useCallback((res: { estimate: MealEstimate; quota: EstimateQuota }) => {
    setEstimate(res.estimate);
    setRows(res.estimate.items.map(toDraft));
    setQuota(res.quota);
  }, []);

  const describe = useCallback(async () => {
    if (!description.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      receive(await describeMeal(getToken, { description: description.trim(), meal }));
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }, [description, busy, getToken, meal, receive]);

  const photograph = useCallback(
    async (fromCamera: boolean) => {
      if (busy) return;
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError(
          fromCamera
            ? 'VOLA needs the camera to photograph a meal.'
            : 'VOLA needs access to your photos to read one.',
        );
        return;
      }
      const picked = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 1 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (picked.canceled || !picked.assets[0]) return;

      setBusy(true);
      setError(null);
      try {
        // Downscaled BEFORE it leaves the phone, which is a cost decision as
        // much as a bandwidth one: image tokens scale with resolution, and a
        // plate of food is legible at 1080px. A raw 4-5MB frame would also
        // exceed the endpoint's own 5MB cap.
        const shrunk = await ImageManipulator.manipulateAsync(
          picked.assets[0].uri,
          [{ resize: { width: 1080 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        receive(
          await photographMeal(getToken, {
            uri: shrunk.uri,
            mimeType: 'image/jpeg',
            description: description.trim() || undefined,
            meal,
          }),
        );
      } catch (err) {
        setError(messageFor(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, description, getToken, meal, receive],
  );

  /**
   * Log every row, then leave.
   *
   * **Each row is dropped as it lands**, so a failure part-way through leaves
   * exactly the un-logged remainder on screen and a second tap logs only
   * those. Without that, a retry would re-log everything that already
   * succeeded — `logFood` mints a fresh id per call, so the outbox's
   * idempotency key does not protect a client-side replay. Raised in review.
   */
  const logAll = useCallback(async () => {
    if (!userId || rows.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      // A copy, because `rows` is trimmed inside the loop.
      for (const row of [...rows]) {
        await logFood(userId, {
          eaten_on: date,
          meal,
          ...itemToEntry(fromDraft(row)),
          // No source_food_id: a draft came from a guess, not from a saved
          // food, so there is no provenance to record. And nothing marks the
          // row as model-drafted — what was eaten is what the athlete
          // confirmed, whoever typed it first.
          source_food_id: null,
        });
        setRows((rs) => rs.filter((r) => r !== row));
      }
      requestSync('meal estimated');
      router.back();
    } catch (err) {
      // Silent failure here would leave the athlete unable to tell what was
      // logged and what was not.
      setError(`${messageFor(err)} The items still listed were not logged.`);
    } finally {
      setSaving(false);
    }
  }, [userId, rows, saving, date, meal, router]);

  const updateRow = (i: number, patch: Partial<DraftRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Describe a meal' }} />

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
              testID={`describe-slot-${m}`}
            >
              <Text style={[styles.slotText, on && { color: accent.on }]}>{mealLabel(m)}</Text>
            </Pressable>
          );
        })}
      </View>

      <TextInput
        style={styles.input}
        value={description}
        onChangeText={setDescription}
        placeholder="Two eggs, sourdough and butter"
        placeholderTextColor={vola.textDim}
        multiline
        maxLength={600}
        accessibilityLabel="Describe what you ate"
        testID="describe-input"
      />

      <Pressable
        onPress={() => void describe()}
        style={[styles.primary, { backgroundColor: accent.accent }, busy && styles.off]}
        accessibilityRole="button"
        accessibilityLabel="Work it out"
        // Dimming is a sighted-only signal. Without the state, a screen reader
        // announces an ordinary button that then does nothing.
        disabled={busy || !description.trim()}
        accessibilityState={{ disabled: busy || !description.trim() }}
        testID="describe-submit"
      >
        <Text style={[styles.primaryText, { color: accent.on }]}>
          {busy ? 'Working it out…' : 'Work it out'}
        </Text>
      </Pressable>

      <SectionHeader label="Or photograph it" />
      {/* Stated BEFORE the camera opens. A privacy consequence discovered
          afterwards is not a choice the athlete made. */}
      <Text style={styles.disclosure}>
        The photo is sent to Anthropic to be read, and is not stored — by VOLA or
        by them. Describing the meal in words works nearly as well and sends no
        picture at all.
      </Text>
      <View style={styles.photoRow}>
        <Pressable
          onPress={() => void photograph(true)}
          style={[styles.secondary, busy && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Take a photo of this meal"
          disabled={busy}
          accessibilityState={{ disabled: busy }}
          testID="describe-camera"
        >
          <Text style={styles.secondaryText}>Take a photo</Text>
        </Pressable>
        <Pressable
          onPress={() => void photograph(false)}
          style={[styles.secondary, busy && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Choose a photo from your library"
          disabled={busy}
          accessibilityState={{ disabled: busy }}
          testID="describe-library"
        >
          <Text style={styles.secondaryText}>Choose one</Text>
        </Pressable>
      </View>

      {busy ? <ActivityIndicator accessibilityLabel="Working it out" /> : null}
      {error ? (
        <Text style={styles.error} testID="describe-error">
          {error}
        </Text>
      ) : null}

      {/* An estimate that came back EMPTY still cost a quota unit, so it has to
          say something. Rendering nothing would look like a screen that
          ignored the tap. The note is where the model says what it could not
          see, which is the useful half. */}
      {estimate && rows.length === 0 ? (
        <Text style={styles.note} testID="describe-empty">
          {estimate.note || 'Nothing recognisable came back. Try describing it instead.'}
        </Text>
      ) : null}

      {estimate && rows.length > 0 ? (
        <>
          <SectionHeader label="Check these before logging" />
          {estimate.note ? <Text style={styles.note}>{estimate.note}</Text> : null}

          {rows.map((row, i) => (
            <View key={`${row.name}-${i}`} style={styles.row}>
              <Text style={styles.rowName}>{row.name}</Text>
              <Text style={styles.rowServing}>{row.serving_label}</Text>

              {/* The assumption sits WITH the number it explains, because it
                  is the thing that tells the athlete which field to fix. */}
              {row.assumption ? (
                <Text style={styles.assumption} testID={`describe-assumption-${i}`}>
                  {row.assumption}
                </Text>
              ) : null}
              {row.portion_confidence === 'low' ? (
                <Text style={styles.uncertain} testID={`describe-uncertain-${i}`}>
                  Unsure how much this was — worth checking
                </Text>
              ) : null}

              <View style={styles.fields}>
                <Field
                  label="Servings"
                  value={row.servingsText}
                  onChange={(v) => updateRow(i, { servingsText: v })}
                  testID={`describe-servings-${i}`}
                />
                <Field
                  label="Calories"
                  value={row.kcalText}
                  onChange={(v) => updateRow(i, { kcalText: v })}
                  testID={`describe-kcal-${i}`}
                />
                <Field
                  label="Protein (g)"
                  value={row.proteinText}
                  onChange={(v) => updateRow(i, { proteinText: v })}
                  testID={`describe-protein-${i}`}
                />
              </View>

              <Pressable
                onPress={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${row.name}`}
                testID={`describe-remove-${i}`}
              >
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>
          ))}

          <Pressable
            onPress={() => void logAll()}
            style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
            accessibilityRole="button"
            accessibilityLabel={`Log ${rows.length} items`}
            disabled={saving}
            accessibilityState={{ disabled: saving }}
            testID="describe-log"
          >
            <Text style={[styles.primaryText, { color: accent.on }]}>
              {saving ? 'Logging…' : `Log ${rows.length === 1 ? 'it' : `all ${rows.length}`}`}
            </Text>
          </Pressable>
        </>
      ) : null}

      {quota ? (
        <Text style={styles.quota} testID="describe-quota">
          {quota.remaining} of {quota.limit} {quota.source === 'photo' ? 'photos' : 'descriptions'}{' '}
          left today
        </Text>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        inputMode="decimal"
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
}

/**
 * A drafted row, whose editable numbers are held as TEXT.
 *
 * **This is the trap the check-in form and the session logger both record, and
 * this screen fell into it anyway.** Round-tripping through `Number` on every
 * keystroke deletes the decimal point out from under the cursor: `"1."` parses
 * to `1`, redisplays as `"1"`, and the next keystroke makes `15` — so an
 * athlete correcting a portion to 1.5 servings silently logs ten times what
 * they meant. Worst in exactly the field a low-confidence warning tells them
 * to fix. Clearing a field the same way collapsed it to `0`, since `Number('')`
 * is `0` and passes a `>= 0` guard. Found by review.
 */
type DraftRow = EstimatedItem & {
  servingsText: string;
  kcalText: string;
  proteinText: string;
};

function toDraft(it: EstimatedItem): DraftRow {
  return {
    ...it,
    servingsText: String(it.servings),
    kcalText: String(Math.round(it.kcal)),
    proteinText: String(Math.round(it.protein_g)),
  };
}

/**
 * Parse the text back, ONCE, at log time.
 *
 * An unparseable or empty field keeps the model's own number rather than
 * becoming zero — a blank calorie box means "I did not change this", not "this
 * meal had no calories".
 */
function fromDraft(row: DraftRow): EstimatedItem {
  return {
    ...row,
    servings: parseOr(row.servingsText, row.servings),
    kcal: parseOr(row.kcalText, row.kcal),
    protein_g: parseOr(row.proteinText, row.protein_g),
  };
}

function parseOr(raw: string, fallback: number): number {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The server's message, which is written for the athlete.
 *
 * Codes are contract and messages are not, so this shows the message rather
 * than mapping the code to copy of its own — the one thing worth saying here
 * that the server cannot is what to do about a network failure.
 */
function messageFor(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Could not reach the server. Try again when you have signal.';
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
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: vola.text,
    fontSize: 15,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  disclosure: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  photoRow: { flexDirection: 'row', gap: 10 },
  error: { fontSize: 13, color: vola.danger, lineHeight: 18 },
  note: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  row: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 12,
    padding: 12,
    gap: 4,
    backgroundColor: vola.surface,
  },
  rowName: { fontSize: 15, fontWeight: '700' },
  rowServing: { fontSize: 12, color: vola.textDim },
  assumption: { fontSize: 12, color: vola.textMuted, fontStyle: 'italic' },
  uncertain: { fontSize: 12, color: vola.textMuted, fontWeight: '600' },
  fields: { flexDirection: 'row', gap: 10, marginTop: 6 },
  field: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 11, color: vola.textDim, fontWeight: '600' },
  fieldInput: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: vola.text,
    fontSize: 14,
  },
  remove: { fontSize: 12, color: vola.textDim, marginTop: 6 },
  quota: { fontSize: 11, color: vola.textDim },
  primary: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  secondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 13, color: vola.textMuted, fontWeight: '600' },
  off: { opacity: 0.5 },
});
