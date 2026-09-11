import { Stack, useFocusEffect, useRouter, type Href } from 'expo-router';
import { useAuth } from '@clerk/clerk-expo';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { triggerBiometricSyncNow } from '@/lib/biometricSync';
import { useModules } from '@/lib/ModulesProvider';
import { discardRejectedRow, rejectedRows, type RejectedRow } from '@/lib/rejectedRows';
import { blockedRows, retryBlockedRow, type BlockedRow } from '@/lib/sessionStore';
import { sessionHref } from '@/lib/startSession';
import { syncNow, useSyncState } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';
import { fallbackModules, type Module } from '@/lib/modules';
import { PressableScale } from '@/components/ui/PressableScale';

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
 *
 * **REFUSED rows are a second list, below the first, and the separation is
 * the point (N167/#544).** A blocked row is still owed and still being
 * retried; a refused one is finished — the server answered, it will answer the
 * same way forever, and the outbox has stopped. Both belong on this screen and
 * they need different words and different buttons: "Try again" is the right
 * offer for the first and a lie for the second.
 *
 * Until N167 the refused half appeared NOWHERE. Both writing domains recorded
 * the server's reason and both said in their own comments that somebody showed
 * it — `foodLog.ts`: "keep the row and the reason so the sync screen can
 * explain it"; `sequences.ts`: "the row stays on the device for the athlete to
 * see" — and this screen read neither. A refused food entry left the pending
 * count, kept its reason, and was invisible.
 *
 * **Which is why "Nothing is stuck" now depends on both lists.** A screen
 * reassuring an athlete while their breakfast sits refused underneath it is
 * the worst state this file can be in: it is the app being confidently wrong
 * about the athlete's own record.
 *
 * **"Sync now" used to mean only the offline outbox** (`lib/sync.ts`'s
 * `syncNow`) — activities, sessions, workouts. N522/#934: the biometric
 * enrichment pass (heart-rate windows, VO₂max — `lib/biometricSync.ts`) is a
 * genuinely separate orchestrator with its own mutex and its own foreground
 * trigger, and nothing on this screen ever ran it. An athlete told
 * elsewhere in this app that HR data "may not have synced yet" would land
 * here, tap the only obviously-discoverable "Sync now" control, and get
 * zero effect on the thing they actually came to fix. The button now
 * triggers both.
 */
export default function SyncScreen() {
  const accent = useAccent();
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const router = useRouter();
  const { modules } = useModules();
  const state = useSyncState();
  const [rows, setRows] = useState<BlockedRow[] | null>(null);
  const [refused, setRefused] = useState<RejectedRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    // `allSettled`, not `all`, and this is the difference between a screen
    // that degrades and one that hangs. Review caught the first version: with
    // `Promise.all`, a throw from the NEWER `rejectedRows` query discards the
    // `blockedRows` result that had already resolved, so `rows` stays `null`
    // and the spinner never resolves — a brand-new query taking the existing,
    // working list down with it.
    //
    // This is also the idiom this codebase already reaches for whenever two
    // independent reads feed one screen, in `biometricSync.ts`'s words: "a
    // slow or failing VO₂max read must not block session enrichment, and vice
    // versa." Same shape, same answer.
    const [blocked, rejected] = await Promise.allSettled([
      blockedRows(userId),
      rejectedRows(userId),
    ]);
    // Each list is set on its own. A failed read leaves that half alone rather
    // than becoming an error state on the repair screen — `null` for the
    // blocked list keeps the honest "still loading" rather than claiming
    // nothing is wrong, and an empty refused list is the same claim it would
    // make on a device with nothing refused, which is the safe direction.
    if (blocked.status === 'fulfilled') setRows(blocked.value);
    if (rejected.status === 'fulfilled') setRefused(rejected.value);
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

  async function discard(row: RejectedRow) {
    if (!userId) return;
    setBusy(row.id);
    try {
      await discardRejectedRow(userId, row);
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

        <PressableScale
          onPress={() => {
            void syncNow().then(load);
            // N522/#934: this was previously the offline-outbox push ONLY —
            // the biometric enrichment pass (heart-rate windows, VO2max) is
            // a SEPARATE orchestrator with its own mutex (see
            // biometricSync.ts's doc comment), and nothing here ever
            // triggered it. That made this screen's own "may not have
            // synced yet" framing (below, in the transient-error copy) a
            // dead end for exactly the HR-enrichment failures an athlete
            // is most likely to land here over: tapping the app's own
            // obviously-discoverable "Sync now" control did nothing for
            // them. Same identity/mutex path Settings' HealthKit toggle
            // already uses (`triggerBiometricSyncNow`) — never the raw
            // orchestrator function.
            if (userId) triggerBiometricSyncNow(userId, getToken);
          }}
          style={styles.syncButton}
          accessibilityRole="button"
          accessibilityLabel="Sync now"
          testID="sync-now"
        >
          <Text style={styles.syncButtonText}>
            {state.syncing ? 'Syncing…' : 'Sync now'}
          </Text>
        </PressableScale>

        {rows === null ? (
          <ActivityIndicator accessibilityLabel="Loading" style={styles.spinner} />
        ) : rows.length === 0 && refused.length === 0 && state.lastError ? (
          // N493 — the chip that sends an athlete here reads `lastError` for
          // ANY failure (see `SyncChip.tsx`'s `chipFor`), but this list is
          // deliberately scoped to PERMANENT ones only (this file's own doc
          // comment above). A transient failure — retried automatically,
          // never listed here — used to fall through to "Nothing is stuck":
          // a reassuring screen directly under a red "Sync failed" chip,
          // with no visible connection between the two. Surfacing the raw
          // error here closes that gap without changing what gets listed or
          // retried.
          <View style={styles.empty} testID="sync-transient-error">
            <Text style={styles.emptyTitle}>Still trying</Text>
            <Text style={styles.emptyBody}>{state.lastError}</Text>
            <Text style={styles.emptyBody}>
              Nothing here needs your input yet — this keeps retrying on its own.
            </Text>
          </View>
        ) : rows.length === 0 && refused.length === 0 ? (
          <View style={styles.empty} testID="sync-nothing-stuck">
            <Text style={styles.emptyTitle}>Nothing is stuck</Text>
            <Text style={styles.emptyBody}>
              Anything still waiting will go out on its own when you have signal.
            </Text>
          </View>
        ) : rows.length === 0 ? null : (
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
                  <PressableScale
                    onPress={() => router.push(destinationOf(row, modules))}
                    style={styles.rowAction}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${row.name || 'this item'} to fix it`}
                    testID={`open-${row.id}`}
                  >
                    <Text style={[styles.retryText, { color: accent.ink }]}>
                      {row.kind === 'workout' ? 'Open the plan' : 'Open the session'}
                    </Text>
                  </PressableScale>
                  <PressableScale
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
                  </PressableScale>
                </View>
              </View>
            ))}
          </View>
        )}

        {refused.length > 0 && (
          <View style={styles.list} testID="sync-refused">
            <Text style={styles.listHeading}>Refused</Text>
            <Text style={styles.emptyBody}>
              The server would not accept these, and trying again will not change that. They
              are only on this phone.
            </Text>
            {refused.map((row) => (
              <View key={`${row.kind}:${row.id}`} style={styles.row} testID={`refused-${row.id}`}>
                <Text style={styles.rowName}>{row.name || 'Untitled'}</Text>
                <Text style={styles.rowKind}>
                  {row.kind === 'food-entry' ? `food entry${row.on ? ` · ${row.on}` : ''}` : 'sequence'}
                </Text>
                {/* The server's own words, same rule as the list above: the
                    API writes these for cases a person can act on, so
                    paraphrasing loses the only part that says what to do. */}
                <Text style={styles.rowError}>{row.reason}</Text>
                <View style={styles.rowActions}>
                  {/* Discard only. Retry is meaningless here — that is the
                      whole difference between this list and the one above —
                      and editing lives on the screen that owns the row. */}
                  <PressableScale
                    onPress={() => void discard(row)}
                    disabled={busy === row.id}
                    style={styles.rowAction}
                    accessibilityRole="button"
                    accessibilityLabel={`Discard ${row.name || 'this item'}`}
                    accessibilityState={{ busy: busy === row.id, disabled: busy === row.id }}
                    testID={`discard-${row.id}`}
                  >
                    <Text style={styles.retryMuted}>
                      {busy === row.id ? 'Discarding…' : 'Discard'}
                    </Text>
                  </PressableScale>
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
 *
 * Delegates to `sessionHref` (N460/#771) rather than repeating the branch —
 * this file used to hardcode `sport === 'bjj' ? … : '/session/…'`, which is
 * the exact bug that sent a blocked RUNNING session to the strength-shaped
 * live set logger too, since neither branch named it. `modules` defaults to
 * `fallbackModules()` for a caller with no live registry (there is no
 * production caller like that today — `SyncScreen` always has one from
 * `useModules()` — but keeping this a plain, independently-callable function
 * rather than a hook is worth an optional argument).
 */
export function destinationOf(row: BlockedRow, modules: Module[] = fallbackModules()): Href {
  if (row.kind === 'workout') return `/workout/${row.id}`;
  return sessionHref({ id: row.id, sport: row.sport }, modules);
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
