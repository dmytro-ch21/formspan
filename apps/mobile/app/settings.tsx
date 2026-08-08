import { useAuth } from '@clerk/clerk-expo';
import { clearSessionToken } from '@/lib/session';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { accents, vola, type AccentName } from '@/constants/Colors';
import { Icon } from '@/components/ui/Icon';
import { useAccent, useAccentChoice } from '@/lib/AccentProvider';
import { useAuth as useClerkAuth } from '@clerk/clerk-expo';

import { readAutoRest, writeAutoRest } from '@/lib/rest';
import { playSound, readSoundsEnabled, writeSoundsEnabled } from '@/lib/sounds';
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
  // Default on: the chime is the point of a timer you are not looking at.
  const [sounds, setSounds] = useState(true);
  useEffect(() => {
    if (userId) readAutoRest(userId).then(setAutoRest).catch(() => {});
    if (userId) readSoundsEnabled(userId).then(setSounds).catch(() => {});
  }, [userId]);

  const { trackEffort, setTrackEffort, unsynced: effortUnsynced } = useTrackEffort();

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
                // Cleared on BOTH sides of signOut, deliberately.
                //
                // Before, so no request slips through with the old token while
                // the session tears down. After, because until `signOut()`
                // actually completes Clerk will still happily mint a fresh
                // token — so an outbox drain running concurrently could
                // re-populate the cache and the keychain in the gap. The
                // second clear closes that window; the epoch counter in
                // session.ts closes the in-flight variant of it.
                //
                // `signOut()` is awaited rather than fire-and-forget: rejecting
                // it unhandled (it can, offline) was its own small bug.
                onPress: () => {
                  void (async () => {
                    await clearSessionToken();
                    try {
                      await signOut();
                    } catch {
                      // Offline sign-out can fail. The local credential is
                      // already gone, which is the part that matters here.
                    }
                    await clearSessionToken();
                  })();
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
        <AccentRow />
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
          label="Sounds"
          hint="Rests, timed sets, finishing a session, and when someone's waiting on you."
          value={sounds}
          onChange={(on) => {
            setSounds(on);
            // `writeSoundsEnabled` BEFORE the preview, which is the opposite of
            // how it reads: it flips the module's flag synchronously before its
            // first await, and `playSound` checks that flag. Previewing first
            // meant the OFF -> ON preview was itself muted — the one case the
            // preview exists for answered "did that work?" with silence.
            if (userId) writeSoundsEnabled(userId, on).catch(() => {});
            // Turning it ON previews the sound, so the toggle answers for
            // itself rather than sending you off to start a rest. Off makes no
            // noise, for the obvious reason.
            if (on) playSound('restComplete');
          }}
          testID="settings-sounds"
        />
        <Row
          label="Suggestions"
          hint="What VOLA suggests, and what you've told it to stop suggesting."
          onPress={() => router.push('/settings/suggestions')}
          testID="settings-suggestions"
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

      {/* Same admission the units screen makes, for the same reason: this
          preference is on the account, so "changed here only" is a different
          outcome from "changed". It used to be neither surfaced nor even
          recorded — the toggle would quietly flip back once the app next
          reached the server. */}
      {effortUnsynced && (
        <Text style={styles.unsynced} accessibilityLiveRegion="polite" testID="effort-unsynced">
          Effort tracking changed on this phone, but not yet on your account — the web app will
          still use the old setting until you&apos;re back online.
        </Text>
      )}

      <Text style={styles.note}>
        More preferences will land here as the app grows — notifications, integrations, and
        per-sport defaults.
      </Text>
    </ScrollView>
  );
}

/**
 * The accent picker — swatches in the settings list, not a screen of its own.
 *
 * Units is a sub-screen and this deliberately is not. A unit system is a fact
 * you set once and verify by reading a word; an accent is a *look*, and the
 * only way to judge it is to see it applied. Tapping a swatch here recolours
 * the tab bar two inches below and the section links above it, immediately —
 * which is the entire decision, and a push-and-return would hide it behind a
 * transition.
 *
 * **Selection is never carried by colour alone.** The chosen swatch takes a
 * ring and a tick; the others take neither. That matters more here than
 * anywhere else in the app, because the thing being chosen *is* colour, so a
 * colour-coded selection marker is unreadable for exactly the people most
 * likely to be choosing carefully.
 */
function AccentRow() {
  const { name, choose } = useAccentChoice();

  return (
    <View style={styles.accentRow}>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>Accent</Text>
        <Text style={styles.muted}>Buttons, links and the active tab.</Text>
      </View>
      <RNView
        style={styles.swatches}
        accessibilityRole="radiogroup"
        accessibilityLabel="Accent colour"
      >
        {(Object.keys(accents) as AccentName[]).map((key) => {
          const a = accents[key];
          const on = key === name;
          return (
            <Pressable
              key={key}
              onPress={() => void choose(key)}
              hitSlop={6}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={a.label}
              testID={`accent-${key}`}
              style={[
                styles.swatch,
                { backgroundColor: a.accent },
                on && { borderColor: vola.text },
              ]}
            >
              {on && <Icon name="check" size={13} color={a.on} strokeWidth={2.6} />}
            </Pressable>
          );
        })}
      </RNView>
    </View>
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
  const accent = useAccent();
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
      <View style={[styles.switch, value && [styles.switchOn, { backgroundColor: accent.accent }]]}>
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
  unsynced: { color: vola.warn, fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
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

  // Its own row shape rather than `Row`'s: the swatches need the full width
  // under the label, not a value chip beside it.
  accentRow: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
  },
  swatches: { flexDirection: 'row', gap: 12 },
  swatch: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    // Always bordered, transparent until chosen — so picking one does not
    // shift the row by 2pt.
    borderWidth: 2,
    borderColor: 'transparent',
  },
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
  switchOn: {},
  knob: { width: 24, height: 24, borderRadius: 999, backgroundColor: vola.surface },
  knobOn: { alignSelf: 'flex-end', backgroundColor: vola.navy },
  note: { color: vola.textDim, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
});
