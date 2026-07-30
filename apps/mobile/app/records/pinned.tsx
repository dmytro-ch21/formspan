import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { fetchExercises, type Exercise } from '@/lib/exercises';
import { fetchPinned, setPinned } from '@/lib/records';
import { cacheExercises, cachedExercises } from '@/lib/sessionStore';
import { useAuthToken } from '@/lib/useAuthToken';

const MAX_PINNED = 12;

/**
 * Choosing which lifts show their records on your profile.
 *
 * A shortlist of exercises rather than a matrix of record types, because that
 * matches the actual decision — people care about "my big three", not about
 * whether to display heaviest-weight separately from estimated-1RM. Which
 * kinds an exercise shows follows from how it's measured, so picking the
 * exercise picks everything downstream.
 *
 * Saving happens on each tap rather than behind a Save button: the list is
 * the state, there's nothing to validate, and a settings screen that can be
 * left half-applied is a settings screen people don't trust.
 */
export default function PinnedRecordsScreen() {
  const getToken = useAuthToken();
  const [all, setAll] = useState<Exercise[]>([]);
  const [pinned, setPinnedState] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    // Cache first so the list is usable with no signal, then refresh.
    cachedExercises()
      .then((list) => list.length > 0 && setAll(list))
      .catch(() => {});
    fetchExercises(getToken, {}, c.signal)
      .then((list) => {
        setAll(list);
        return cacheExercises(list);
      })
      .catch(() => {});
    fetchPinned(getToken, c.signal)
      .then(setPinnedState)
      .catch(() => setPinnedState([]));
    return () => c.abort();
  }, [getToken]);

  const toggle = useCallback(
    (id: string) => {
      if (pinned === null) return;
      const next = pinned.includes(id)
        ? pinned.filter((x) => x !== id)
        : pinned.length >= MAX_PINNED
          ? null
          : [...pinned, id];
      if (next === null) {
        setError(`That's the most you can pin — unpin one first.`);
        return;
      }
      setError(null);
      // Optimistic: the tap is the state. A failure puts it back and says so.
      const previous = pinned;
      setPinnedState(next);
      setPinned(getToken, next).catch((err) => {
        setPinnedState(previous);
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [getToken, pinned],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const chosen = new Set(pinned ?? []);
    // Pinned first and in their own order, so the choice you've made stays
    // visible instead of scrolling away into 524 alternatives.
    const head = (pinned ?? []).map((id) => all.find((e) => e.id === id)).filter(Boolean) as Exercise[];
    const rest = all.filter((e) => !chosen.has(e.id) && (!q || e.name.toLowerCase().includes(q)));
    return q ? [...head.filter((e) => e.name.toLowerCase().includes(q)), ...rest] : [...head, ...rest];
  }, [all, pinned, query]);

  return (
    <View style={styles.container} testID="pinned-records-screen">
      <Stack.Screen options={{ title: 'Records on your profile' }} />

      <TextInput
        style={styles.search}
        placeholder="Search exercises"
        placeholderTextColor={vola.textDim}
        accessibilityLabel="Search exercises"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={100}
      />

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}

      {pinned === null ? (
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading your choices" />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(e) => e.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={styles.hint}>
              {pinned.length === 0
                ? 'Nothing pinned — your profile shows the lifts you train most.'
                : `${pinned.length} of ${MAX_PINNED} pinned`}
            </Text>
          }
          renderItem={({ item }) => {
            const on = pinned.includes(item.id);
            return (
              <Pressable
                onPress={() => toggle(item.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={item.name}
                style={styles.row}
                testID={`pin-${item.id}`}
              >
                <View style={[styles.tick, on && styles.tickOn]}>
                  {on && <Text style={styles.tickMark}>✓</Text>}
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.muted}>
                    {item.sport} · {item.movement_pattern.replace(/_/g, ' ')}
                  </Text>
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
  loading: { marginTop: 32 },
  list: { gap: 4, paddingBottom: 32 },
  hint: { color: vola.textDim, fontSize: 12, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  tick: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: vola.lime, borderColor: vola.lime },
  tickMark: { color: vola.bg, fontWeight: '900', fontSize: 14 },
  rowBody: { flex: 1, gap: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 12, textTransform: 'capitalize' },
  error: { color: vola.danger, fontSize: 14 },
});
