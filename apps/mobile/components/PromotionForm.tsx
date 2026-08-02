import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Belt as BeltView, describeBelt } from '@/components/Belt';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import {
  BELTS,
  MAX_DEGREE,
  MAX_STRIPES,
  createPromotion,
  deletePromotion,
  updatePromotion,
  type Belt,
  type PromotionInput,
  type Rank,
} from '@/lib/bjj';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';

export type EditablePromotion = PromotionInput & { id: string };

/** Matches the server's own `dateLayout` (`2006-01-02`). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Add and edit share one form: the fields are identical, and the only
 * difference is which request goes out on save (and that edit also offers
 * delete). Two screens would be two copies of this drifting apart.
 */
export function PromotionForm({
  initial,
  suggestedRank,
}: {
  initial?: EditablePromotion;
  /** Ignored once `initial` is set — editing shows the row's real values. */
  suggestedRank?: Rank;
}) {
  const getToken = useAuthToken();
  const router = useRouter();
  // Same reasoning as the `/bjj` hub this form is reached from: a stale
  // back-stack entry from before BJJ was turned off must not still let
  // someone add or edit a promotion for a discipline they no longer train.
  const { modules, ready: modulesReady } = useModules();
  const bjjEnabled = modulesReady && modules.some((m) => m.key === 'bjj' && m.enabled);

  const [belt, setBelt] = useState<Belt>(initial?.belt ?? suggestedRank?.belt ?? 'white');
  const [stripes, setStripes] = useState(initial?.stripes ?? suggestedRank?.stripes ?? 0);
  const [degree, setDegree] = useState(initial?.degree ?? suggestedRank?.degree ?? 0);
  const [promotedOn, setPromotedOn] = useState(initial?.promoted_on ?? '');
  const [academy, setAcademy] = useState(initial?.academy ?? '');
  const [instructor, setInstructor] = useState(initial?.instructor ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Degree is only a thing on a black belt — the server rejects one on any
  // other belt, so the field that would produce it is not offered at all
  // rather than offered and then refused.
  const isBlack = belt === 'black';

  async function save() {
    if (saving) return;
    const trimmedDate = promotedOn.trim();
    // Checked here rather than left to the server: a malformed date shares
    // the server's one `invalid_input` sentinel with a bad rank, so a round
    // trip would come back describing belts and stripes — correct advice for
    // a mistake the athlete didn't make. Catching the actual mistake here
    // means the message they see is about the field they actually got wrong.
    if (trimmedDate && !DATE_RE.test(trimmedDate)) {
      setError("Date must be YYYY-MM-DD, or left blank if you don't remember.");
      return;
    }
    setSaving(true);
    setError(null);
    const input: PromotionInput = {
      belt,
      stripes: isBlack ? 0 : stripes,
      degree: isBlack ? degree : 0,
      promoted_on: trimmedDate || null,
      academy: academy.trim(),
      instructor: instructor.trim(),
      note: note.trim(),
    };
    try {
      if (initial) {
        await updatePromotion(getToken, initial.id, input);
      } else {
        await createPromotion(getToken, input);
      }
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  function confirmDelete() {
    if (!initial || saving) return;
    Alert.alert(
      'Delete this promotion?',
      `${describeBelt(initial.belt, initial.stripes, initial.degree)} will be removed from your history. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSaving(true);
            setError(null);
            try {
              await deletePromotion(getToken, initial.id);
              router.back();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setSaving(false);
            }
          },
        },
      ],
    );
  }

  if (modulesReady && !bjjEnabled) {
    return (
      <View style={styles.centre} testID="promotion-form-disabled">
        <Stack.Screen options={{ title: initial ? 'Edit promotion' : 'Add promotion' }} />
        <Text style={styles.centreTitle}>BJJ tracking is off</Text>
        <Text style={styles.centreMuted}>
          Turn it back on under Sports in your profile before recording a promotion.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="promotion-form">
      <Stack.Screen
        options={{
          title: initial ? 'Edit promotion' : 'Add promotion',
          headerRight: () => (
            <Pressable onPress={save} disabled={saving} hitSlop={12} testID="promotion-save">
              <Text style={styles.headerAction}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        // iOS genuinely scrolls the focused field clear of the keyboard with
        // this on — see the extensive note in KeyboardAwareScrollView.tsx for
        // why that component exists for the session screen's same-height
        // number-pad fields and why it explicitly isn't the right tool here:
        // this form's fields are an ordinary top-to-bottom list, which is
        // exactly the case the platform already handles on its own once asked.
        automaticallyAdjustKeyboardInsets
      >
        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}

        <View style={styles.preview}>
          <BeltView belt={belt} stripes={stripes} degree={degree} width={200} />
          <Text style={styles.previewLabel}>{describeBelt(belt, stripes, degree)}</Text>
        </View>

        <Text style={styles.sectionLabel}>Belt</Text>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {BELTS.map((b) => {
            const selected = belt === b;
            return (
              <Pressable
                key={b}
                onPress={() => {
                  setBelt(b);
                  // Only one of these is ever meaningful at a time. Clearing
                  // just the one going out of scope isn't enough — leaving a
                  // stale stripes count behind is invisible in the stepper
                  // (it's hidden once black is picked) but not in the preview
                  // label above, which read "Black belt, 2 stripes" off a
                  // count the belt no longer uses.
                  if (b === 'black') setStripes(0);
                  else setDegree(0);
                }}
                style={[styles.chip, selected && styles.chipActive]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                testID={`promotion-belt-${b}`}
              >
                <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                  {b.charAt(0).toUpperCase() + b.slice(1)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {isBlack ? (
          <Stepper
            label="Degree"
            value={degree}
            max={MAX_DEGREE}
            onChange={setDegree}
            testID="promotion-degree"
          />
        ) : (
          <Stepper
            label="Stripes"
            value={stripes}
            max={MAX_STRIPES}
            onChange={setStripes}
            testID="promotion-stripes"
          />
        )}

        <Field
          label="Date"
          value={promotedOn}
          onChangeText={setPromotedOn}
          placeholder="YYYY-MM-DD — leave blank if you don't remember"
          testID="promotion-date"
        />
        <Field
          label="Academy"
          value={academy}
          onChangeText={setAcademy}
          placeholder="Where"
          testID="promotion-academy"
        />
        <Field
          label="Instructor"
          value={instructor}
          onChangeText={setInstructor}
          placeholder="Who promoted you"
          testID="promotion-instructor"
        />
        <Field
          label="Note"
          value={note}
          onChangeText={setNote}
          placeholder="Anything worth remembering"
          testID="promotion-note"
          multiline
        />

        {initial && (
          <Pressable
            onPress={confirmDelete}
            disabled={saving}
            style={styles.deleteRow}
            accessibilityRole="button"
            testID="promotion-delete"
          >
            <Text style={styles.deleteText}>Delete this promotion</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

function Stepper({
  label,
  value,
  max,
  onChange,
  testID,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (n: number) => void;
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.stepperRow} accessibilityRole="radiogroup">
        {Array.from({ length: max + 1 }, (_, n) => n).map((n) => {
          const selected = value === n;
          return (
            <Pressable
              key={n}
              onPress={() => onChange(n)}
              style={[styles.stepperDot, selected && styles.stepperDotActive]}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${n}`}
              testID={`${testID}-${n}`}
            >
              <Text style={[styles.stepperText, selected && styles.stepperTextActive]}>{n}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  testID,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  testID?: string;
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={vola.textDim}
        autoCapitalize={multiline ? 'sentences' : 'words'}
        autoCorrect={!!multiline}
        multiline={multiline}
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  centreTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  centreMuted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  scroll: { padding: 20, gap: 8, paddingBottom: 48 },
  headerAction: { color: vola.lime, fontWeight: '700', fontSize: 16 },
  preview: { alignItems: 'center', gap: 10, marginBottom: 8 },
  previewLabel: { fontSize: 14, fontWeight: '600', color: vola.textMuted },
  field: { gap: 6 },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
  },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: vola.lime, borderColor: vola.lime },
  chipText: { fontWeight: '600', color: vola.textMuted },
  chipTextActive: { color: vola.navy },
  stepperRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  stepperDot: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperDotActive: { backgroundColor: vola.lime, borderColor: vola.lime },
  stepperText: { fontWeight: '700', color: vola.textMuted },
  stepperTextActive: { color: vola.navy },
  deleteRow: { marginTop: 24, alignItems: 'center', paddingVertical: 12 },
  deleteText: { color: vola.danger, fontWeight: '600', fontSize: 14 },
  error: { color: vola.danger, fontSize: 14 },
});
