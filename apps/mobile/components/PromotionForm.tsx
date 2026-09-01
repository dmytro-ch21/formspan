import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput } from 'react-native';

import { Belt as BeltView, describeBelt } from '@/components/Belt';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  BELTS,
  MAX_DEGREE,
  MAX_STRIPES,
  createPromotion,
  deletePromotion,
  getStanding,
  updatePromotion,
  uploadPromotionPhoto,
  type Belt,
  type PromotionInput,
  type Rank,
} from '@/lib/bjj';
import { prepareImageForUpload, type UploadableImage } from '@/lib/imageUpload';
import { MODULE_TOGGLE_LOCATION } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';

export type EditablePromotion = PromotionInput & { id: string; photo_url?: string };

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
  const accent = useAccent();
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

  /**
   * Photo.
   *
   * `photoUrl` is what gets RENDERED — a presigned link, always re-minted
   * rather than trusted from route params (see the effect below and
   * `[id].tsx`'s own comment) because it expires in 15 minutes and there is
   * no telling how long ago the hub screen fetched it.
   *
   * `pendingPhoto` only exists on the ADD form. A brand-new promotion has no
   * id yet, so there is nothing to attach a photo TO — see
   * `uploadPromotionPhoto`'s doc. The picked image is held locally and
   * uploaded once `save()` has created the row and knows its id. On the EDIT
   * form there is always an id already, so a pick uploads immediately (same
   * interaction as `checkin/[date].tsx`) and `pendingPhoto` is never used.
   */
  const [photoUrl, setPhotoUrl] = useState<string | null>(initial?.photo_url ?? null);
  const [pendingPhoto, setPendingPhoto] = useState<UploadableImage | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  useEffect(() => {
    if (!initial) return;
    let cancelled = false;
    getStanding(getToken)
      .then((standing) => {
        if (cancelled) return;
        const match = standing.promotions.find((p) => p.id === initial.id);
        if (match) setPhotoUrl(match.photo_url ?? null);
      })
      .catch(() => {
        // Best-effort refresh only. The route-param photo_url (if any) is
        // already painted, and simply may have expired by the time it's
        // seen — no worse than not refreshing at all.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial is a route-derived snapshot, not reactive state
  }, [initial?.id, getToken]);

  async function pickPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('VOLA needs access to your photos to attach one.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (picked.canceled || !picked.assets[0]) return;

    setPhotoBusy(true);
    setError(null);
    try {
      // Same downscale every screen with a picker uses — see
      // `prepareImageForUpload`'s own doc for why this is one shared call
      // rather than three lines each screen has to remember.
      const prepared = await prepareImageForUpload(picked.assets[0]);
      if (initial) {
        // Editing: the promotion already has an id, so there's no reason to
        // wait for Save — attach it now, the same interaction the check-in
        // screen offers.
        await uploadPromotionPhoto(getToken, initial.id, prepared.uri);
        const standing = await getStanding(getToken);
        const match = standing.promotions.find((p) => p.id === initial.id);
        setPhotoUrl(match?.photo_url ?? null);
      } else {
        // Adding: nothing to attach a photo to yet. Held until save() has
        // created the promotion and knows its id.
        setPendingPhoto(prepared);
        setPhotoUrl(prepared.uri);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhotoBusy(false);
    }
  }

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
        // Any photo on an edit was already uploaded the moment it was
        // picked (see pickPhoto) — nothing photo-related to do here.
        await updatePromotion(getToken, initial.id, input);
      } else {
        const created = await createPromotion(getToken, input);
        if (pendingPhoto) {
          try {
            await uploadPromotionPhoto(getToken, created.id, pendingPhoto.uri);
          } catch (err) {
            // The rank is safely recorded at this point — only the photo
            // failed. Don't lose the save over it; the promotion can be
            // opened again afterwards to attach one, same as any existing
            // promotion.
            Alert.alert(
              'Promotion saved',
              `${err instanceof Error ? err.message : String(err)} You can add the photo again by opening this promotion.`,
            );
          }
        }
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
          Turn it back on under {MODULE_TOGGLE_LOCATION} in your profile before recording a promotion.
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
            <Pressable
              onPress={save}
              // Also disabled while a just-picked photo is still being
              // resized (N456 follow-up, frontend-reviewer): saving during
              // that sub-second window would create the promotion before
              // `pendingPhoto` is set, silently dropping the photo the
              // helper text just promised would upload.
              disabled={saving || photoBusy}
              hitSlop={12}
              testID="promotion-save">
              <Text style={[styles.headerAction, { color: accent.ink }]}>
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </Pressable>
          ),
        }}
      />

      {/* This used to be a bare ScrollView, on the reasoning that an ordinary
          top-to-bottom form is the case iOS already handles once
          `automaticallyAdjustKeyboardInsets` is asked for — true, and it left
          Android with nothing lifting the focused field, since that prop is
          iOS-only. The wrapper is now a superset of what was here: same inset,
          plus the Android path and a dismiss mode Android actually honours. */}
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
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
                style={[
                  styles.chip,
                  selected && [
                    styles.chipActive,
                    { backgroundColor: accent.accent, borderColor: accent.accent },
                  ],
                ]}
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

        {/*
          Photo — optional, matching `promoted_on`'s own precedent: a
          promotion with no photo is exactly as valid a record as one with
          one. On the edit form a pick uploads immediately (same interaction
          as checkin/[date].tsx); on the add form nothing exists to attach it
          to yet, so it's held until Save creates the row.
        */}
        <View style={styles.field}>
          <Text style={styles.sectionLabel}>Photo</Text>
          {photoUrl ? (
            <Image
              source={{ uri: photoUrl }}
              style={styles.photo}
              contentFit="cover"
              // Never cached: a presigned link expires, and the local
              // preview on the add form is a one-shot uri that won't be
              // seen again either way.
              cachePolicy="none"
              alt="Photo for this promotion"
              testID="promotion-photo-image"
            />
          ) : null}
          <Pressable
            onPress={() => void pickPhoto()}
            disabled={saving || photoBusy}
            style={[styles.photoButton, (saving || photoBusy) && styles.off]}
            accessibilityRole="button"
            accessibilityLabel={photoUrl ? 'Replace the photo' : 'Add a photo'}
            testID="promotion-photo"
          >
            {photoBusy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.photoButtonText, { color: accent.ink }]}>
                {photoUrl ? 'Replace photo' : 'Add photo'}
              </Text>
            )}
          </Pressable>
          <Text style={styles.how}>
            {initial
              ? 'Private to you. Attached right away — no need to hit Save.'
              : 'Private to you. Uploaded once you save this promotion.'}
          </Text>
        </View>

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
      </KeyboardAwareScrollView>
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
  const accent = useAccent();
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
              style={[
                styles.stepperDot,
                selected && [
                  styles.stepperDotActive,
                  { backgroundColor: accent.accent, borderColor: accent.accent },
                ],
              ]}
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
  headerAction: { fontWeight: '700', fontSize: 16 },
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
  chipActive: {},
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
  stepperDotActive: {},
  stepperText: { fontWeight: '700', color: vola.textMuted },
  stepperTextActive: { color: vola.navy },
  photo: { width: '100%', height: 220, borderRadius: 12, backgroundColor: vola.surfaceRaised },
  photoButton: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoButtonText: { fontWeight: '700', fontSize: 14 },
  how: { fontSize: 11, color: vola.textDim, lineHeight: 15 },
  off: { opacity: 0.5 },

  deleteRow: { marginTop: 24, alignItems: 'center', paddingVertical: 12 },
  deleteText: { color: vola.danger, fontWeight: '600', fontSize: 14 },
  error: { color: vola.danger, fontSize: 14 },
});
