import { useAuth } from '@clerk/clerk-expo';
import { clearSessionToken } from '@/lib/session';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAuth as useClerkAuth } from '@clerk/clerk-expo';

import { readAutoRest, writeAutoRest } from '@/lib/rest';
import { useTrackEffort } from '@/lib/useTrackEffort';

/**
 * Settings as grouped rows that drill down, rather than one flat screen of
 * controls.
 *
 * The shape matters more than it looks: this list is going to grow —
 * notifications, integrations, privacy, language — and a screen that gains a
 * new switch per feature becomes unnavigable long before it becomes
 * complete. Sections and drill-downs mean adding a preference is adding a
 * row, not redesigning the page.
 *
 * Sign out lives here, under Account, because that's where people look for
 * it. It confirms first: anything not yet synced is still on the device, and
 * signing out is the one action that can put it out of reach.
 */
export default function SettingsScreen() {
  const { signOut } = useAuth();
  const router = useRouter();

  const { userId } = useClerkAuth();
  const [autoRest, setAutoRest] = useState(false);
  useEffect(() => {
    if (userId) readAutoRest(userId).then(setAutoRest).catch(() => {});
  }, [userId]);

  const { trackEffort, setTrackEffort } = useTrackEffort();

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="settings-screen">
      <Stack.Screen options={{ title: 'Settings' }} />

      <Section title="Account">
        <Row label="Profile" hint="Name, sports, date of birth" onPress={() => router.push('/profile/edit')} testID="settings-profile" />
        <Row
          label="Sign out"
          danger
          last
          onPress={() =>
            Alert.alert('Sign out?', 'Anything not yet synced stays on this device.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Sign out',
                style: 'destructive',
                // Clear the brokered token too. It is persisted in the
                // keychain, so without this the next account on a shared
                // device inherits the previous athlete's credential until it
                // expires — the same leak the modules provider was caught
                // with. Cleared BEFORE signOut so no request can slip through
                // with the old token as the session tears down.
                onPress: () => {
                  void clearSessionToken().finally(() => signOut());
                },
              },
            ])
          }
          testID="settings-sign-out"
        />
      </Section>

      <Section title="Preferences">
        <Row
          label="Units"
          hint="Kilograms or pounds"
          onPress={() => router.push('/settings/units')}
          testID="settings-units"
        />
        <Toggle
          label="Auto rest timer"
          hint="Start the countdown when you tick a set off."
          value={autoRest}
          onChange={(on) => {
            setAutoRest(on);
            if (userId) writeAutoRest(userId, on).catch(() => setAutoRest(!on));
          }}
          testID="settings-auto-rest"
        />
        <Toggle
          label="Track effort"
          hint="RIR and RPE on every set. Off hides them."
          value={trackEffort}
          last
          onChange={(on) => void setTrackEffort(on)}
          testID="settings-effort"
        />
      </Section>

      <Text style={styles.note}>
        More preferences will land here as the app grows — notifications, integrations, and
        per-sport defaults.
      </Text>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.group}>{children}</View>
    </View>
  );
}

/** A row that changes something in place, rather than drilling down. */
function Toggle({
  label,
  hint,
  value,
  onChange,
  last,
  testID,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (on: boolean) => void;
  last?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      style={[styles.row, !last && styles.rowDivided]}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      testID={testID}
    >
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint && <Text style={styles.muted}>{hint}</Text>}
      </View>
      <View style={[styles.switch, value && styles.switchOn]}>
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

function Row({
  label,
  hint,
  onPress,
  danger,
  last,
  testID,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  danger?: boolean;
  last?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      style={[styles.row, !last && styles.rowDivided]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      testID={testID}
    >
      <View style={styles.rowBody}>
        <Text style={[styles.rowLabel, danger && styles.danger]}>{label}</Text>
        {hint && <Text style={styles.muted}>{hint}</Text>}
      </View>
      {!danger && <Text style={styles.chevron}>›</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 20, paddingBottom: 48 },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: 4,
  },
  group: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 58,
  },
  rowDivided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: vola.lineSoft },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 16, fontWeight: '600' },
  danger: { color: vola.danger },
  muted: { color: vola.textMuted, fontSize: 13 },
  chevron: { color: vola.textDim, fontSize: 22 },
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
  note: { color: vola.textDim, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
});
