import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { BjjRankHeader } from '@/components/BjjRankHeader';
import { RecordsCard } from '@/components/RecordsCard';
import { RoadmapSummary } from '@/components/RoadmapSummary';
import { TrainingSummary } from '@/components/TrainingSummary';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isNotFound } from '@/lib/apiError';
import { getProfile, type Profile } from '@/lib/profile';
import { UNIT_SYSTEMS } from '@/lib/units';
import { useModules } from '@/lib/ModulesProvider';
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
  const accent = useAccent();
  const getToken = useAuthToken();
  const router = useRouter();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the server has ever answered on this screen. Without it the
  // initial `profile === null` is indistinguishable from a confirmed "no
  // profile yet", so a *first* load that fails renders the whole new-user
  // empty state — "Add your name", "None chosen yet", "kilograms · metres" —
  // which is the same claim this screen was fixed to stop making, merely
  // contradicted by a banner instead of withheld.
  const [answered, setAnswered] = useState(false);

  // On focus, so returning from Edit shows what was just saved.
  useFocusEffect(
    useCallback(() => {
      getProfile(getToken)
        .then((p) => {
          setProfile(p);
          setError(null);
          setAnswered(true);
        })
        .catch((err) => {
          // A missing profile isn't an error — it's someone who hasn't
          // filled one in yet, and the empty state below says so.
          if (isNotFound(err)) {
            setProfile(null);
            setError(null);
            setAnswered(true);
            return;
          }
          // Everything else: keep what's already on screen. This used to
          // `setProfile(null)` for any failure, so an established athlete
          // coming back from Edit while offline was shown a blank new-user
          // profile, asserted as fact — and silently, because `error` was only
          // ever assigned null, which made the banner below dead code.
          setError("Couldn't reach your profile just now.");
        });
    }, [getToken]),
  );

  // From the provider, not a fetch of its own. Two reasons: this screen had
  // the per-call-site pattern the provider exists to replace, and being
  // mount-only it went stale after exactly the flow this row is for — edit
  // your sports, come back, and see the list you just changed.
  //
  // The labels come with it, so "BJJ" stays "BJJ" rather than becoming "Bjj".
  const { modules, ready: modulesReady } = useModules();
  // null means "we don't know yet", which is NOT the same as "none chosen".
  const enabledLabels = modulesReady ? modules.filter((m) => m.enabled).map((m) => m.label) : null;
  // A belt is meaningless to someone who doesn't train BJJ — gated the same
  // way Records and Library are gated on the web dashboard, on the module
  // rather than on data existing, so turning BJJ off hides the card even for
  // an account with a recorded history.
  const bjjEnabled = modulesReady && modules.some((m) => m.key === 'bjj' && m.enabled);

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
              <Text style={[styles.action, { color: accent.ink }]}>Edit</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/settings')}
              hitSlop={10}
              accessibilityRole="button"
              testID="you-settings"
            >
              <Text style={[styles.action, { color: accent.ink }]}>Settings</Text>
            </Pressable>
          </View>
        }
      />

      <View style={styles.body}>
        {error && <Text style={styles.error}>{error}</Text>}

        {/* Nothing has ever loaded, so every field below would be a default
            standing in for an unknown. Say so rather than render them. */}
        {!answered && error ? (
          <Text style={styles.muted} testID="you-unavailable">
            Your profile, training summary and records will appear here once VOLA can reach your
            account. Nothing you&apos;ve logged is affected.
          </Text>
        ) : (
          <>
            {/* The belt leads for a ranked grappler — see BjjRankHeader for
                why it is a masthead rather than a card. It owns the no-rank
                case too, as a single quiet row, so this is the only place the
                standing is fetched. */}
            {bjjEnabled && <BjjRankHeader getToken={getToken} />}

            <Text style={styles.name}>{profile?.display_name || 'Add your name'}</Text>
            {!profile?.display_name && (
              <Text style={styles.muted}>Tap Edit to tell VOLA who you are.</Text>
            )}

            {/* History, phone-sized. The web app owns the analytical surface —
                this answers the one question a desk can't while you're standing
                in a gym: am I showing up. */}
            <TrainingSummary getToken={getToken} units={profile?.unit_system ?? 'metric'} />

            {/* Records sit between the training summary and the profile facts:
                they're the payoff for the logging above, and the thing people
                actually open this tab to look at. */}
            <RecordsCard getToken={getToken} units={profile?.unit_system ?? 'metric'} />

            {/* After Records, before Profile. Records is what you have lifted;
                this is what you are learning — both are payoffs for logging,
                and both belong above the account facts. It renders nothing at
                all for an athlete on no roadmap with no focus, so a
                strength-only account never sees an empty BJJ block. */}
            <RoadmapSummary />

            <Text style={styles.sectionLabel}>Profile</Text>
            <View style={styles.card}>
              <Row
                label="Sports"
                value={
                  enabledLabels === null
                    ? '—'
                    : enabledLabels.length
                      ? enabledLabels.join(' · ')
                      : 'None chosen yet'
                }
              />
              <Row
                label="Units"
                value={
                  UNIT_SYSTEMS.find((u) => u.key === profile?.unit_system)?.detail ??
                  'kilograms · metres'
                }
              />
              {profile?.date_of_birth && <Row label="Born" value={profile.date_of_birth} />}
            </View>
          </>
        )}
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
  action: { fontWeight: '700', fontSize: 14 },
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
