import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View } from '@/components/Themed';
import { useAuthToken } from '@/lib/useAuthToken';
import { vola } from '@/constants/Colors';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import { emptySet, getSession, replaceSets, similarTo, swapExercise } from '@/lib/sessions';

/**
 * Picking an exercise mid-session — either to add one, or to swap one you've
 * already started for something else.
 *
 * Swapping is the case that matters in a real gym: the rack is taken, the bar
 * is in use, a shoulder complains on the third set. Doing that by deleting
 * and re-adding would throw away the sets already logged, so a swap rewrites
 * them in place instead.
 *
 * When swapping, suggestions come first, ranked by a rule you can say out
 * loud — same movement pattern, same load type — rather than by anything
 * opaque. A substitute measured differently can't inherit your numbers, and
 * the ranking prefers the ones that can.
 *
 * Either way the list is filtered to the session's discipline, so a choice
 * the API would reject is unreachable rather than merely refused.
 */
export default function AddExerciseToSessionScreen() {
  const { id, swap } = useLocalSearchParams<{ id: string; swap?: string }>();
  const getToken = useAuthToken();
  const router = useRouter();

  const [sport, setSport] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Exercise[]>([]);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which row is committing. Doubles as the in-flight guard: two interleaved
  // read-modify-writes would drop one of the two choices.
  const [busy, setBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const swapping = typeof swap === 'string' && swap.length > 0;

  useEffect(() => {
    if (!id) return;
    getSession(getToken, id)
      .then(({ session }) => setSport(session.sport))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [getToken, id]);

  useEffect(() => {
    if (!sport) return;
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const list = await fetchExercises(
          getToken,
          { sport, q: query.trim() || undefined },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setResults(list);
          setEverLoaded(true);
          setError(null);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setEverLoaded(true);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [getToken, sport, query]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // The exercise being replaced. Only resolvable from an unfiltered listing,
  // which is also the only time suggestions are shown.
  const [current, setCurrent] = useState<Exercise | null>(null);
  useEffect(() => {
    if (!swapping) return;
    const hit = results.find((e) => e.id === swap);
    if (hit) setCurrent(hit);
  }, [swapping, results, swap]);

  // Only while the search is untouched: once you're typing, the results you
  // asked for are the ones you want.
  const suggestions = useMemo(
    () => (current && query.trim() === '' ? similarTo(current, results) : []),
    [current, results, query],
  );

  async function choose(exercise: Exercise) {
    if (!id || busy) return;
    setBusy(exercise.id);
    try {
      const { session } = await getSession(getToken, id);
      const next = swapping
        ? swapExercise(session.sets, swap, exercise, current?.load_type)
        : [...session.sets, emptySet(exercise.id, session.sets.length)];
      await replaceSets(getToken, id, next);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  function Row({ item }: { item: Exercise }) {
    const uri = pickImage(item, 'thumbnail');
    const carries = current ? item.load_type === current.load_type : true;
    return (
      <Pressable
        style={[styles.row, busy !== null && busy !== item.id && styles.dimmed]}
        onPress={() => choose(item)}
        disabled={busy !== null}
        accessibilityRole="button"
        accessibilityLabel={swapping ? `Swap for ${item.name}` : `Add ${item.name}`}
        accessibilityState={{ busy: busy === item.id, disabled: busy !== null }}
        testID={`session-add-${item.id}`}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.thumb} contentFit="cover" cachePolicy="memory-disk" alt="" />
        ) : (
          <View style={styles.thumb} />
        )}
        <View style={styles.rowBody}>
          <Text style={styles.name}>{item.name}</Text>
          <Text style={styles.muted}>
            {item.movement_pattern.replace(/_/g, ' ')}
            {swapping && !carries ? ' · measured differently' : ''}
          </Text>
        </View>
        {busy === item.id && <ActivityIndicator />}
      </Pressable>
    );
  }

  return (
    <View style={styles.container} testID="session-add-screen">
      <Stack.Screen options={{ title: swapping ? 'Swap exercise' : 'Add exercise' }} />

      <TextInput
        style={styles.search}
        placeholder={sport ? `Search ${sport} exercises` : 'Loading…'}
        placeholderTextColor={vola.textDim}
        accessibilityLabel="Search exercises"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={100}
        testID="session-add-search"
      />

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}

      <FlatList
        data={results}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        // Suggestions ride in the header so the whole screen stays one
        // scrolling list rather than two that fight for height.
        ListHeaderComponent={
          suggestions.length > 0 && current ? (
            <View style={styles.header}>
              <Text style={styles.sectionLabel}>Similar to {current.name}</Text>
              {suggestions.map((e) => (
                <Row key={`suggested-${e.id}`} item={e} />
              ))}
              <Text style={styles.sectionLabel}>All {sport} exercises</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          !everLoaded || error ? null : <Text style={styles.muted}>No matching exercises.</Text>
        }
        renderItem={({ item }) => <Row item={item} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  search: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  header: { gap: 12, marginBottom: 4 },
  sectionLabel: { fontSize: 12, color: vola.textDim, textTransform: 'uppercase' },
  list: { gap: 12, paddingBottom: 32 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  dimmed: { opacity: 0.4 },
  thumb: { width: 52, height: 52, borderRadius: 10, backgroundColor: vola.surfaceRaised },
  rowBody: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: vola.danger, fontSize: 14 },
});
