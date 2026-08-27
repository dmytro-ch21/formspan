import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isNotFound } from '@/lib/apiError';
import { prepareImageForUpload } from '@/lib/imageUpload';
import { setModules } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import {
  getProfile,
  removeAvatar,
  updateProfile,
  uploadAvatar,
  type ProfilePatch,
} from '@/lib/profile';
import { fromFeetInches, heightUnit, toFeetInches, type UnitSystem } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * Editing who you are — as distinct from how the app behaves, which is
 * Settings.
 *
 * The split matters because these fields are *inputs to the product*, not
 * preferences: which sports you do decides what the app offers you, and date
 * of birth feeds the calorie and heart-rate maths later. Getting them wrong
 * changes answers.
 *
 * That last clause used to read "where getting units wrong only changes
 * labels", and N105 disproved it twice over: height is stored in centimetres
 * and feeds BMR, so an imperial athlete entering 5'11" into a box that wanted
 * centimetres would distort their own calorie target — and the phase screen
 * was storing pounds as kilograms outright.
 */
export default function EditProfileScreen() {
  const accent = useAccent();
  const { units } = useUnits();
  const getToken = useAuthToken();
  const router = useRouter();

  const [patch, setPatch] = useState<ProfilePatch>({});
  /**
   * The disciplines, from the server's registry rather than a list in this
   * file. The list here used to be keyed on database column names, which is
   * how it drifted from the three other copies in this app.
   */

  /** Only what the user actually changed, so a save is a sparse PATCH. */
  const [moduleChanges, setModuleChanges] = useState<Record<string, boolean>>({});
  /**
   * Distinct from `error`, and from the profile's own `unavailable`. An empty
   * card under a "What you train" heading reads as "there are no disciplines",
   * which is a claim about the product rather than about the network.
   */

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error`, which also covers a failed *save*. This one means
  // we never learned what the profile says, so there is nothing safe to edit.
  const [unavailable, setUnavailable] = useState(false);
  // What the server currently holds, so save can send the handle ONLY when it
  // changed. Re-sending an unchanged handle couples every unrelated edit to
  // username validation: the reserved list is documented as growing, and the
  // day a claimed handle lands on it, an athlete who re-sends it can no
  // longer save a date-of-birth fix — the whole screen bricked by a field
  // they didn't touch.
  const [loadedUsername, setLoadedUsername] = useState<string | null>(null);
  // The presigned URL from the last load or the last successful
  // upload/remove — never patched into `patch` alongside the other fields,
  // because there is no PATCH-able field here: avatar changes go through
  // their own endpoints (POST/DELETE /profile/avatar), not this screen's
  // Save button.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // Separate from `saving`: an avatar change is its own request, on its own
  // endpoints. Both `save()`'s own guard and the Save button's `disabled`
  // check this too — an athlete mid-upload should not also be able to fire
  // the unrelated PATCH, even though the two touch disjoint fields and
  // nothing would technically conflict; a double-submit affordance is a
  // confusing state to be in regardless of whether it's safe.
  const [avatarBusy, setAvatarBusy] = useState(false);

  useEffect(() => {
    getProfile(getToken)
      .then((p) => {
        setLoadedUsername(p.username);
        setAvatarUrl(p.avatar_url ?? null);
        setPatch({
          username: p.username ?? undefined,
          display_name: p.display_name,
          date_of_birth: p.date_of_birth,
          sex: p.sex,
          height_cm: p.height_cm,
        });
      })
      .catch((err) => {
        // A 404 is the ordinary first-run case: there genuinely is no profile
        // yet, so an empty form is the truth and saving creates one.
        if (isNotFound(err)) {
          // A genuinely new account: an empty form is the truth, and module
          // defaults come from the registry rather than being guessed here.
          setPatch({});
          return;
        }
        // Anything else — offline, 5xx, no token — means we don't know what
        // is stored. This used to fall into the same branch as the 404, so a
        // failed load opened a blank form that looked like a new account, and
        // saving it PATCHed `display_name: null, date_of_birth: null,
        // sex: null` straight over a real profile as soon as the network came
        // back. The form is withheld rather than shown empty.
        setUnavailable(true);
      })
      .finally(() => setLoading(false));
  }, [getToken]);

  // Separate request, separate failure: the modules list failing must not
  // withhold the name and date-of-birth form.
  // From the provider, not a second fetch. Phase A gave this screen its own
  // request — the per-call-site pattern the provider exists to replace.
  const { modules, apply: applyModules, stale: modulesUnavailable } = useModules();

  async function save() {
    // Belt and braces: the form isn't rendered when `unavailable`, so this is
    // unreachable today. It stays because the cost of being wrong is
    // overwriting someone's profile with nulls.
    if (saving || avatarBusy || unavailable) return;
    setSaving(true);
    setError(null);
    try {
      await updateProfile(getToken, {
        ...patch,
        // An empty box means "no name", not the empty string.
        display_name: patch.display_name?.trim() || null,
        // Only when it CHANGED — see loadedUsername. Empty box omits the
        // key (the server cannot clear a handle); the lowercase here is
        // belt-and-braces behind the on-change lowercasing below.
        username: (() => {
          const next = patch.username?.trim().toLowerCase() || undefined;
          return next !== (loadedUsername ?? undefined) ? next : undefined;
        })(),
      });
      // Only what actually differs from the server's state. Toggling something
      // on and back off again would otherwise send a redundant key — which for
      // a module with no stored row WRITES one, quietly opting that user out of
      // future changes to the registry default.
      const realChanges = Object.fromEntries(
        Object.entries(moduleChanges).filter(
          ([key, on]) => on !== modules.find((m) => m.key === key)?.enabled,
        ),
      );

      if (Object.keys(realChanges).length > 0) {
        // Its own try/catch, because sequencing alone does NOT stop a modules
        // failure reading as a total failure. The profile half has already
        // landed at this point — and for a first-run user it just CREATED the
        // profile — so a single generic banner would tell the user nothing
        // saved when in fact most of it did.
        try {
          // Straight into the provider. Without this the save persisted and
          // NOTHING re-gated until the process was killed — the tab bar, the
          // start buttons, the Library chips all kept the old configuration
          // for the rest of the session, which is the entire feature failing
          // on its primary path. `setModules` already returns the merged set,
          // so this costs no extra request.
          applyModules(await setModules(getToken, realChanges));
        } catch (err) {
          setError(
            `Your details saved, but your sports didn't: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          setSaving(false);
          return;
        }
      }
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  /**
   * Shared by both sources (N12) — the downscale-then-upload sequence is
   * identical whether the photo came from the camera or the library.
   *
   * The resize/compress/mime-type steps themselves live in
   * `prepareImageForUpload` (N74, #392) — this screen, `checkin/[date].tsx`
   * and `identify.tsx` all call it rather than each keeping its own copy,
   * which is what let two of the four screens ship without the downscale at
   * all (N73, #361) and what let this comment go on claiming "one place
   * each" while there were four.
   */
  async function commitAvatar(uri: string) {
    setAvatarBusy(true);
    setError(null);
    try {
      // The server does its OWN authoritative resize (to 512px, discarding
      // whatever this produces) so this is purely a courtesy to the upload,
      // never the property "the original is never served" relies on.
      const prepared = await prepareImageForUpload({ uri });
      const updated = await uploadAvatar(getToken, prepared);
      setAvatarUrl(updated.avatar_url ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function pickAvatarFromLibrary() {
    if (avatarBusy) return;
    // The permission request and the picker itself can both reject — a
    // camera-unavailable Simulator, an OS-level picker failure — not just
    // resolve `canceled: true`. Unlike commitAvatar's own try/catch (which
    // only covers the resize-then-upload it wraps), nothing upstream of it
    // was catching this half, so a real rejection here was an unhandled
    // promise rejection from a Pressable handler: silent to the athlete,
    // caught only in review.
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError('VOLA needs access to your photos to set one.');
        return;
      }
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (picked.canceled || !picked.assets[0]) return;
      await commitAvatar(picked.assets[0].uri);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pickAvatarFromCamera() {
    if (avatarBusy) return;
    // See pickAvatarFromLibrary's comment — same reasoning, same gap.
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setError('VOLA needs camera access to take a photo.');
        return;
      }
      const picked = await ImagePicker.launchCameraAsync({ quality: 1 });
      if (picked.canceled || !picked.assets[0]) return;
      await commitAvatar(picked.assets[0].uri);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeMyAvatar() {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setError(null);
    try {
      await removeAvatar(getToken);
      // The monogram returning immediately, without waiting on a re-fetch —
      // the removal itself is the fact that changed, and there is nothing
      // else this response could tell us.
      setAvatarUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAvatarBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator accessibilityLabel="Loading your profile" />
      </View>
    );
  }

  // No form, deliberately. An empty one would read as "you've filled nothing
  // in", which is a claim about the athlete rather than about the network —
  // and it is the claim that made saving destructive.
  if (unavailable) {
    return (
      <View style={styles.centre} testID="profile-edit-unavailable">
        <Stack.Screen options={{ title: 'Edit profile' }} />
        <Text style={styles.unavailable} accessibilityLiveRegion="polite">
          Your profile couldn&apos;t be loaded, so it can&apos;t be edited right now.
        </Text>
        <Text style={styles.unavailableHint}>
          Nothing has changed. Try again when you&apos;re back online.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="profile-edit">
      <Stack.Screen
        options={{
          title: 'Edit profile',
          headerRight: () => (
            <Pressable
              onPress={save}
              disabled={saving || avatarBusy}
              hitSlop={12}
              testID="profile-save"
            >
              <Text style={[styles.headerAction, { color: accent.ink }]}>
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </Pressable>
          ),
        }}
      />

      <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}

        {/* N12: the avatar. `handle` falls back to '' for an account that
            hasn't claimed a username yet — the same "no handle" case
            monogramFor already documents handling with a '?' rather than
            crashing, so this screen needs no extra guard for it. */}
        <View style={styles.avatarRow} testID="profile-avatar-row">
          <Avatar url={avatarUrl} handle={loadedUsername ?? patch.username ?? ''} size={72} />
          <View style={styles.avatarActions}>
            {avatarBusy ? (
              <ActivityIndicator accessibilityLabel="Updating your photo" />
            ) : (
              <>
                <Pressable
                  onPress={pickAvatarFromCamera}
                  hitSlop={8}
                  testID="profile-avatar-camera"
                  accessibilityRole="button"
                  accessibilityLabel="Take a photo"
                >
                  <Text style={[styles.avatarAction, { color: accent.ink }]}>Take photo</Text>
                </Pressable>
                <Pressable
                  onPress={pickAvatarFromLibrary}
                  hitSlop={8}
                  testID="profile-avatar-library"
                  accessibilityRole="button"
                  accessibilityLabel="Choose from library"
                >
                  <Text style={[styles.avatarAction, { color: accent.ink }]}>
                    {avatarUrl ? 'Replace' : 'Choose photo'}
                  </Text>
                </Pressable>
                {avatarUrl && (
                  <Pressable
                    onPress={removeMyAvatar}
                    hitSlop={8}
                    testID="profile-avatar-remove"
                    accessibilityRole="button"
                    accessibilityLabel="Remove photo"
                  >
                    <Text style={[styles.avatarAction, styles.avatarRemove]}>Remove</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
        </View>

        <Field
          label="Name"
          value={patch.display_name ?? ''}
          onChangeText={(v) => setPatch((p) => ({ ...p, display_name: v }))}
          placeholder="What should we call you?"
          testID="profile-name"
        />

        <Field
          label="Username"
          value={patch.username ?? ''}
          // Lowercased AS TYPED, not only at save: the transform is
          // length-preserving so the cursor cannot jump, and what is on the
          // screen is exactly what gets claimed — lowercasing only at save
          // means claiming a handle you were never shown.
          onChangeText={(v) => setPatch((p) => ({ ...p, username: v.toLowerCase() }))}
          placeholder="e.g. dmytro_bjj"
          autoCapitalize="none"
          accessibilityHint="3 to 30 characters: lowercase letters, digits or underscore, starting with a letter"
          testID="profile-username"
        />
        {/* The rule stated up front, because the server's 400 states it
            anyway and reading it here first is one less failed save. */}
        <Text style={styles.hint}>
          3–30 characters: a–z, 0–9 or _, starting with a letter. This is how friends will find
          you once sharing arrives. A claimed handle can be renamed — which frees the old one —
          but not removed.
        </Text>

        <Field
          label="Date of birth"
          value={patch.date_of_birth ?? ''}
          onChangeText={(v) => setPatch((p) => ({ ...p, date_of_birth: v || null }))}
          placeholder="YYYY-MM-DD"
          testID="profile-dob"
        />

        {/* Height earns its place here rather than on a check-in: it is a fact
            about the athlete that does not move week to week, and asking for it
            per check-in would both nag and let rows disagree. Waist-to-height
            and the body-fat estimate are both unavailable without it. */}
        <HeightField
          cm={patch.height_cm ?? null}
          units={units}
          onChange={(cm) => setPatch((p) => ({ ...p, height_cm: cm }))}
        />

        <Text style={styles.sectionLabel}>Sex</Text>
        <View style={styles.chips}>
          {['male', 'female'].map((s) => {
            const selected = patch.sex === s;
            return (
              <Pressable
                key={s}
                // Tapping the selected one clears it — this feeds calorie
                // maths and "unset" has to stay reachable.
                onPress={() => setPatch((p) => ({ ...p, sex: selected ? null : s }))}
                style={[
                  styles.chip,
                  selected && [
                    styles.chipActive,
                    { backgroundColor: accent.accent, borderColor: accent.accent },
                  ],
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                testID={`profile-sex-${s}`}
              >
                <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                  {s === 'male' ? 'Male' : 'Female'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>What you train</Text>
        <Text style={styles.hint}>Decides what the app offers you. Change it any time.</Text>
        <View style={styles.card}>
          {modulesUnavailable && (
            <Text style={styles.hint} accessibilityLiveRegion="polite">
              Couldn&apos;t load your sports just now. Your other details still save.
            </Text>
          )}
          {modules.map((s) => {
            const on = moduleChanges[s.key] ?? s.enabled;
            return (
              <Pressable
                key={s.key}
                onPress={() => setModuleChanges((c) => ({ ...c, [s.key]: !on }))}
                style={styles.toggleRow}
                accessibilityRole="switch"
                accessibilityState={{ checked: on }}
                accessibilityLabel={s.label}
                testID={`profile-${s.key}`}
              >
                <Text style={styles.toggleLabel}>{s.label}</Text>
                <View
                  style={[styles.switch, on && [styles.switchOn, { backgroundColor: accent.accent }]]}
                >
                  <View style={[styles.knob, on && styles.knobOn]} />
                </View>
              </Pressable>
            );
          })}
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

/**
 * Height, in whichever units the athlete thinks in.
 *
 * **Height had no unit support anywhere before N105**: `height_cm` ran from the
 * Postgres column through `profile.go` and `lib/profile.ts` onto a box labelled
 * "Height (cm)", whatever the profile said. That is not only a label problem —
 * BMR derives from height, so an athlete who typed something sensible to them
 * got a distorted calorie target out of the other end.
 *
 * ## Why imperial gets two boxes
 *
 * Nobody says "70.9 inches"; they say 5'11". A single inches field would be a
 * faithful unit conversion and an unusable control, so imperial gets feet and
 * inches side by side and metric keeps its one box.
 *
 * ## Why there is no local state
 *
 * The displayed values are DERIVED from `cm` on every render rather than held in
 * their own `useState` and synced by an effect. Partly correctness — one source
 * of truth, so the two boxes cannot disagree with the value being saved — and
 * partly the lint budget: `react-hooks/set-state-in-effect` is a warning held by
 * `--max-warnings`, which sits exactly at its limit, so the effect-and-sync shape
 * could not be added without raising the ratchet this repo uses as enforcement.
 *
 * Round-tripping is exact in the direction that matters: 5'11" stores 180.3 and
 * reads back as 5'11", verified across every whole-inch height the column's
 * CHECK admits (1'8" to 8'6"). The units module's header explains why the other
 * direction cannot be.
 */
function HeightField({
  cm,
  units,
  onChange,
}: {
  cm: number | null;
  units: UnitSystem;
  onChange: (cm: number | null) => void;
}) {
  if (units !== 'imperial') {
    return (
      <Field
        label={`Height (${heightUnit(units)})`}
        value={cm != null ? String(cm) : ''}
        onChangeText={(v) => {
          const n = Number(v.replace(',', '.'));
          onChange(v.trim() === '' || !Number.isFinite(n) ? null : n);
        }}
        placeholder="180"
        testID="profile-height"
      />
    );
  }

  const parts = cm != null ? toFeetInches(cm) : null;
  // An empty box reads as zero for the other half's arithmetic, and a TOTAL of
  // zero clears the value rather than storing 0 cm — which the column rejects
  // anyway, and which would mean "I am 0 tall" rather than "I have not said".
  //
  // Keyed on the total rather than on both boxes being blank, because with
  // derived values the blank-blank state is UNREACHABLE: clearing inches leaves
  // feet showing 5, and clearing feet then passes the sibling's derived '0'
  // rather than ''. So the field could never be emptied once set. Found by the
  // test, not by reading it.
  const commit = (feet: string, inches: string) => {
    const f = Number(feet.replace(',', '.'));
    const i = Number(inches.replace(',', '.'));
    const totalInches = (Number.isFinite(f) ? f : 0) * 12 + (Number.isFinite(i) ? i : 0);
    if (totalInches <= 0) return onChange(null);
    onChange(fromFeetInches(Number.isFinite(f) ? f : 0, Number.isFinite(i) ? i : 0));
  };

  return (
    <View style={styles.field}>
      <Text style={styles.sectionLabel}>Height</Text>
      <View style={styles.heightRow}>
        <TextInput
          style={[styles.input, styles.heightBox]}
          value={parts ? String(parts.feet) : ''}
          onChangeText={(v) => commit(v, parts ? String(parts.inches) : '')}
          keyboardType="number-pad"
          inputMode="numeric"
          placeholder="5"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Height, feet"
          testID="profile-height-feet"
        />
        <Text style={styles.heightUnit}>ft</Text>
        <TextInput
          style={[styles.input, styles.heightBox]}
          value={parts ? String(parts.inches) : ''}
          onChangeText={(v) => commit(parts ? String(parts.feet) : '', v)}
          keyboardType="number-pad"
          inputMode="numeric"
          placeholder="11"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Height, inches"
          testID="profile-height-inches"
        />
        <Text style={styles.heightUnit}>in</Text>
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = 'words',
  accessibilityHint,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  /** "words" suits names; a username field must pass "none" or the keyboard
   *  fights the lowercase-only format on every character. */
  autoCapitalize?: 'none' | 'words';
  accessibilityHint?: string;
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={vola.textDim}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 8 },
  avatarActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, flexShrink: 1 },
  avatarAction: { fontSize: 14, fontWeight: '600' },
  avatarRemove: { color: vola.danger },
  heightRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  heightBox: { flex: 1 },
  heightUnit: { color: vola.textMuted, fontSize: 15 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  unavailable: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  unavailableHint: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  scroll: { padding: 20, gap: 8, paddingBottom: 48 },
  headerAction: { fontWeight: '700', fontSize: 16 },
  field: { gap: 6 },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
  },
  hint: { color: vola.textMuted, fontSize: 12 },
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
  chips: { flexDirection: 'row', gap: 8 },
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
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    minHeight: 52,
  },
  toggleLabel: { fontSize: 15, fontWeight: '600' },
  switch: {
    width: 50,
    height: 30,
    borderRadius: 999,
    backgroundColor: vola.line,
    padding: 3,
    justifyContent: 'center',
  },
  switchOn: {},
  knob: { width: 24, height: 24, borderRadius: 999, backgroundColor: vola.surface },
  knobOn: { alignSelf: 'flex-end', backgroundColor: vola.navy },
  error: { color: vola.danger, fontSize: 14 },
});
