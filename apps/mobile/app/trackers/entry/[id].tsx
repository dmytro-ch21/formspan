import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { SelectAllTextInput } from '@/components/SelectAllTextInput';
import { Text } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { displayAmount, readAmount } from '@/lib/entryEdit';
import { request as requestSync } from '@/lib/sync';
import { inputUnitLabel, isMeasuredUnit, type Tracker, type TrackerEntry } from '@/lib/trackerModel';
import { editCoffeeTap, editTap, localEntry, localTrackers } from '@/lib/trackers';
import { useUnits } from '@/lib/useUnits';
import { useAuth } from '@clerk/clerk-expo';

/**
 * Correct one logged tap's amount, on the phone — N437.
 *
 * Opened by a long press on a filled glyph, or by that glyph's "Change amount"
 * accessibility action. Before this, a mistaken tap could only be removed and
 * re-added, and re-adding logs the tracker's increment again: a 500 ml bottle
 * tapped as a 250 ml glass had no way to be recorded as what it was.
 *
 * **It changes the amount and nothing else.** The day and the moment are when
 * the tap happened, and removing a tap stays where it was, on the glyph's own
 * tap. Nothing here reaches the network: `editTap` writes SQLite and marks the
 * row owed, and the outbox sends the correction when it can.
 *
 * A coffee tap goes through `editCoffeeTap`, which scales the caffeine entry it
 * caused by the same ratio. That is the one preset-aware line here, for the
 * reason `TrackerList` keeps its own: the card, and this screen's field, stay
 * generic.
 */
export default function TrackerEntryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const { units, unitsReady } = useUnits();

  const [entry, setEntry] = useState<TrackerEntry | null>(null);
  const [tracker, setTracker] = useState<Tracker | null>(null);
  const [text, setText] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (!userId || !id || !unitsReady) return;
      void Promise.all([localEntry(userId, id), localTrackers(userId)]).then(([found, view]) => {
        if (!live) return;
        const owner =
          found && view.state === 'ready'
            ? view.trackers.find((t) => t.id === found.tracker_id)
            : undefined;
        if (!found || !owner) {
          setMissing(true);
          return;
        }
        setMissing(false);
        setEntry(found);
        setTracker(owner);
        // Shown in the athlete's own unit, and compared back in `save` so an
        // untouched field writes nothing — see `lib/entryEdit.ts`.
        setText(displayAmount(owner.unit, found.amount, units));
      });
      return () => {
        live = false;
      };
    }, [userId, id, units, unitsReady]),
  );

  async function save() {
    if (!entry || !tracker || !userId) return;
    const read = readAmount(text, tracker.unit, entry.amount, units);
    if ('error' in read) {
      setError(read.error);
      return;
    }
    if (!read.changed) {
      // Nothing to correct, so nothing is written and nothing is owed.
      router.back();
      return;
    }
    try {
      if (tracker.preset === 'coffee') {
        await editCoffeeTap(userId, entry.id, read.amount);
      } else {
        await editTap(userId, entry.id, read.amount);
      }
      requestSync('tracker tap corrected');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be saved.');
    }
  }

  if (missing) {
    return (
      <ScreenShell title="Entry">
        <Text style={styles.note} testID="tracker-entry-missing">
          That entry is not on this device any more. It may have been removed, here or on another
          device.
        </Text>
      </ScreenShell>
    );
  }

  if (!entry || !tracker || !unitsReady) {
    return (
      <ScreenShell title="Entry">
        <Text style={styles.note} testID="tracker-entry-loading">
          Loading…
        </Text>
      </ScreenShell>
    );
  }

  // A measured unit is named; a cup, a dose or a count is the number itself.
  const measured = isMeasuredUnit(tracker.unit);
  const label = measured ? `Amount, in ${inputUnitLabel(tracker, units)}` : 'Amount';

  return (
    <ScreenShell title={tracker.name}>
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <SelectAllTextInput
          style={styles.input}
          value={text}
          onChangeText={(t) => {
            setText(t);
            setError(null);
          }}
          keyboardType="decimal-pad"
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          accessibilityLabel={label}
          testID="tracker-entry-amount"
        />
        {tracker.preset === 'coffee' ? (
          <Text style={styles.hint} testID="tracker-entry-caffeine-hint">
            If this cup logged caffeine, that changes by the same ratio.
          </Text>
        ) : null}
      </View>

      {error ? (
        <Text style={styles.error} testID="tracker-entry-error">
          {error}
        </Text>
      ) : null}

      <PressableScale
        onPress={() => void save()}
        style={[styles.save, { backgroundColor: accent.accent }]}
        accessibilityRole="button"
        testID="tracker-entry-save"
      >
        <Text style={[styles.saveText, { color: accent.on }]}>Save</Text>
      </PressableScale>
    </ScreenShell>
  );
}

function ScreenShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title }} />
      {/* The shared container, as on the tracker settings screen: the number
          field has to stay above the keyboard on a small phone, and
          `keyboardCoverage.test.ts` holds every such screen to this import. */}
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
  field: { gap: 6, marginTop: 14 },
  label: { fontSize: 12, fontWeight: '800', letterSpacing: 1.2, color: vola.textMuted },
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
});
