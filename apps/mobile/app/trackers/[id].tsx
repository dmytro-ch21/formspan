import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import {
  TrackerForm,
  formFor,
  readDraft,
  type TrackerFormState,
} from '@/components/TrackerForm';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { useAuth } from '@clerk/clerk-expo';
import { archiveTrackerLocally, localTrackers, updateTrackerLocally } from '@/lib/trackers';
import { type Tracker } from '@/lib/trackerModel';
import { request as requestSync } from '@/lib/sync';
import { useUnits } from '@/lib/useUnits';

/**
 * A tracker's settings, ON THE PHONE.
 *
 * **This screen exists because of a hard rule**, not because a tracker needed a
 * detail view: *"everything should be managable on the phone"*. The failure
 * that rule was written from is exactly this shape — `nutrition-design.md` put
 * target-setting on "one web screen", so an athlete looking at a target on
 * their phone could see the reasoning and had no way to disagree with it.
 *
 * There is no web counterpart yet, and that is fine in this direction: the rule
 * forbids phone-impossible, not web-absent.
 *
 * ## It edits EVERY field now, not two
 *
 * N76 shipped this with a target and an increment, because those were the only
 * two fields water had that an athlete might disagree with. N78 lets them name
 * the thing, so the name, icon, colour, unit and the word for one tap are all
 * theirs to change — through the same `TrackerForm` the create screen uses, so
 * the two cannot drift.
 *
 * ## It writes locally first
 *
 * `updateTrackerLocally` marks the row dirty and the outbox pushes it, so
 * changing anything works with no signal — the same guarantee a tap has. The
 * screen never awaits the network.
 *
 * ## Stopping it is real now
 *
 * N76 showed this control as unavailable and said why: *"a tracker with no way
 * back is a trap, and the 'archived' list it needs is N78's screen"*. That
 * screen is `app/trackers/archived.tsx`, so stopping one is now reversible and
 * the control does what it says. **Deleting is deliberately NOT here** — it
 * lives on the archived screen, one step further from the thing an athlete
 * opens to change a number, because the two must not sit side by side.
 */
export default function TrackerSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const { units, unitsReady } = useUnits();

  const [tracker, setTracker] = useState<Tracker | null>(null);
  const [form, setForm] = useState<TrackerFormState | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (!userId || !id || !unitsReady) return;
      void localTrackers(userId).then((view) => {
        if (!live) return;
        const found = view.state === 'ready' ? view.trackers.find((t) => t.id === id) : undefined;
        if (!found) {
          setMissing(true);
          return;
        }
        // CLEARED on the found branch. Without this, one lookup that missed —
        // a race with the first cache fill, a deep link before any fetch, a
        // `view.state === 'unknown'` — pinned "not on this device" forever,
        // because the `missing` branch renders before `tracker` is consulted.
        setMissing(false);
        setTracker(found);
        setForm(formFor(found, units));
      });
      return () => {
        live = false;
      };
      // `units` is in the deps because the increment field is rendered in the
      // athlete's display unit: switching the preference while this screen is
      // open must re-derive the number rather than reinterpret 500 ml as 500
      // fl oz. `unitsReady` too, so the form is never built from a default that
      // is about to change.
    }, [userId, id, units, unitsReady]),
  );

  async function save() {
    if (!tracker || !userId || !form) return;
    const read = readDraft(form, units);
    if ('error' in read) {
      setError(read.error);
      return;
    }
    try {
      // Every field this form edits, and nothing else. `preset`, `sort_order`,
      // `archived_at` and the identity are absent from the patch and are
      // therefore not written — the partial-write path is what stops an edit
      // here reordering somebody's Today or un-archiving a stopped tracker.
      await updateTrackerLocally(userId, tracker.id, read.draft);
      requestSync('tracker changed');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be saved.');
    }
  }

  function confirmArchive() {
    if (!tracker || !userId) return;
    Alert.alert(
      `Stop tracking ${tracker.name}?`,
      // Says what survives and where it goes, because "stop" and "delete" mean
      // different things and only one of them is happening here.
      'It leaves Today and Food. Everything you have already logged is kept, and you ' +
        'can start it again from Stopped trackers.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop tracking',
          style: 'destructive',
          onPress: () => {
            void archiveTrackerLocally(userId, tracker.id)
              .then(() => {
                requestSync('tracker stopped');
                router.back();
              })
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : 'That could not be stopped.');
              });
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

  if (!tracker || !form || !unitsReady) {
    return (
      <ScreenShell title="Tracker">
        <Text style={styles.note} testID="tracker-settings-loading">
          Loading…
        </Text>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title={tracker.name}>
      <TrackerForm value={form} onChange={setForm} units={units} />

      {error ? (
        <Text style={styles.error} testID="tracker-settings-error">
          {error}
        </Text>
      ) : null}

      <Pressable
        onPress={() => void save()}
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
        accessibilityHint="It leaves Today. Everything you logged is kept."
        testID="tracker-settings-archive"
      >
        <Text style={styles.secondaryText}>Stop tracking {tracker.name}</Text>
      </Pressable>
    </ScreenShell>
  );
}

function ScreenShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title }} />
      {/* The shared container, not a bare ScrollView: the number fields here
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
  container: { padding: 20, paddingBottom: 60 },
  note: { fontSize: 14, color: vola.textMuted },
  error: { fontSize: 13, color: vola.danger, fontWeight: '600', marginTop: 12 },
  save: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  saveText: { fontSize: 15, fontWeight: '800' },
  secondary: { paddingVertical: 14, alignItems: 'center' },
  secondaryText: { fontSize: 14, fontWeight: '700', color: vola.textMuted },
});
