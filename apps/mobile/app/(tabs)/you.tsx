import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { TrainingSummary } from '@/components/TrainingSummary';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { getProfile, type Profile } from '@/lib/profile';
import { UNIT_SYSTEMS } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * You — the athlete, and the way in to everything about them.
 *
 * Edit and Settings live in the top-right rather than as rows in a list,
 * because they're two different kinds of change: Edit alters *facts about
 * you* that the app reasons over (which sports you do, your date of birth),
 * while Settings alters *how the app behaves* (units now, more later).
 * Mixing them into one list makes "change my units" and "change my birthday"
 * look like the same kind of action, and they aren't.
 */
export default function YouScreen() {
  const getToken = useAuthToken();
  const router = useRouter();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  // On focus, so returning from Edit shows what was just saved.
  useFocusEffect(
    useCallback(() => {
      getProfile(getToken)
        .then((p) => {
          setProfile(p);
          setError(null);
        })
        // A missing profile isn't an error — it's someone who hasn't
        // filled one in yet, and the empty state below says so.
        .catch(() => setProfile(null));
    }, [getToken]),
  );

  const modules = profile
    ? [
        profile.strength_enabled && 'Strength',
        profile.bjj_enabled && 'BJJ',
        profile.running_enabled && 'Running',
        profile.nutrition_enabled && 'Nutrition',
      ].filter(Boolean)
    : [];

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="you-screen">
      <ScreenHeader
        title="You"
        action={
          <View style={styles.actions}>
            <Pressable
              onPress={() => router.push('/profile/edit')}
              hitSlop={10}
              accessibilityRole="button"
              testID="you-edit"
            >
              <Text style={styles.action}>Edit</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/settings')}
              hitSlop={10}
              accessibilityRole="button"
              testID="you-settings"
            >
              <Text style={styles.action}>Settings</Text>
            </Pressable>
          </View>
        }
      />

      <View style={styles.body}>
        {error && <Text style={styles.error}>{error}</Text>}

        <Text style={styles.name}>{profile?.display_name || 'Add your name'}</Text>
        {!profile?.display_name && (
          <Text style={styles.muted}>Tap Edit to tell VOLA who you are.</Text>
        )}

        {/* History, phone-sized. The web app owns the analytical surface —
            this answers the one question a desk can't while you're standing
            in a gym: am I showing up. */}
        <TrainingSummary getToken={getToken} units={profile?.unit_system ?? 'metric'} />

        <Text style={styles.sectionLabel}>Profile</Text>
        <View style={styles.card}>
          <Row label="Sports" value={modules.length ? modules.join(' · ') : 'None chosen yet'} />
          <Row
            label="Units"
            value={
              UNIT_SYSTEMS.find((u) => u.key === profile?.unit_system)?.detail ??
              'kilograms · metres'
            }
          />
          {profile?.date_of_birth && <Row label="Born" value={profile.date_of_birth} />}
        </View>

      </View>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: 12, paddingBottom: TAB_BAR_CLEARANCE },
  body: { paddingHorizontal: 20, gap: 10 },
  actions: { flexDirection: 'row', gap: 16 },
  action: { color: vola.lime, fontWeight: '700', fontSize: 14 },
  name: { fontSize: 26, fontWeight: '800', marginTop: 4 },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
  },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
  },
  rowLabel: { color: vola.textMuted, fontSize: 14 },
  rowValue: { fontWeight: '600', fontSize: 14, flexShrink: 1, textAlign: 'right' },
  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: vola.danger, fontSize: 14 },
});
