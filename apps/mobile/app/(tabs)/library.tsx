import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
} from 'react-native';

import { useAuth } from '@clerk/clerk-expo';

import { Text, View } from '@/components/Themed';
import { PREF_LIBRARY_SPORT, readPref, writePref } from '@/lib/prefs';
import { cacheExercises } from '@/lib/sessionStore';
import { useAuthToken } from '@/lib/useAuthToken';

// Abort reasons, so a superseded request (silent) and a timeout (a real
// error the user must see) don't both collapse into `signal.aborted`.
const SUPERSEDED = 'superseded';
const TIMED_OUT = 'timed-out';

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // React Native's fetch says "Network request failed", which tells a user
  // nothing actionable.
  if (/network request failed/i.test(msg)) return "You're offline.";
  if (/\(401\)/.test(msg)) return 'Your session expired. Sign in again.';
  return msg;
}
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import { vola } from '@/constants/Colors';

const SPORTS = [
  { key: '', label: 'All' },
  { key: 'strength', label: 'Strength' },
  { key: 'bjj', label: 'BJJ' },
  { key: 'running', label: 'Running' },
] as const;

/** Human labels for the load types the catalog uses. */
const LOAD_LABEL: Record<Exercise['load_type'], string> = {
  weight_reps: 'Weight × reps',
  reps: 'Reps',
  time: 'Time',
  distance: 'Distance',
  distance_time: 'Distance & time',
};

export default function LibraryScreen() {
  const getToken = useAuthToken();

  const [exercises, setExercises] = useState<Exercise[]>([]);
  const { userId } = useAuth();
  const [sport, setSportState] = useState<string>('');
  const [query, setQuery] = useState('');

  /**
   * The filter is remembered; the search box is not.
   *
   * They're different kinds of thing. "I train strength" is a standing fact
   * about you that shouldn't need re-stating every visit. "bench" is a
   * question you asked once and already got the answer to — finding it still
   * in the box next time is a small confusion every time, because the list
   * looks short for no visible reason.
   */
  useEffect(() => {
    if (!userId) return;
    readPref(userId, PREF_LIBRARY_SPORT)
      .then((v) => v && setSportState(v))
      .catch(() => {});
  }, [userId]);

  const setSport = useCallback(
    (next: string) => {
      setSportState(next);
      if (userId) writePref(userId, PREF_LIBRARY_SPORT, next).catch(() => {});
    },
    [userId],
  );

  // Clear the search on the way out, so the next visit starts open.
  useFocusEffect(
    useCallback(() => {
      return () => setQuery('');
    }, []),
  );
  const [loading, setLoading] = useState(true);
  // "Have we ever successfully loaded?" — distinct from "are we loading now".
  // Without it, a retry after a failure renders "No exercises yet" while the
  // replacement request is in flight: error cleared, loading false (all
  // automatic loads are silent), list still empty. That's a failure
  // disguised as a legitimate empty state, which the functional-scenarios
  // doc names as forbidden.
  const [everLoaded, setEverLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cancels the in-flight request when the filter changes again before it
  // lands — without this a slow early response can overwrite a newer one and
  // the list shows results for a query the user already moved past.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      abortRef.current?.abort(SUPERSEDED);
      const controller = new AbortController();
      abortRef.current = controller;

      // Without a deadline the initial spinner can spin forever on a captive
      // or dead network — and the RefreshControl isn't mounted in the
      // spinner branch, so there'd be no way to recover.
      const timeout = setTimeout(() => controller.abort(TIMED_OUT), 10_000);

      if (!opts.silent) setLoading(true);
      setError(null);
      try {
        const list = await fetchExercises(
          getToken,
          { sport: sport || undefined, q: query.trim() || undefined },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setExercises(list);
          // Warms the offline cache from the screen that already has the
          // whole catalog — the first offline session shouldn't be the first
          // time anything gets cached.
          cacheExercises(list).catch(() => {});
          setEverLoaded(true);
        }
      } catch (err) {
        // Superseding our own request is not a failure — showing an error
        // for it would make fast typing look broken. A timeout is, though,
        // so the two aborts have to be distinguishable rather than lumped
        // together under `signal.aborted`.
        if (controller.signal.reason === SUPERSEDED) return;
        setError(
          controller.signal.reason === TIMED_OUT
            ? "Couldn't reach the server. Pull down to try again."
            : describeError(err),
        );
        setEverLoaded(true); // so the empty state stops claiming to be authoritative
      } finally {
        clearTimeout(timeout);
        if (controller.signal.reason !== SUPERSEDED) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [getToken, sport, query],
  );

  // Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => load({ silent: true }), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => () => abortRef.current?.abort(SUPERSEDED), []);

  const isFiltered = query.trim() !== '' || sport !== '';

  return (
    <View style={styles.container} testID="library-screen">
      <View style={styles.controls}>
        <TextInput
          style={styles.search}
          placeholder="Search exercises"
          placeholderTextColor="#767676"
          accessibilityLabel="Search exercises by name"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          // The API rejects q over 100 chars; stop it here rather than
          // spending a round trip to be told off.
          maxLength={100}
          testID="library-search"
        />
        <View style={styles.chips}>
          {SPORTS.map((s) => {
            const active = sport === s.key;
            return (
              <Pressable
                key={s.key || 'all'}
                onPress={() => setSport(s.key)}
                style={[styles.chip, active && styles.chipActive]}
                accessibilityRole="button"
                accessibilityLabel={`Filter by ${s.label}`}
                accessibilityState={{ selected: active }}
                testID={`library-filter-${s.key || 'all'}`}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{s.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="library-error">
          {error}
        </Text>
      )}

      {loading && !everLoaded && exercises.length === 0 ? (
        <ActivityIndicator style={styles.loader} testID="library-loading" />
      ) : (
        <FlatList
          data={exercises}
          keyExtractor={(e) => e.id}
          contentContainerStyle={styles.list}
          // Virtualised rather than a ScrollView: the catalog is a dozen rows
          // today and headed for several hundred.
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load({ silent: true });
              }}
            />
          }
          ListEmptyComponent={
            // Only claim the catalog is empty once we've actually seen a
            // successful response. Before that, silence beats a wrong answer.
            error || !everLoaded ? null : (
              <Text style={styles.muted} testID="library-empty">
                {isFiltered ? 'No exercises match this filter.' : 'No exercises yet.'}
              </Text>
            )
          }
          renderItem={({ item }) => {
            const uri = pickImage(item, 'thumbnail');
            return (
              <Pressable
                style={styles.row}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${item.sport}`}
                testID={`exercise-${item.id}`}
              >
                {uri ? (
                  <Image
                    source={{ uri }}
                    style={styles.thumb}
                    contentFit="cover"
                    // Immutable keys, so caching hard is free and correct.
                    cachePolicy="memory-disk"
                    transition={150}
                    // Decorative on web too: expo-image's web renderer maps
                    // accessibilityLabel to alt and ignores `accessible`, so
                    // without this the <img> ships with no alt at all and
                    // screen readers read out the URL filename.
                    alt=""
                    // Decorative here — the name beside it already conveys
                    // the exercise, so announcing it twice adds noise.
                    accessible={false}
                  />
                ) : (
                  <View style={[styles.thumb, styles.thumbEmpty]}>
                    <Text style={styles.thumbEmptyText}>—</Text>
                  </View>
                )}

                <View style={styles.rowBody}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.meta}>
                    {item.movement_pattern.replace(/_/g, ' ')} · {LOAD_LABEL[item.load_type]}
                    {item.is_unilateral ? ' · per side' : ''}
                  </Text>
                  {item.primary_muscles.length > 0 && (
                    <Text style={styles.muted} numberOfLines={1}>
                      {item.primary_muscles.map((m) => m.replace(/_/g, ' ')).join(', ')}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  controls: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  search: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  chipActive: { backgroundColor: vola.lime, borderColor: vola.lime },
  chipText: { fontSize: 14, fontWeight: '600' },
  chipTextActive: { color: vola.navy },
  loader: { marginTop: 32 },
  list: { padding: 16, gap: 14 },
  row: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  thumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: vola.surfaceRaised },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  thumbEmptyText: { color: vola.textDim, fontSize: 20 },
  rowBody: { flex: 1, gap: 3 },
  name: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 13, color: vola.textMuted, textTransform: 'capitalize' },
  // #8a9099 was ~3.2:1 on white — below WCAG AA's 4.5:1 for 13pt text.
  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: vola.danger, fontSize: 14, paddingHorizontal: 16, paddingTop: 10 },
});
