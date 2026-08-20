import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet } from 'react-native';

import { useAuth } from '@clerk/clerk-expo';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { listSequences, pendingSequences, stepSummary, type Sequence } from '@/lib/sequences';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Your chains, read back on the phone that captured them.
 *
 * **Why this screen exists.** Until it did, `shared/index.tsx` told an athlete
 * who accepted a shared sequence that "your copy is in the Library" — and
 * there was no sequence route on this app at all, nor are sequences anything
 * the Library tab has ever held (that is the technique and exercise catalog).
 * So the one sentence the app said about where an accepted chain went was
 * false in two directions at once, and the athlete would go and look. That is
 * N80 / issue #414, and it was filed above the other phone-impossible gaps for
 * exactly that reason: every other one omits a surface, this one made a claim.
 *
 * **What it is and is not.** Read-back, in full: every chain you own, every
 * step in order, with the library's own names on them. Authoring stays on web
 * — the two-pane builder against a 634-entry catalog is a desk job, and the
 * mobile-first rule permits web to be RICHER, only never to be the ONLY place.
 * Capture already lives on the phone, inside the reflection wizard; this is
 * the half that was missing.
 *
 * **Offline is a first-class answer, not a failure.** `listSequences` merges
 * the server's rows with whatever this device still owes it, so a capture made
 * in a changing room is visible here before it has ever been sent. A server
 * fault degrades to that outbox half PLUS the error — never to an empty list,
 * which would tell someone with forty chains that they have none. That
 * distinction is the one this codebase keeps re-learning; see `pinned.tsx`.
 */
export default function SequencesScreen() {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const accent = useAccent();
  const router = useRouter();

  // `null` is "not answered yet". An empty array is a real answer — you have
  // captured nothing — and the two render differently on purpose.
  const [sequences, setSequences] = useState<Sequence[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Single-flight. Coming back to this screen re-runs the focus effect, and a
  // slow first load resolving after a fast second one would repaint stale rows
  // over fresh ones.
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    try {
      const list = await listSequences(userId, getToken, c.signal);
      if (c.signal.aborted) return;
      setSequences(list);
      setError(null);
    } catch (err) {
      if (c.signal.aborted || (err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
      // `listSequences` rejects the WHOLE promise on a 500, including the local
      // half it had already read. Falling back to the outbox is what stops an
      // outage hiding this phone's own captures — which would be the wrong way
      // round from being offline, where they show.
      try {
        setSequences(await pendingSequences(userId));
      } catch {
        setSequences([]);
      }
    } finally {
      if (!c.signal.aborted) setRefreshing(false);
    }
  }, [getToken, userId]);

  // On focus rather than on mount: capturing a chain in the reflection wizard
  // and coming straight here has to show it.
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => inflight.current?.abort();
    }, [load]),
  );

  return (
    <View style={styles.screen} testID="sequences-screen">
      <Stack.Screen options={{ title: 'Sequences' }} />

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="sequences-error">
          {error}
        </Text>
      )}

      {sequences === null ? (
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading your sequences" />
      ) : (
        <FlatList
          data={sequences}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
            />
          }
          ListHeaderComponent={
            <Text style={styles.lede}>
              A chain is what a class taught, in the order it flows. Capture one from a session
              reflection; build and reorder them on the web app.
            </Text>
          }
          ListEmptyComponent={
            // Only ever shown for a genuine empty answer — a failed load has
            // already fallen back to the outbox and shown its error above.
            <Text style={styles.empty} testID="sequences-empty">
              No chains yet. Tag two or more techniques as drilled when you reflect on a session,
              and you can save them as one.
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/sequence/${item.id}`)}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              accessibilityHint={stepSummary(item)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              testID={`sequence-row-${item.id}`}
            >
              <View style={styles.rowBody}>
                <Text style={styles.name} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={styles.muted}>{stepSummary(item)}</Text>
                {/* A chain that has not left the phone yet is a fact worth
                    showing, not a detail to hide: it is the difference between
                    "your partner can see this" and "only you can". */}
                {item.pending && (
                  <Text style={styles.pending} testID={`sequence-pending-${item.id}`}>
                    On this phone only — not synced yet
                  </Text>
                )}
              </View>
              <Text style={[styles.chevron, { color: accent.ink }]}>›</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16 },
  loading: { marginTop: 32 },
  list: { gap: 4, paddingBottom: 32 },
  lede: { color: vola.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  empty: { color: vola.textMuted, fontSize: 14, lineHeight: 20, marginTop: 8 },
  error: { color: vola.danger, fontSize: 14, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  pressed: { opacity: 0.7 },
  rowBody: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '700' },
  muted: { color: vola.textMuted, fontSize: 12 },
  pending: { color: vola.warn, fontSize: 12, fontWeight: '600' },
  chevron: { fontSize: 22, fontWeight: '700' },
});
