import { Stack, useFocusEffect, useRouter, type Href } from 'expo-router';
import { useAuth } from '@clerk/clerk-expo';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { blockedRows, retryBlockedRow, type BlockedRow } from '@/lib/sessionStore';
import { syncNow, useSyncState } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * What is stuck, why, and one button per row to do something about it.
 *
 * **The gap: a permanent rejection had nowhere to live.** It surfaced as a
 * single screen-level message for the whole run and vanished on the next
 * attempt — so a session the server will refuse forever looked exactly like
 * one that simply had not been tried yet. There was no way to see which row,
 * no way to see what the server actually said, and no way to retry just that
 * one after fixing it. Schema v11 stores the message on the row; this screen
 * is where it is answerable.
 *
 * **Only permanent refusals are listed.** A transient failure is the ordinary
 * state of a phone in a basement and resolves itself; listing those would
 * turn a repair list into a list of everything ever logged offline, and
 * nothing on it would need a person. The distinction is made when the error
 * is recorded, not here.
 *
 * **Empty is the good state and says so plainly.** An empty repair screen is
 * reassuring rather than broken, which is worth wording carefully — this is a
 * screen people reach when they are already worried about their training.
 *
 * **Every row opens the thing it is about.** It did not, and that made the
 * screen a dead end: it would say `set 10: weight must be greater than 0`,
 * offer Try again — which replays the same doomed request — and give no route
 * to set 10. "Try again" is the right answer only for a row whose obstacle has
 * moved on its own; anything the athlete has to change needs the screen that
 * can change it.
 */
export default function SyncScreen() {
  const accent = useAccent();
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const router = useRouter();
  const state = useSyncState();
  const [rows, setRows] = useState<BlockedRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      setRows(await blockedRows(userId));
    } catch {
      // A failed read of the repair list must not itself become an error
      // state on the repair screen. `null` keeps the honest "still loading"
      // rather than claiming nothing is wrong.
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function retry(row: BlockedRow) {
    if (!userId) return;
    setBusy(row.id);
    try {
      await retryBlockedRow(userId, row, getToken);
    } catch {
      // The row keeps (or regains) its recorded error; `load` below re-reads
      // it, so a still-failing retry is reported by the list rather than by a
      // separate transient message that would disagree with it.
    } finally {
      setBusy(null);
      await load();
    }
  }

  return (
    <View style={styles.container} testID="sync-screen">
      <Stack.Screen options={{ title: 'Sync' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.summary}>
          <Text style={styles.summaryLine}>
            {state.online ? 'Connected' : 'No connection'}
          </Text>
          {state.pending > 0 && (
            <Text style={styles.summaryDim}>
              {state.pending} {state.pending === 1 ? 'item' : 'items'} waiting to sync
            </Text>
          )}
          {state.deferred > 0 && (
            // Named separately from `pending` because it is not a problem:
            // these resolve themselves once the plan they depend on lands.
            <Text style={styles.summaryDim}>
              {state.deferred} waiting on a plan that hasn&apos;t synced yet
            </Text>
          )}
        </View>

        <Pressable
          onPress={() => void syncNow().then(load)}
          style={styles.syncButton}
          accessibilityRole="button"
          accessibilityLabel="Sync now"
          testID="sync-now"
        >
          <Text style={styles.syncButtonText}>
            {state.syncing ? 'Syncing…' : 'Sync now'}
          </Text>
        </Pressable>

        {rows === null ? (
          <ActivityIndicator accessibilityLabel="Loading" style={styles.spinner} />
        ) : rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing is stuck</Text>
            <Text style={styles.emptyBody}>
              Anything still waiting will go out on its own when you have signal.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            <Text style={styles.listHeading}>Needs your attention</Text>
            {rows.map((row) => (
              <View key={`${row.kind}:${row.id}`} style={styles.row}>
                <Text style={styles.rowName}>{row.name || 'Untitled'}</Text>
                <Text style={styles.rowKind}>{row.kind}</Text>
                {/* The server's own words. The API writes these for cases a
                    person can act on, so paraphrasing would lose the only
                    part that says what to do. */}
                <Text style={styles.rowError}>{row.lastError}</Text>
                <View style={styles.rowActions}>
                  {/* First, and worded as the destination rather than as
                      "Open": the message above has just named a set, and the
                      next thing an athlete wants is to be standing in front of
                      it. Try again keeps its place for the rows whose obstacle
                      really has cleared on its own. */}
                  <Pressable
                    onPress={() => router.push(destinationOf(row))}
                    style={styles.rowAction}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${row.name || 'this item'} to fix it`}
                    testID={`open-${row.id}`}
                  >
                    <Text style={[styles.retryText, { color: accent.ink }]}>
                      {row.kind === 'workout' ? 'Open the plan' : 'Open the session'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void retry(row)}
                    disabled={busy === row.id}
                    style={styles.rowAction}
                    accessibilityRole="button"
                    accessibilityLabel={`Retry ${row.name}`}
                    accessibilityState={{ busy: busy === row.id, disabled: busy === row.id }}
                    testID={`retry-${row.id}`}
                  >
                    <Text style={styles.retryMuted}>
                      {busy === row.id ? 'Trying…' : 'Try again'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Where a blocked row lives.
 *
 * A BJJ session and a strength session are separate screens — `/session/[id]`
 * knows only about sets, and sending a class there is the bug that made a
 * logged class open to "Sets 0 · Reps 0 · Volume —". So the sport rides along
 * on the row rather than being guessed here.
 */
export function destinationOf(row: BlockedRow): Href {
  if (row.kind === 'workout') return `/workout/${row.id}`;
  return row.sport === 'bjj' ? `/bjj/session/${row.id}` : `/session/${row.id}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 16 },
  summary: { gap: 4 },
  summaryLine: { fontSize: 17, fontWeight: '700' },
  summaryDim: { fontSize: 14, color: vola.textMuted },
  syncButton: {
    backgroundColor: vola.surface,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  syncButtonText: { fontSize: 15, fontWeight: '600' },
  spinner: { marginTop: 24 },
  empty: { gap: 6, paddingTop: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptyBody: { fontSize: 14, color: vola.textMuted, lineHeight: 20 },
  list: { gap: 10 },
  listHeading: { fontSize: 13, fontWeight: '700', color: vola.textMuted },
  row: { backgroundColor: vola.surface, borderRadius: 12, padding: 14, gap: 6 },
  rowName: { fontSize: 15, fontWeight: '700' },
  rowKind: { fontSize: 12, color: vola.textMuted, textTransform: 'capitalize' },
  rowError: { fontSize: 13, color: vola.danger, lineHeight: 18 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  rowAction: { paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  retryText: { fontSize: 14, fontWeight: '600' },
  // Deliberately quieter than the accent-coloured Open beside it. Replaying a
  // request the server has already refused is the second-best answer here, and
  // two equally loud buttons would make it look like a coin toss.
  retryMuted: { fontSize: 14, fontWeight: '600', color: vola.textMuted },
});
