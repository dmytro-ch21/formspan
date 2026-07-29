import { useAuth } from '@clerk/clerk-expo';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';

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
  const { getToken } = useAuth();

  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [sport, setSport] = useState<string>('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cancels the in-flight request when the filter changes again before it
  // lands — without this a slow early response can overwrite a newer one and
  // the list shows results for a query the user already moved past.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (!opts.silent) setLoading(true);
      setError(null);
      try {
        const list = await fetchExercises(
          getToken,
          { sport: sport || undefined, q: query.trim() || undefined },
          controller.signal,
        );
        if (!controller.signal.aborted) setExercises(list);
      } catch (err) {
        // An abort is us superseding our own request, not a failure — showing
        // an error for it would make fast typing look broken.
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) {
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

  useEffect(() => () => abortRef.current?.abort(), []);

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
        <Text style={styles.error} testID="library-error">
          {error}
        </Text>
      )}

      {loading && exercises.length === 0 ? (
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
            error ? null : (
              <Text style={styles.muted} testID="library-empty">
                {isFiltered
                  ? 'No exercises match this search.'
                  : 'No exercises yet.'}
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
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 16,
    color: '#111',
    backgroundColor: '#fff',
  },
  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  chipActive: { backgroundColor: '#0B1220', borderColor: '#0B1220' },
  chipText: { fontSize: 14, fontWeight: '600' },
  chipTextActive: { color: '#B8FF2C' },
  loader: { marginTop: 32 },
  list: { padding: 16, gap: 14 },
  row: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  thumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: '#eceff3' },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  thumbEmptyText: { color: '#8a9099', fontSize: 20 },
  rowBody: { flex: 1, gap: 3 },
  name: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 13, color: '#6b7280', textTransform: 'capitalize' },
  muted: { color: '#8a9099', fontSize: 13 },
  error: { color: 'crimson', fontSize: 14, paddingHorizontal: 16, paddingTop: 10 },
});
