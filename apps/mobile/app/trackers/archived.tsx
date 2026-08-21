import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView, View } from 'react-native';

import { HoldToConfirm } from '@/components/HoldToConfirm';
import { Text } from '@/components/Themed';
import { trackerFill, vola } from '@/constants/Colors';
import { request as requestSync } from '@/lib/sync';
import {
  cacheArchivedTrackers,
  destroyTrackerLocally,
  localArchivedTrackers,
  restoreTrackerLocally,
} from '@/lib/trackers';
import * as api from '@/lib/trackersApi';
import { unitNoun, pluralise, type Tracker } from '@/lib/trackerModel';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The trackers an athlete has stopped — and the only place anything is
 * genuinely destroyed.
 *
 * ## The screen N76 said it needed
 *
 * N76 shipped archiving with the control showing as unavailable, and said why:
 * *"a tracker with no way back is a trap, and the 'archived' list it needs is
 * N78's screen"*. This is it. Without it, stopping a tracker is a one-way door
 * dressed up as a reversible action.
 *
 * ## Stopping and deleting are different, and the copy has to carry that
 *
 * They are two controls, two gestures and two sentences:
 *
 * - **Restore** is a tap. It is reversible, so it costs nothing.
 * - **Delete** is a HOLD, and it names what goes: the tracker AND every entry
 *   it ever recorded. N78: *"deleting must be distinct from archiving and must
 *   say what it destroys"*. A hold rather than a confirm dialog because a
 *   dialog's destructive button is one stray tap away on a screen full of rows,
 *   and `HoldToConfirm` already carries the screen-reader path for people who
 *   cannot hold.
 *
 * A tracker VOLA set up for you (water) can be stopped but not deleted: the row
 * is what records that provisioning already happened, so deleting it would hand
 * the tracker straight back on the next list and the delete would silently undo
 * itself. The row says so rather than offering a control that lies.
 */
export default function ArchivedTrackersScreen() {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const [trackers, setTrackers] = useState<Tracker[] | null>(null);
  const [presets, setPresets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const rows = await localArchivedTrackers(userId);
    setTrackers(rows);
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (!userId) return;
      // Cache first, then the network, then re-read — the same sequencing
      // `useTrackerDay` uses, and for the same reason: started in parallel, a
      // slow SQLite read can land after a fast network answer and overwrite it.
      void load()
        .catch(() => {})
        .then(() => api.listArchivedTrackers(getToken))
        .then(async (rows) => {
          if (!live) return;
          // `cacheArchivedTrackers`, NOT `cacheTrackers`. The latter archives
          // everything the response did not contain, which against a response
          // that deliberately contains only archived rows would archive the
          // athlete's entire Today.
          await cacheArchivedTrackers(userId, rows);
          setPresets(Object.fromEntries(rows.map((r) => [r.id, r.preset])));
          if (live) await load();
        })
        .catch(() => {
          // Offline. Whatever this device knows stands; restoring still works,
          // because it is written locally and pushed.
        });
      return () => {
        live = false;
      };
    }, [userId, getToken, load]),
  );

  async function restore(t: Tracker) {
    if (!userId) return;
    try {
      await restoreTrackerLocally(userId, t.id);
      requestSync('tracker restored');
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be restored.');
    }
  }

  async function destroy(t: Tracker) {
    if (!userId) return;
    try {
      await destroyTrackerLocally(userId, t.id);
      requestSync('tracker deleted');
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be deleted.');
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Stopped trackers' }} />
      <ScrollView contentContainerStyle={styles.container}>
        {trackers === null ? (
          <Text style={styles.note} testID="trackers-archived-loading">
            Loading…
          </Text>
        ) : trackers.length === 0 ? (
          <Text style={styles.note} testID="trackers-archived-empty">
            You have not stopped any trackers. Everything you stop stays here, with its
            history, until you delete it.
          </Text>
        ) : (
          trackers.map((t) => {
            // A preset row is one VOLA provisions. Read from the SERVER's
            // answer where we have it and from the cached row otherwise —
            // `preset` is on both, and this is only deciding whether to offer a
            // control, never a permission.
            const provisioned = (presets[t.id] ?? t.preset) !== '';
            return (
              <RNView key={t.id} style={styles.card}>
                <RNView style={styles.head}>
                  <RNView style={[styles.dot, { backgroundColor: trackerFill(t.color_key) }]} />
                  <Text style={styles.name}>
                    {t.icon ? `${t.icon}  ` : ''}
                    {t.name}
                  </Text>
                </RNView>
                <Text style={styles.meta}>
                  Stopped. Everything you logged is kept
                  {unitNoun(t) ? `, in ${pluralise(unitNoun(t), 2)}` : ''}.
                </Text>

                <Pressable
                  onPress={() => void restore(t)}
                  style={styles.restore}
                  accessibilityRole="button"
                  accessibilityLabel={`Start tracking ${t.name} again`}
                  testID={`tracker-restore-${t.id}`}
                >
                  <Text style={styles.restoreText}>Start tracking it again</Text>
                </Pressable>

                {provisioned ? (
                  <Text style={styles.locked} testID={`tracker-undeletable-${t.id}`}>
                    {`VOLA sets ${t.name} up for you, so it cannot be deleted — it would come `+
                      `back. Leaving it stopped keeps it off Today.`}
                  </Text>
                ) : (
                  <HoldToConfirm
                    label={`Delete ${t.name} and its history`}
                    holdingLabel="Keep holding to delete…"
                    onConfirm={() => void destroy(t)}
                    confirmTitle={`Delete ${t.name}?`}
                    // Says exactly what goes. The tracker AND the entries — the
                    // cascade is real (migration 000068), so this is a promise
                    // the database keeps rather than a warning.
                    confirmBody={
                      `This deletes ${t.name} and every ${unitNoun(t) || 'entry'} you ever ` +
                      `logged for it. It cannot be undone. To keep the history, leave it stopped.`
                    }
                    destructive
                    fillColor={vola.danger}
                    style={styles.delete}
                    testID={`tracker-delete-${t.id}`}
                  />
                )}
              </RNView>
            );
          })
        )}

        {error ? (
          <Text style={styles.error} testID="trackers-archived-error">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  container: { padding: 20, gap: 12, paddingBottom: 60 },
  note: { fontSize: 14, color: vola.textMuted, lineHeight: 20 },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 10,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { fontSize: 15, fontWeight: '700', color: vola.text, flex: 1 },
  meta: { fontSize: 12, color: vola.textMuted },
  restore: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  restoreText: { fontSize: 14, fontWeight: '700', color: vola.text },
  delete: { borderRadius: 10 },
  locked: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  error: { fontSize: 13, color: vola.danger, fontWeight: '600' },
});
