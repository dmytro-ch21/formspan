import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { listClassPlans, type ClassPlan } from '@/lib/classplans';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Pick a class plan to run.
 *
 * **Read-only, and the empty state says so.** A class plan has no capture
 * path on the phone the way a sequence does — `lib/classplans.ts`'s header
 * explains why: it is never written from the mat, only from a desk, via
 * N440's web builder. So where `sequence/index.tsx`'s empty state points at
 * the reflection wizard, this one points at the web app, honestly, rather
 * than implying a create button exists somewhere on this screen.
 *
 * Mirrors `sequence/index.tsx`'s loading/empty/error conventions: `null`
 * means "not answered yet", an empty array is a real answer, and an error
 * is shown without pretending the list is simply empty.
 */
export default function ClassPlansScreen() {
  const getToken = useAuthToken();
  const accent = useAccent();
  const router = useRouter();

  const [plans, setPlans] = useState<ClassPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Single-flight, same reasoning as `sequence/index.tsx`: a slow first load
  // resolving after a fast second one would repaint stale rows over fresh
  // ones.
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    try {
      const list = await listClassPlans(getToken, c.signal);
      if (c.signal.aborted) return;
      setPlans(list);
      setError(null);
    } catch (err) {
      if (c.signal.aborted || (err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!c.signal.aborted) setRefreshing(false);
    }
  }, [getToken]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => inflight.current?.abort();
    }, [load]),
  );

  return (
    <View style={styles.screen} testID="classplans-screen">
      <Stack.Screen options={{ title: 'Class plans' }} />

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="classplans-error">
          {error}
        </Text>
      )}

      {plans === null ? (
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading your class plans" />
      ) : (
        <FlatList
          data={plans}
          keyExtractor={(p) => p.id}
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
              Pick a plan to run in class. Build and edit them on the web app.
            </Text>
          }
          ListEmptyComponent={
            // Gated on `error` for the same reason `sequence/index.tsx` gates
            // its own empty state: "you have none" and "we could not ask"
            // are different claims, and only one of them is true here.
            error ? null : (
              <Text style={styles.empty} testID="classplans-empty">
                No class plans yet. Build one on VOLA on the web, then come back here to run it.
              </Text>
            )
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/classplans/${item.id}/run`)}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              accessibilityHint={planSummary(item)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              testID={`classplan-row-${item.id}`}
            >
              <View style={styles.rowBody}>
                <Text style={styles.name} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={styles.muted}>{planSummary(item)}</Text>
              </View>
              <Text style={[styles.chevron, { color: accent.ink }]}>›</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

/** The one-line meta under a plan's name — pulled out so a test can pin the
 *  exact words, same reasoning `sequences.ts`'s `stepSummary` gives. */
export function planSummary(p: ClassPlan): string {
  const blocks = `${p.block_count} block${p.block_count === 1 ? '' : 's'}`;
  return `${blocks} · ${p.total_duration_minutes} min`;
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
  chevron: { fontSize: 22, fontWeight: '700' },
});
