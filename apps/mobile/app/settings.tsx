import { useAuth } from '@clerk/clerk-expo';
import { Stack, useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';

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
              { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
            ])
          }
          testID="settings-sign-out"
        />
      </Section>

      <Section title="Preferences">
        <Row
          label="Units"
          hint="Kilograms or pounds"
          last
          onPress={() => router.push('/settings/units')}
          testID="settings-units"
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
  note: { color: vola.textDim, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
});
