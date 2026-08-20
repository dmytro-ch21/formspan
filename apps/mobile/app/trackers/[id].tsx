import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { SelectAllTextInput } from '@/components/SelectAllTextInput';
import { trackerFill, vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { useAuth } from '@clerk/clerk-expo';
import { localTrackers, updateTrackerLocally } from '@/lib/trackers';
import {
  inputUnitLabel,
  targetCount,
  unitNoun,
  pluralise,
  type Tracker,
} from '@/lib/trackerModel';
import { request as requestSync } from '@/lib/sync';
import { fromDisplayFluid, toDisplayFluid } from '@/lib/units';
import { useUnits } from '@/lib/useUnits';

/**
 * A tracker's settings, ON THE PHONE.
 *
 * **This screen exists because of a hard rule**, not because a tracker needed a
 * detail view: *"everything should be managable on the phone"*. The failure
 * that rule was written from is exactly this shape — `nutrition-design.md` put
 * target-setting on "one web screen", so an athlete looking at a target on
 * their phone could see the reasoning and had no way to disagree with it. A
 * water target you can only change at a desk would be the same defect, a
 * feature later.
 *
 * There is no web counterpart yet, and that is fine in this direction: the rule
 * forbids phone-impossible, not web-absent.
 *
 * ## It writes locally first
 *
 * `updateTrackerLocally` marks the row dirty and the outbox pushes it, so
 * changing a target works with no signal — the same guarantee a tap has. The
 * screen never awaits the network.
 *
 * ## The target is entered in TAPS, not in millilitres
 *
 * "Eight glasses" is the sentence an athlete says; "two thousand millilitres"
 * is the sentence a database says. So the field takes a count and multiplies by
 * the increment, and the millilitre figure is shown underneath as a
 * consequence. The increment gets its own field in the athlete's display unit
 * (`ml` or `fl oz`), because that is the one number where the actual volume is
 * what you know — a bottle says 500 ml or 16.9 fl oz on the side of it.
 */
export default function TrackerSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const { units, unitsReady } = useUnits();

  const [tracker, setTracker] = useState<Tracker | null>(null);
  const [missing, setMissing] = useState(false);
  const [countText, setCountText] = useState('');
  const [incrementText, setIncrementText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (!userId || !id) return;
      void localTrackers(userId).then((view) => {
        if (!live) return;
        const found = view.state === 'ready' ? view.trackers.find((t) => t.id === id) : undefined;
        if (!found) {
          setMissing(true);
          return;
        }
        setTracker(found);
        const target = targetCount(found);
        setCountText(target == null ? '' : String(target));
        setIncrementText(
          found.unit === 'ml'
            ? String(toDisplayFluid(found.increment, units))
            : String(found.increment),
        );
      });
      return () => {
        live = false;
      };
      // `units` is in the deps because the increment field is rendered in the
      // athlete's display unit: switching the preference while this screen is
      // open must re-derive the number rather than reinterpret 500 ml as 500
      // fl oz.
    }, [userId, id, units]),
  );

  async function save() {
    if (!tracker || !userId) return;
    const trimmed = countText.trim();
    const incrementValue = Number(incrementText.trim());
    if (!Number.isFinite(incrementValue) || incrementValue <= 0) {
      setError('A tap has to add something. Enter a number greater than zero.');
      return;
    }
    const increment =
      tracker.unit === 'ml' ? fromDisplayFluid(incrementValue, units) : incrementValue;

    // An empty target field means NO target — a count with no ceiling, which is
    // a real thing to want and the state N77's coffee card is built on. It is
    // sent as an explicit `null`, which the patch distinguishes from "leave it
    // alone"; a `?? undefined` here would silently make clearing impossible.
    let target: number | null = null;
    if (trimmed !== '') {
      const count = Number(trimmed);
      if (!Number.isFinite(count) || count <= 0) {
        setError('Enter how many you are aiming for, or leave it blank for no target.');
        return;
      }
      target = count * increment;
    }

    try {
      // Only the two fields this screen edits. The name, icon, colour and unit
      // are not in the patch and are therefore not written — the whole point of
      // the partial write path, and the reason an edit here cannot blank
      // something a later screen authored.
      await updateTrackerLocally(userId, tracker.id, { increment, target });
      requestSync('tracker target changed');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be saved.');
    }
  }

  function confirmArchive() {
    if (!tracker) return;
    Alert.alert(
      `Stop tracking ${tracker.name}?`,
      // Says what survives, because "delete" and "archive" mean different
      // things and only one of them is happening here.
      'It leaves Today and Food. Everything you have already logged is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop tracking',
          style: 'destructive',
          onPress: () => {
            // Deliberately not implemented in this ticket: archiving is a
            // one-line call, but a tracker with no way back is a trap, and the
            // "archived" list it needs is N78's screen. Shown as unavailable
            // rather than hidden, so the capability is legible.
            setError('Stopping a tracker arrives with custom trackers.');
          },
        },
      ],
    );
  }

  if (missing) {
    return (
      <ScreenShell title="Tracker">
        <Text style={styles.note} testID="tracker-settings-missing">
          That tracker is not on this device. Pull Today down to refresh, or check your
          connection.
        </Text>
      </ScreenShell>
    );
  }

  if (!tracker || !unitsReady) {
    return (
      <ScreenShell title="Tracker">
        <Text style={styles.note} testID="tracker-settings-loading">
          Loading…
        </Text>
      </ScreenShell>
    );
  }

  const noun = unitNoun(tracker);
  const fill = trackerFill(tracker.color_key);
  const unitLabel = inputUnitLabel(tracker, units);

  return (
    <ScreenShell title={tracker.name}>
      <Text style={styles.label}>
        {`Daily target${noun ? `, in ${pluralise(noun, 2)}` : ''}`}
      </Text>
      <SelectAllTextInput
        style={styles.input}
        value={countText}
        onChangeText={(t) => {
          setCountText(t);
          setError(null);
        }}
        keyboardType="number-pad"
        placeholder="No target"
        placeholderTextColor={vola.textDim}
        testID="tracker-target-input"
      />
      <Text style={styles.hint}>
        Leave it blank to just count, with nothing to reach.
      </Text>

      <Text style={styles.label}>
        {`One tap adds${unitLabel ? ` (${unitLabel})` : ''}`}
      </Text>
      <SelectAllTextInput
        style={styles.input}
        value={incrementText}
        onChangeText={(t) => {
          setIncrementText(t);
          setError(null);
        }}
        keyboardType="decimal-pad"
        testID="tracker-increment-input"
      />

      {error ? (
        <Text style={styles.error} testID="tracker-settings-error">
          {error}
        </Text>
      ) : null}

      <Pressable
        onPress={save}
        style={[styles.save, { backgroundColor: accent.accent }]}
        accessibilityRole="button"
        testID="tracker-settings-save"
      >
        <Text style={[styles.saveText, { color: accent.on }]}>Save</Text>
      </Pressable>

      <Pressable
        onPress={confirmArchive}
        style={styles.secondary}
        accessibilityRole="button"
        testID="tracker-settings-archive"
      >
        <Text style={[styles.secondaryText, { color: fill }]}>Stop tracking {tracker.name}</Text>
      </Pressable>
    </ScreenShell>
  );
}

function ScreenShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title }} />
      {/* The shared container, not a bare ScrollView: two number fields here
          sit low enough on a small phone that the keyboard covers them, and
          `keyboardCoverage.test.ts` enforces the import precisely because
          twelve screens out of thirteen once reinvented some fraction of this
          and one reinvented nothing. */}
      <KeyboardAwareScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  container: { padding: 20, gap: 10, paddingBottom: 60 },
  label: { fontSize: 12, fontWeight: '800', letterSpacing: 1.2, color: vola.textMuted, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    color: vola.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    fontWeight: '700',
  },
  hint: { fontSize: 12, color: vola.textDim },
  note: { fontSize: 14, color: vola.textMuted },
  error: { fontSize: 13, color: vola.danger, fontWeight: '600' },
  save: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  saveText: { fontSize: 15, fontWeight: '800' },
  secondary: { paddingVertical: 14, alignItems: 'center' },
  secondaryText: { fontSize: 14, fontWeight: '700' },
});
