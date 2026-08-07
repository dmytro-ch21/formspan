import { request as requestSync } from '@/lib/sync';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { useAuth } from '@clerk/clerk-expo';

import { KeyboardAwareFlatList } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { useAuthToken } from '@/lib/useAuthToken';
import { vola } from '@/constants/Colors';
import { LibraryTile, patternBadge } from '@/components/LibraryTile';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import { emptySet, swapExercise, swapSuggestions } from '@/lib/sessions';
import { sharesMuscleGroup } from '@/lib/exerciseFacets';
import {
  cachedExercises,
  cacheExercises,
  readLocalSession,
  saveLocalSets,
} from '@/lib/sessionStore';

/**
 * Picking an exercise mid-session — either to add one, or to swap one you've
 * already started for something else.
 *
 * Swapping is the case that matters in a real gym: the rack is taken, the bar
 * is in use, a shoulder complains on the third set. Doing that by deleting
 * and re-adding would throw away the sets already logged, so a swap rewrites
 * them in place instead.
 *
 * When swapping, suggestions come first in two labelled tiers — what trains
 * the same muscles, then what moves the same way — ranked by a rule you can
 * say out loud rather than by anything opaque. The full catalog sits below
 * both, so neither tier is a restriction. A substitute measured differently
 * can't inherit your numbers, and within a tier the ranking prefers the ones
 * that can.
 *
 * Either way the list is filtered to the session's discipline, so a choice
 * the API would reject is unreachable rather than merely refused.
 */
export default function AddExerciseToSessionScreen() {
  const { id, swap } = useLocalSearchParams<{ id: string; swap?: string }>();
  const getToken = useAuthToken();
  const { userId } = useAuth();
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
    if (!id || !userId) return;
    readLocalSession(userId, id)
      .then((s) => s && setSport(s.sport))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [userId, id]);

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
          cacheExercises(list).catch(() => {});
        }
      } catch {
        if (controller.signal.aborted) return;
        // Offline: search the cache instead. Substring matching locally is
        // the same thing the API's `q` does, and adding an exercise you've
        // seen before is the whole point of having cached it.
        const q = query.trim().toLowerCase();
        const cached = await cachedExercises(sport);
        setResults(q ? cached.filter((e) => e.name.toLowerCase().includes(q)) : cached);
        setEverLoaded(true);
        setError(null);
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
    () =>
      current && query.trim() === ''
        ? swapSuggestions(current, results, sharesMuscleGroup)
        : { muscle: [], movement: [] },
    [current, results, query],
  );

  async function choose(exercise: Exercise) {
    if (!id || !userId || busy) return;
    setBusy(exercise.id);
    try {
      const session = await readLocalSession(userId!, id);
      if (!session) throw new Error('Session not found on this device.');
      const next = swapping
        ? swapExercise(session.sets, swap, exercise, current?.load_type)
        : [...session.sets, emptySet(exercise.id, session.sets.length)];
      await saveLocalSets(userId!, id, next);
      requestSync('exercise-added');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  /** `patternBadge` returns a tuple; the tile wants named props. */
  const patternTile = (pattern: string) => {
    const [code, accent] = patternBadge(pattern);
    return { code, accent };
  };

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
        {/* The same tile the Library draws, and for the reason that component
            exists: only 4 of 524 exercises have artwork, so rendering an image
            *when there is one* leaves 520 blank squares. This picker was doing
            exactly that — the identical bug the Library already solved, in a
            second place. The tile falls back to a three-letter code for the
            movement pattern, which is scannable where a blank is not. */}
        <LibraryTile uri={uri} {...patternTile(item.movement_pattern)} />
        <View style={styles.rowBody}>
          <Text style={styles.name}>{item.name}</Text>
          <Text style={styles.muted}>
            {item.movement_pattern.replace(/_/g, ' ')}
            {/* Equipment, because the usual reason to swap is that a piece of
                it is occupied — and the one suggestion that cannot help is
                another movement needing the same bar. The ranking deliberately
                does NOT guess at this (people also swap for a niggle, or a
                preference); showing it lets the athlete decide in a second. */}
            {item.equipment.length > 0
              ? ` · ${item.equipment.map((q) => q.replace(/-/g, ' ')).join(', ')}`
              : ' · bodyweight'}
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

      <KeyboardAwareFlatList
        data={results}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.list}
        // Suggestions ride in the header so the whole screen stays one
        // scrolling list rather than two that fight for height.
        ListHeaderComponent={
          current && (suggestions.muscle.length > 0 || suggestions.movement.length > 0) ? (
            <View style={styles.header}>
              {/* Muscle first: the question being asked is "the rack is taken,
                  what else trains this?", and the answer starts with what it
                  trains rather than what shape it is. */}
              {suggestions.muscle.length > 0 && (
                <>
                  <Text style={styles.sectionLabel}>Trains the same muscles</Text>
                  {suggestions.muscle.map((e) => (
                    <Row key={`muscle-${e.id}`} item={e} />
                  ))}
                </>
              )}
              {suggestions.movement.length > 0 && (
                <>
                  <Text style={styles.sectionLabel}>Similar movement</Text>
                  {suggestions.movement.map((e) => (
                    <Row key={`movement-${e.id}`} item={e} />
                  ))}
                </>
              )}
              {/* Named so the escape hatch is obvious: neither tier is a
                  restriction, and the whole catalog is one scroll below. */}
              <Text style={styles.sectionLabel}>Everything else — all {sport} exercises</Text>
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
  rowBody: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: vola.danger, fontSize: 14 },
});
