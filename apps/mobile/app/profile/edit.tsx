import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isNotFound } from '@/lib/apiError';
import { setModules } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { getProfile, updateProfile, type ProfilePatch } from '@/lib/profile';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Editing who you are — as distinct from how the app behaves, which is
 * Settings.
 *
 * The split matters because these fields are *inputs to the product*, not
 * preferences: which sports you do decides what the app offers you, and date
 * of birth feeds the calorie and heart-rate maths later. Getting them wrong
 * changes answers, where getting units wrong only changes labels.
 */
export default function EditProfileScreen() {
  const accent = useAccent();
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

  useEffect(() => {
    getProfile(getToken)
      .then((p) => {
        setLoadedUsername(p.username);
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
    if (saving || unavailable) return;
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
            <Pressable onPress={save} disabled={saving} hitSlop={12} testID="profile-save">
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
        <Field
          label="Height (cm)"
          value={patch.height_cm != null ? String(patch.height_cm) : ''}
          onChangeText={(v) => {
            const n = Number(v.replace(',', '.'));
            setPatch((p) => ({
              ...p,
              height_cm: v.trim() === '' || !Number.isFinite(n) ? null : n,
            }));
          }}
          placeholder="180"
          testID="profile-height"
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
