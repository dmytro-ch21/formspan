import { Image } from 'expo-image';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { navyBodyFat, waistToHeight, waistToHip } from '@/lib/anthropometry';
import {
  GIRTH_HOW,
  GIRTH_SITES,
  deleteCheckin,
  listCheckins,
  saveCheckin,
  uploadCheckinPhoto,
  type Checkin,
  type CheckinInput,
  type GirthKey,
} from '@/lib/body';
import { getProfile, type Profile } from '@/lib/profile';
import {
  fromDisplayGirth,
  fromDisplayWeight,
  girthUnit,
  girthUnitName,
  toDisplayGirth,
  toDisplayWeight,
  weightUnit,
  weightUnitName,
} from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * One day's check-in.
 *
 * ## Weight first, and everything else optional
 *
 * The weight field is the whole of the daily habit and sits alone at the top;
 * the girths are behind a disclosure because they are a **weekly** job, not a
 * daily one — they do not move faster than that, and below a week the tape
 * error is larger than the change. Putting nine fields in front of somebody
 * every morning is how a ten-second habit becomes one nobody keeps.
 *
 * ## Centimetres, always, and the how-to is on the field
 *
 * The largest source of error in self-measurement is not the tape — it is
 * measuring a slightly different place next week, which produces noise that
 * looks exactly like progress. So each site carries its own one-line method
 * (`GIRTH_HOW`), on the field rather than in a help screen nobody opens.
 *
 * ## Photos
 *
 * Downscaled on the device before upload — a raw iPhone frame is 4–5MB and the
 * useful information survives 1080px easily — then PUT straight to private
 * storage through a short-lived signed URL. The bytes never pass through our
 * API. See `lib/body.ts`.
 */
export default function CheckinScreen() {
  const accent = useAccent();
  const router = useRouter();
  const getToken = useAuthToken();
  const { date } = useLocalSearchParams<{ date: string }>();
  const { units } = useUnits();

  const [checkin, setCheckin] = useState<Checkin | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openGirths, setOpenGirths] = useState(false);

  /**
   * The form's own copy, as typed text.
   *
   * Text rather than numbers because a half-typed "81." is not a number, and
   * round-tripping through `Number` on every keystroke deletes the decimal
   * point out from under the cursor — the same reason the session logger keeps
   * its fields as strings.
   */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');

  /**
   * `load` rebuilds the form from the server, so it must only run when there is
   * nothing unsaved to lose. `fill` says whether to touch the draft at all.
   */
  const load = useCallback(async (fill = true) => {
    if (!date) return;
    try {
      const [list, p] = await Promise.all([
        listCheckins(getToken, { from: date, to: date }),
        // The profile carries height and sex, which the derived numbers need.
        // A failure here costs the estimates, not the screen.
        getProfile(getToken).catch(() => null),
      ]);
      const today = list[0] ?? null;
      setCheckin(today);
      setProfile(p);
      if (today && fill) {
        const next: Record<string, string> = {};
        if (today.weight_kg != null) {
          next.weight_kg = String(toDisplayWeight(today.weight_kg, units));
        }
        for (const s of GIRTH_SITES) {
          const v = today[s.key];
          if (v != null) next[s.key] = String(toDisplayGirth(v as number, units));
        }
        setDraft(next);
        setNotes(today.notes);
        // Open the girths if there already are some — the athlete is editing
        // them, not being asked for them.
        setOpenGirths(GIRTH_SITES.some((s) => today[s.key] != null));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [date, getToken, units]);

  // `useFocusEffect`, not `useEffect`: coming back to this screen — after the
  // photo picker, or from Profile having just added a height — should re-read
  // rather than show what was true when it first mounted.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /** A typed field as a number, or undefined when it is blank or half-typed. */
  const num = (key: string): number | undefined => {
    const raw = draft[key]?.trim().replace(',', '.');
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  /**
   * A typed girth as CENTIMETRES, whatever the field is labelled.
   *
   * The draft holds what the athlete typed — inches on an imperial profile —
   * while `checkin` holds storage, which is always centimetres. The formulas
   * below take centimetres. Reading `num` directly here would feed inches
   * into the Navy estimate for as long as a field is dirty and centimetres
   * again the moment it is saved: a body-fat figure that moves when nothing
   * about the body did, and no error anywhere. Hence one converting reader.
   */
  const girthCM = (key: GirthKey): number | null => {
    const typed = num(key);
    if (typed !== undefined) return fromDisplayGirth(typed, units);
    return checkin?.[key] ?? null;
  };

  const waist = girthCM('waist_cm');
  const hips = girthCM('hips_cm');
  const neck = girthCM('neck_cm');
  const heightCM = profile?.height_cm ?? null;

  /** A field that loaded with a value and has been blanked. */
  const clearedSomething =
    checkin != null &&
    [{ key: 'weight_kg', v: checkin.weight_kg }, ...GIRTH_SITES.map((g) => ({ key: g.key as string, v: checkin[g.key] }))]
      .some(({ key, v }) => v != null && (draft[key] ?? '').trim() === '');

  const whtr = waistToHeight(waist, heightCM);
  const whr = waistToHip(waist, hips);
  const bodyFat = navyBodyFat({
    sex: profile?.sex as 'male' | 'female' | null,
    heightCM,
    neckCM: neck,
    waistCM: waist,
    hipsCM: hips,
  });

  async function save() {
    if (!date) return;
    setSaving(true);
    setError(null);
    try {
      const input: CheckinInput = { notes };
      const w = num('weight_kg');
      // Converted back to kilograms on the way in — storage is always metric,
      // whatever the field is labelled.
      if (w !== undefined) input.weight_kg = fromDisplayWeight(w, units);
      // Converted back to centimetres on the way in, for the same reason the
      // weight above is: storage is metric whatever the field is labelled.
      for (const s of GIRTH_SITES) {
        const v = num(s.key);
        if (v !== undefined) input[s.key] = fromDisplayGirth(v, units);
      }
      await saveCheckin(getToken, date, input);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  async function addPhoto() {
    if (!date) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('VOLA needs access to your photos to attach one.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (picked.canceled || !picked.assets[0]) return;

    setSaving(true);
    setError(null);
    try {
      // Downscaled before it leaves the phone: a raw frame is 4–5MB, and the
      // thing this photo is for — the shape of a body, month over month —
      // survives 1080px with room to spare.
      const shrunk = await ImageManipulator.manipulateAsync(
        picked.assets[0].uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
      );
      await uploadCheckinPhoto(getToken, date, shrunk.uri);
      // `false`: refresh the photo and nothing else. Rebuilding the draft here
      // wiped a weight the athlete had typed but not yet saved — and, because
      // notes are replace-semantics, the next Save then persisted the emptied
      // note. Raised in review.
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    if (!date) return;
    Alert.alert(
      'Delete this check-in?',
      'The measurements and any photo for this day are removed. This is the only way to clear a value you typed wrong.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void deleteCheckin(getToken, date)
              .then(() => router.back())
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              );
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator accessibilityLabel="Loading check-in" />
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Check in' }} />

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="checkin-error">
          {error}
        </Text>
      )}

      {/* Weight, alone and first: this is the daily habit. */}
      <View style={styles.block}>
        <Text style={styles.label}>Weight ({weightUnit(units)})</Text>
        <TextInput
          style={styles.weightInput}
          value={draft.weight_kg ?? ''}
          onChangeText={(t) => setDraft((d) => ({ ...d, weight_kg: t }))}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="—"
          placeholderTextColor={vola.textDim}
          accessibilityLabel={`Weight in ${weightUnitName(units)}`}
          testID="checkin-weight"
        />
        <Text style={styles.hint}>
          Same time every day — first thing, after the loo, before food. The
          number matters less than measuring it the same way.
        </Text>
      </View>

      {/* Girths, behind a disclosure: a weekly job, not a daily one. */}
      <Pressable
        onPress={() => setOpenGirths((v) => !v)}
        style={styles.discloseRow}
        accessibilityRole="button"
        accessibilityState={{ expanded: openGirths }}
        accessibilityLabel="Measurements"
        testID="checkin-girths-toggle"
      >
        <Text style={styles.sectionLabel}>Measurements</Text>
        <Icon name={openGirths ? 'chevron-down' : 'chevron'} size={16} color={vola.textMuted} />
      </Pressable>

      {openGirths && (
        <View style={styles.block}>
          <Text style={styles.hint}>
            In {girthUnitName(units)}, tape snug but not compressing. Once a week
            is plenty — they move slower than the tape’s own error.
          </Text>
          {GIRTH_SITES.map((s) => (
            <View key={s.key} style={styles.field}>
              <Text style={styles.label}>
                {s.label} ({girthUnit(units)})
              </Text>
              <TextInput
                style={styles.input}
                value={draft[s.key] ?? ''}
                onChangeText={(t) => setDraft((d) => ({ ...d, [s.key]: t }))}
                keyboardType="decimal-pad"
                inputMode="decimal"
                placeholder="—"
                placeholderTextColor={vola.textDim}
                accessibilityLabel={`${s.label} in ${girthUnitName(units)}`}
                accessibilityHint={GIRTH_HOW[s.key as GirthKey]}
                testID={`checkin-${s.key}`}
              />
              <Text style={styles.how}>{GIRTH_HOW[s.key as GirthKey]}</Text>
            </View>
          ))}
        </View>
      )}

      {/*
        Derived, and labelled as estimates.

        Shown only once their inputs exist, so nothing renders a confident zero.
        Body fat is a tape regression and carries ±3–4 points against a real
        scan — the direction it moves is the reliable part, and the copy says so
        rather than letting a decimal imply precision it does not have.
      */}
      {(whtr != null || whr != null || bodyFat != null) && (
        <View style={styles.block}>
          <Text style={styles.sectionLabel}>Derived</Text>
          {whtr != null && (
            <Text style={styles.derived} testID="checkin-whtr">
              Waist-to-height {whtr.toFixed(2)}
              {whtr < 0.5 ? ' · under the 0.5 guide' : ' · over the 0.5 guide'}
            </Text>
          )}
          {whr != null && (
            <Text style={styles.derived} testID="checkin-whr">
              Waist-to-hip {whr.toFixed(2)}
            </Text>
          )}
          {bodyFat != null && (
            <Text style={styles.derived} testID="checkin-bodyfat">
              Body fat ≈ {bodyFat.toFixed(1)}% — a tape estimate, ±3–4 points.
              Watch which way it moves, not the number.
            </Text>
          )}
          {bodyFat == null && waist != null && (
            <Text style={styles.how}>
              Add neck{profile?.sex === 'female' ? ', hips' : ''} and your height in
              Profile for a body-fat estimate.
            </Text>
          )}
        </View>
      )}

      {/* Photo. */}
      <View style={styles.block}>
        <Text style={styles.sectionLabel}>Photo</Text>
        {checkin?.photo_url ? (
          <Image
            source={{ uri: checkin.photo_url }}
            style={styles.photo}
            contentFit="cover"
            // Never cached: the URL is presigned and expires, so a cached copy
            // is a broken image later.
            cachePolicy="none"
            // Content, not decoration: this photo IS the day's record, so
            // hiding it from a screen reader hides the thing being reviewed.
            alt="Progress photo for this check-in"
          />
        ) : null}
        <Pressable
          onPress={() => void addPhoto()}
          disabled={saving}
          style={[styles.secondary, saving && styles.off]}
          accessibilityRole="button"
          accessibilityLabel={checkin?.photo_url ? 'Replace the photo' : 'Add a photo'}
          testID="checkin-photo"
        >
          <Text style={[styles.secondaryText, { color: accent.ink }]}>
            {checkin?.photo_url ? 'Replace photo' : 'Add photo'}
          </Text>
        </Pressable>
        <Text style={styles.how}>
          Private to you. Never shown to friends, never in the feed.
        </Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.label}>Notes</Text>
        <TextInput
          style={[styles.input, styles.notes]}
          value={notes}
          onChangeText={setNotes}
          multiline
          placeholder="Anything worth remembering about today"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Notes for this check-in"
          testID="checkin-notes"
        />
      </View>

      {/*
        The PUT coalesces, so blanking a field cannot clear it — a real
        surprise, since the value simply reappears. The only place that was
        said was inside the delete confirmation, which you reach after already
        finding delete. Raised in review.
      */}
      {clearedSomething && (
        <Text style={styles.how} testID="checkin-clear-hint">
          Emptying a field leaves the stored value alone — it means “not
          measured today”. To remove a number you typed wrong, delete the whole
          check-in below.
        </Text>
      )}

      <Pressable
        onPress={() => void save()}
        disabled={saving}
        style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
        accessibilityRole="button"
        accessibilityLabel="Save this check-in"
        testID="checkin-save"
      >
        <Text style={[styles.primaryText, { color: accent.on }]}>
          {saving ? 'Saving…' : 'Save'}
        </Text>
      </Pressable>

      {checkin && (
        <Pressable
          onPress={confirmDelete}
          style={styles.delete}
          accessibilityRole="button"
          accessibilityLabel="Delete this check-in"
          testID="checkin-delete"
        >
          <Text style={styles.deleteText}>Delete this check-in</Text>
        </Pressable>
      )}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 16, paddingBottom: 48 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  error: { color: vola.danger, fontSize: 14 },

  block: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 16,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: vola.textMuted,
  },
  label: { fontSize: 12, color: vola.textMuted },
  hint: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  how: { fontSize: 11, color: vola.textDim, lineHeight: 15 },
  derived: { fontSize: 13, color: vola.textMuted, lineHeight: 18 },

  field: { gap: 4 },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    color: vola.text,
    fontSize: 16,
  },
  weightInput: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 60,
    color: vola.text,
    fontSize: 30,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  notes: { minHeight: 80, paddingTop: 10, textAlignVertical: 'top' },

  discloseRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  photo: { width: '100%', height: 260, borderRadius: 12, backgroundColor: vola.surfaceRaised },

  primary: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontWeight: '700', fontSize: 16 },
  secondary: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontWeight: '700', fontSize: 14 },
  off: { opacity: 0.5 },

  delete: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  deleteText: { color: vola.danger, fontSize: 14, fontWeight: '600' },
});
