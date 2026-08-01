import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import {
  fetchRulesets,
  fetchTechniques,
  searchTechniques,
  type Ruleset,
  type TechniqueSummary,
} from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The BJJ technique library — 466 entries, and it has to feel instant.
 *
 * Everything here follows from one decision: **fetch the whole library once as
 * summaries, then never touch the network again.**
 *
 *   - Summaries are ~65 KB for all 466. Full rows would be ~274 KB, and the
 *     prose they carry is unreadable in a list anyway.
 *   - Search and filtering run in memory, so typing costs nothing. A
 *     per-keystroke request would be slower, would flicker, and would fail on
 *     gym wifi.
 *   - Rulesets (25) are fetched alongside and cached for the app's lifetime,
 *     so the restricted badge on a row costs no request at all.
 *
 * `FlatList` rather than `ScrollView` for the same reason the exercise catalog
 * uses it: 466 rows mounted at once is a visible stall on a phone.
 */
const POSITIONS = [
  { key: '', label: 'All' },
  { key: 'Guard - Bottom', label: 'Guard' },
  { key: 'Standing', label: 'Standing' },
  { key: 'Mount - Top', label: 'Mount' },
  { key: 'Side Control - Top', label: 'Side' },
  { key: 'Back - Top (Back Control)', label: 'Back' },
];

export default function TechniquesScreen() {
  const getToken = useAuthToken();
  const router = useRouter();

  const [all, setAll] = useState<TechniqueSummary[]>([]);
  const [rulesets, setRulesets] = useState<Map<string, Ruleset>>(new Map());
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState('');
  const [loading, setLoading] = useState(true);
  /** Distinguishes "nothing here" from "we never managed to read". */
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Without this a retry rendered the list branch with an empty list and no
    // spinner — "Library unavailable" with nothing happening, which reads as a
    // dead end rather than a request in flight.
    setLoading(true);
    setError(null);
    // A captive portal accepts the connection and never answers, so an
    // un-deadlined fetch spins until RN's ~60s default with no way back.
    const deadline = setTimeout(() => ac.abort(), 10_000);
    try {
      const [list, rs] = await Promise.all([
        fetchTechniques(getToken, ac.signal),
        fetchRulesets(getToken, ac.signal),
      ]);
      setAll(list);
      setRulesets(rs);
      setEverLoaded(true);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // A superseded request must not clear the spinner the newer one owns.
        if (abortRef.current === ac) setLoading(false);
        return;
      }
      setError('Could not load the technique library.');
    } finally {
      clearTimeout(deadline);
      if (abortRef.current === ac) setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Recomputed only when the inputs change, not on every render — at 466 rows
  // an unmemoised filter runs on each keystroke's re-render as well as the
  // keystroke itself.
  const visible = useMemo(() => {
    const byPosition = position ? all.filter((t) => t.position === position) : all;
    return searchTechniques(byPosition, query);
  }, [all, position, query]);

  const isFiltered = query.trim() !== '' || position !== '';

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.search}
        placeholder="Search techniques or aliases"
        placeholderTextColor={vola.textDim}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search techniques"
        testID="techniques-search"
      />

      <FlatList
        horizontal
        data={POSITIONS}
        keyExtractor={(p) => p.key || 'all'}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
        style={styles.filterList}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.filter, position === item.key && styles.filterOn]}
            onPress={() => setPosition(item.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: position === item.key }}
            testID={`techniques-filter-${item.key || 'all'}`}
          >
            <Text style={[styles.filterText, position === item.key && styles.filterTextOn]}>
              {item.label}
            </Text>
          </Pressable>
        )}
      />

      {loading ? (
        <View style={styles.centre}>
          <ActivityIndicator color={vola.lime} />
        </View>
      ) : error ? (
        <View style={styles.centre}>
          <Text style={styles.error} testID="techniques-error">
            {error}
          </Text>
          <Pressable onPress={() => void load()} hitSlop={10} accessibilityRole="button">
            <Text style={styles.retry}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.listContent}
          // Virtualised: 466 rows mounted at once is a visible stall.
          initialNumToRender={14}
          windowSize={9}
          removeClippedSubviews
          ListEmptyComponent={
            <Text style={styles.empty}>
              {/* Only claims emptiness after a read actually succeeded. */}
              {!everLoaded
                ? 'Library unavailable.'
                : isFiltered
                  ? 'No techniques match this filter.'
                  : 'No techniques yet.'}
            </Text>
          }
          renderItem={({ item }) => {
            const rs = rulesets.get(item.ibjjf_ruleset_id);
            return (
              <Pressable
                style={styles.row}
                onPress={() => router.push(`/technique/${item.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${item.position}`}
                testID={`technique-row-${item.id}`}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowName}>{item.name}</Text>
                  <Text style={styles.rowMeta}>
                    {item.position}
                    {item.position_detail ? ` · ${item.position_detail}` : ''}
                  </Text>
                </View>
                {/* Straight from the API. Never inferred from belt counts —
                    see Ruleset.is_restricted for why that reads wrong. */}
                {rs?.is_restricted && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>IBJJF</Text>
                  </View>
                )}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 8 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  error: { color: vola.danger, fontSize: 14, textAlign: 'center' },
  retry: { color: vola.lime, fontSize: 14, fontWeight: '600' },

  search: {
    marginHorizontal: 20,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: vola.text,
  },

  filterList: { flexGrow: 0 },
  filterRow: { paddingHorizontal: 20, paddingVertical: 12, gap: 8 },
  filter: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  filterOn: { backgroundColor: vola.lime, borderColor: vola.lime },
  filterText: { color: vola.textMuted, fontSize: 13, fontWeight: '600' },
  filterTextOn: { color: vola.navy },

  listContent: { paddingHorizontal: 20, paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
  },
  rowMain: { flex: 1, gap: 2 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowMeta: { color: vola.textDim, fontSize: 12 },

  badge: {
    borderWidth: 1,
    borderColor: vola.warn,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  badgeText: { color: vola.warn, fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },

  empty: { color: vola.textDim, fontSize: 14, textAlign: 'center', paddingVertical: 40 },
});
