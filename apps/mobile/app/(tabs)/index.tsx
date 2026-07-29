import { useAuth } from '@clerk/clerk-expo';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Text, View } from '@/components/Themed';
import { useAuthToken } from '@/lib/useAuthToken';
import {
  listLocalActivities,
  logActivityOffline,
  syncPendingActivities,
  type LocalActivity,
} from '@/lib/activities';
import { listSessions, type Session } from '@/lib/sessions';
import { vola } from '@/constants/Colors';

const SPORTS: { key: string; label: string }[] = [
  { key: 'strength', label: 'Strength' },
  { key: 'bjj', label: 'BJJ' },
  { key: 'running', label: 'Running' },
];

/** Warm-ups excluded, matching the backend's own working-volume rule — the
 *  same session must not report two different numbers on two screens. */
function workingSets(s: Session): number {
  return s.sets.filter((set) => set.set_type !== 'warmup').length;
}

export default function TodayScreen() {
  const { userId, signOut } = useAuth();
  const getToken = useAuthToken();
  const router = useRouter();

  const [notes, setNotes] = useState('');
  const [activities, setActivities] = useState<LocalActivity[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      setActivities(await listLocalActivities(userId));
    } catch (err) {
      // Without this, a failed local read renders as "No activities yet" —
      // a failure disguised as a legitimate empty state, on an app whose
      // whole promise is that the local write survived.
      setStatus(`Couldn't read local activities: ${String(err)}`);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions(getToken, { limit: 5 }));
      setSessionError(null);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
    }
  }, [getToken]);

  // On focus rather than on mount: coming back from a session should show
  // its new numbers, not the list as it was when the tab first rendered.
  useFocusEffect(
    useCallback(() => {
      refreshSessions();
    }, [refreshSessions]),
  );


  const pending = activities.filter((a) => a.synced === 0).length;

  const onSync = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (syncing || !userId) return;
      setSyncing(true);
      if (!silent) setStatus(null);
      try {
        const result = await syncPendingActivities(userId, getToken);
        await refresh();
        if (result.failed > 0) {
          setStatus(`Synced ${result.synced}, ${result.failed} still pending — ${result.error}`);
        } else if (result.synced > 0) {
          setStatus(`Synced ${result.synced}.`);
        } else if (!silent) {
          setStatus('Nothing to sync.');
        }
      } catch (err) {
        setStatus(`Sync failed: ${String(err)}`);
      } finally {
        setSyncing(false);
      }
    },
    [syncing, userId, getToken, refresh],
  );

  async function onLog() {
    if (!userId) return;
    try {
      await logActivityOffline(userId, 'bjj_session', notes.trim() || null);
      setNotes('');
      setStatus('Logged locally.');
      await refresh();
      // Opportunistic push — succeeds online, harmlessly leaves the row
      // pending when offline.
      onSync({ silent: true });
    } catch (err) {
      // A silent failure here would look like the tap did nothing at all.
      setStatus(`Couldn't save locally: ${String(err)}`);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container} testID="today-screen">
      <Text accessibilityRole="header" style={styles.title} testID="app-title">
        VOLA
      </Text>

      <View style={styles.card}>
        <Text style={styles.label}>Start a session</Text>
        <View style={styles.sportRow}>
          {SPORTS.map((s) => (
            <Pressable
              key={s.key}
              style={styles.sportButton}
              onPress={() => router.push(`/session/start?sport=${s.key}`)}
              accessibilityRole="button"
              accessibilityLabel={`Start a ${s.label} session`}
              testID={`start-session-${s.key}`}
            >
              <Text style={styles.sportText}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.hint}>Pick one of your workouts, or start empty.</Text>
      </View>

      {sessionError && (
        <Text style={styles.errorText} accessibilityLiveRegion="polite" testID="session-list-error">
          {sessionError}
        </Text>
      )}

      {sessions.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>Recent sessions</Text>
          {sessions.map((s) => (
            <Pressable
              key={s.id}
              style={styles.sessionRow}
              onPress={() => router.push(`/session/${s.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${s.name || s.sport} session`}
              testID={`session-${s.id}`}
            >
              <View style={styles.activityMain}>
                <Text style={styles.activityKind}>{s.name || s.sport}</Text>
                <Text style={styles.muted}>
                  {new Date(s.started_at).toLocaleDateString()} · {workingSets(s)}{' '}
                  {workingSets(s) === 1 ? 'working set' : 'working sets'}
                </Text>
              </View>
              <Text style={s.ended_at ? styles.synced : styles.pending}>
                {s.ended_at ? 'done' : 'in progress'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      <View style={styles.card}>
        <Text style={styles.label}>Log a BJJ session</Text>
        <TextInput
          style={styles.input}
          placeholder="Notes (optional)"
          placeholderTextColor="#767676"
          accessibilityLabel="Session notes, optional"
          value={notes}
          onChangeText={setNotes}
          testID="activity-notes"
        />
        <Pressable
          style={styles.button}
          onPress={onLog}
          accessibilityRole="button"
          testID="log-activity"
        >
          <Text style={styles.buttonText}>Log activity</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <Text testID="pending-count">
          {pending} pending · {activities.length - pending} synced
        </Text>
        <Pressable
          style={[styles.secondaryButton, syncing && styles.buttonDisabled]}
          onPress={() => onSync()}
          disabled={syncing}
          accessibilityRole="button"
          accessibilityLabel="Sync now"
          accessibilityState={{ busy: syncing, disabled: syncing }}
          testID="sync-now"
        >
          {syncing ? <ActivityIndicator /> : <Text style={styles.secondaryText}>Sync now</Text>}
        </Pressable>
      </View>

      {status && (
        <Text style={styles.status} testID="sync-status">
          {status}
        </Text>
      )}

      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      {activities.length === 0 ? (
        <Text style={styles.muted}>No activities yet.</Text>
      ) : (
        activities.map((a) => (
          <View key={a.id} style={styles.activityRow} testID={`activity-${a.id}`}>
            <View style={styles.activityMain}>
              <Text style={styles.activityKind}>{a.kind}</Text>
              <Text style={styles.muted}>{a.notes ?? 'No notes'}</Text>
            </View>
            <Text style={a.synced ? styles.synced : styles.pending}>
              {a.synced ? 'synced' : 'pending'}
            </Text>
          </View>
        ))
      )}

      <Pressable
        style={styles.signOut}
        onPress={() => signOut()}
        accessibilityRole="button"
        testID="sign-out"
      >
        <Text style={styles.muted}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 4 },
  card: { gap: 10 },
  label: { fontSize: 15, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  button: { backgroundColor: vola.lime, borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: vola.navy, fontWeight: '600', fontSize: 16 },
  buttonDisabled: { opacity: 0.6 },
  sportRow: { flexDirection: 'row', gap: 8 },
  sportButton: {
    flex: 1,
    backgroundColor: vola.lime,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  sportText: { color: vola.navy, fontWeight: '700', fontSize: 15 },
  hint: { color: vola.textMuted, fontSize: 12 },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    gap: 12,
  },
  errorText: { color: vola.danger, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  secondaryText: { fontWeight: '600' },
  status: { fontSize: 13 },
  separator: { marginVertical: 8, height: 1, width: '100%' },
  muted: { color: '#888' },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    gap: 12,
  },
  activityMain: { flex: 1, gap: 2 },
  activityKind: { fontWeight: '600' },
  synced: { color: vola.green, fontSize: 12 },
  pending: { color: vola.warn, fontSize: 12 },
  signOut: { marginTop: 24, alignItems: 'center', paddingVertical: 14 },
});
