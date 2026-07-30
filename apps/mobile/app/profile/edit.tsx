import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { getProfile, updateProfile, type ProfilePatch } from '@/lib/profile';
import { useAuthToken } from '@/lib/useAuthToken';

const SPORTS = [
  { key: 'strength_enabled', label: 'Strength' },
  { key: 'bjj_enabled', label: 'BJJ' },
  { key: 'running_enabled', label: 'Running' },
  { key: 'nutrition_enabled', label: 'Nutrition' },
] as const;

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
  const getToken = useAuthToken();
  const router = useRouter();

  const [patch, setPatch] = useState<ProfilePatch>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProfile(getToken)
      .then((p) =>
        setPatch({
          display_name: p.display_name,
          date_of_birth: p.date_of_birth,
          sex: p.sex,
          strength_enabled: p.strength_enabled,
          bjj_enabled: p.bjj_enabled,
          running_enabled: p.running_enabled,
          nutrition_enabled: p.nutrition_enabled,
        }),
      )
      // No profile yet is the ordinary first-run case, not a failure — the
      // form simply starts empty and creates one on save.
      .catch(() => setPatch({ strength_enabled: true }))
      .finally(() => setLoading(false));
  }, [getToken]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateProfile(getToken, {
        ...patch,
        // An empty box means "no name", not the empty string.
        display_name: patch.display_name?.trim() || null,
      });
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

  return (
    <View style={styles.container} testID="profile-edit">
      <Stack.Screen
        options={{
          title: 'Edit profile',
          headerRight: () => (
            <Pressable onPress={save} disabled={saving} hitSlop={12} testID="profile-save">
              <Text style={styles.headerAction}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          ),
        }}
      />

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
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
          label="Date of birth"
          value={patch.date_of_birth ?? ''}
          onChangeText={(v) => setPatch((p) => ({ ...p, date_of_birth: v || null }))}
          placeholder="YYYY-MM-DD"
          testID="profile-dob"
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
                style={[styles.chip, selected && styles.chipActive]}
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
          {SPORTS.map((s) => {
            const on = patch[s.key] === true;
            return (
              <Pressable
                key={s.key}
                onPress={() => setPatch((p) => ({ ...p, [s.key]: !on }))}
                style={styles.toggleRow}
                accessibilityRole="switch"
                accessibilityState={{ checked: on }}
                accessibilityLabel={s.label}
                testID={`profile-${s.key}`}
              >
                <Text style={styles.toggleLabel}>{s.label}</Text>
                <View style={[styles.switch, on && styles.switchOn]}>
                  <View style={[styles.knob, on && styles.knobOn]} />
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
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
        autoCapitalize="words"
        autoCorrect={false}
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 20, gap: 8, paddingBottom: 48 },
  headerAction: { color: vola.lime, fontWeight: '700', fontSize: 16 },
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
  chipActive: { backgroundColor: vola.lime, borderColor: vola.lime },
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
  switchOn: { backgroundColor: vola.lime },
  knob: { width: 24, height: 24, borderRadius: 999, backgroundColor: vola.surface },
  knobOn: { alignSelf: 'flex-end', backgroundColor: vola.navy },
  error: { color: vola.danger, fontSize: 14 },
});
