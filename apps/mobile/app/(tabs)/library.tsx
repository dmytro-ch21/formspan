import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
} from 'react-native';

import { useAuth } from '@clerk/clerk-expo';

import { LibraryTile, categoryBadge, patternBadge } from '@/components/LibraryTile';
import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import { PREF_LIBRARY_SPORT, readPref, writePref } from '@/lib/prefs';
import { cacheExercises } from '@/lib/sessionStore';
import { fetchTechniques, searchTechniques, type TechniqueSummary } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The Library — **one** library.
 *
 * Exercises and BJJ techniques live in the same list, behind the same search
 * box, filtered by the same chips. An earlier version put techniques behind a
 * "BJJ Techniques" link row that pushed a separate screen with its own search
 * and its own visual language, and it was wrong twice over: it split a thing
 * the product treats as one, and tapping the existing "BJJ" chip gave you
 * twenty bear-crawl drills while the 466 actual techniques sat somewhere else
 * entirely. If the word "library" means anything it means one place to look.
 *
 * What differs between the two kinds is what a row *says*, not where it lives:
 * an exercise shows its movement pattern and load type, a technique shows its
 * position and category. Both get a tile (see components/LibraryTile), which
 * is what stops a 990-row list reading as a wall of text.
 *
 * Performance shape: exercises are filtered server-side (the catalog is
 * paginated and the query is cheap there), techniques are fetched **once** and
 * filtered in memory — 466 summaries are ~65 KB, so holding them makes typing
 * free and works with no signal. Different mechanisms, deliberately; the same
 * search box drives both.
 */

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

const SPORTS = [
  { key: '', label: 'All' },
  { key: 'strength', label: 'Strength' },
  { key: 'bjj', label: 'BJJ' },
  { key: 'running', label: 'Running' },
] as const;

/** Sports whose content includes techniques. */
const HAS_TECHNIQUES = new Set(['', 'bjj']);

/**
 * Position filters, keyed on the *family* rather than the exact position.
 *
 * Exact keys ("Mount - Top") reached 274 of 466 techniques and quietly
 * excluded every bottom and escape position — half the library, and the half a
 * white belt needs most. Worse, a chip labelled "Mount" that returns only
 * Mount-Top is a label making a promise the filter doesn't keep. Matching the
 * family covers 458 of 466.
 *
 * "Half Guard" is listed separately and before nothing else depends on it:
 * `startsWith('Guard - ')` cannot match "Half Guard - Bottom", so the two
 * never overlap.
 */
const POSITIONS = [
  { key: '', label: 'All positions' },
  { key: 'Guard', label: 'Guard' },
  { key: 'Half Guard', label: 'Half guard' },
  { key: 'Standing', label: 'Standing' },
  { key: 'Mount', label: 'Mount' },
  { key: 'Side Control', label: 'Side control' },
  { key: 'Back', label: 'Back' },
  { key: 'Turtle', label: 'Turtle' },
] as const;

function inPositionFamily(position: string, family: string): boolean {
  return position === family || position.startsWith(`${family} - `);
}

/** Human labels for the load types the catalog uses. */
const LOAD_LABEL: Record<Exercise['load_type'], string> = {
  weight_reps: 'Weight × reps',
  reps: 'Reps',
  time: 'Time',
  distance: 'Distance',
  distance_time: 'Distance & time',
};

/** One list, two kinds of row. */
type Row =
  | { kind: 'exercise'; key: string; name: string; ex: Exercise }
  | { kind: 'technique'; key: string; name: string; t: TechniqueSummary };

export default function LibraryScreen() {
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const router = useRouter();

  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);
  const [techniquesFailed, setTechniquesFailed] = useState(false);
  const [sport, setSportState] = useState<string>('');
  const [position, setPosition] = useState('');
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
      // A position filter left over from BJJ would silently narrow nothing
      // visible once the chips are gone.
      if (!HAS_TECHNIQUES.has(next)) setPosition('');
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

  /**
   * Techniques load once, independently of the exercise query.
   *
   * Not folded into `load()` on purpose: it is a single unfiltered fetch that
   * is then reused for every keystroke, so re-running it per query would undo
   * the reason for holding it. A failure here must not take the exercise list
   * down with it — the two halves of the library fail separately.
   */
  useEffect(() => {
    const ac = new AbortController();
    fetchTechniques(getToken, ac.signal)
      .then((list) => {
        setTechniques(list);
        setTechniquesFailed(false);
      })
      .catch((err) => {
        if ((err as Error)?.name !== 'AbortError') setTechniquesFailed(true);
      });
    return () => ac.abort();
  }, [getToken]);

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

  const showTechniques = HAS_TECHNIQUES.has(sport);

  /**
   * The merged list, sorted by name.
   *
   * Alphabetical across both kinds rather than exercises-then-techniques: a
   * grouped order is a split wearing a different hat, and it makes the answer
   * to "is "armbar" in here?" depend on knowing which group it belongs to.
   */
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = exercises.map((ex) => ({
      kind: 'exercise',
      key: `e:${ex.id}`,
      name: ex.name,
      ex,
    }));

    if (showTechniques) {
      const byPosition = position
        ? techniques.filter((t) => inPositionFamily(t.position, position))
        : techniques;
      for (const t of searchTechniques(byPosition, query)) {
        out.push({ kind: 'technique', key: `t:${t.id}`, name: t.name, t });
      }
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [exercises, techniques, showTechniques, position, query]);

  const isFiltered = query.trim() !== '' || sport !== '' || position !== '';

  return (
    <View style={styles.container} testID="library-screen">
      <ScreenHeader title="Library" />

      <View style={styles.controls}>
        <TextInput
          style={styles.search}
          placeholder="Search exercises and techniques"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Search exercises and techniques by name"
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

        {/* Position is a BJJ-only axis, so it appears only when BJJ content is
            on screen. A permanently-visible row of positions that does nothing
            to a strength catalog is worse than no row. */}
        {sport === 'bjj' && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.positionRow}
          >
            {POSITIONS.map((p) => {
              const active = position === p.key;
              return (
                <Pressable
                  key={p.key || 'all'}
                  onPress={() => setPosition(p.key)}
                  style={[styles.posChip, active && styles.posChipActive]}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter by ${p.label}`}
                  accessibilityState={{ selected: active }}
                  testID={`library-position-${p.key || 'all'}`}
                >
                  <Text style={[styles.posText, active && styles.posTextActive]}>{p.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="library-error">
          {error}
        </Text>
      )}
      {/* Named separately from the exercise error: the two halves fail
          independently, and "techniques couldn't load" is not the same claim
          as "the library is down". */}
      {techniquesFailed && showTechniques && !error && (
        <Text
          style={styles.error}
          accessibilityLiveRegion="polite"
          testID="library-technique-error"
        >
          Techniques couldn&apos;t load. Pull down to try again.
        </Text>
      )}

      {loading && !everLoaded && rows.length === 0 ? (
        <ActivityIndicator style={styles.loader} testID="library-loading" />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={styles.list}
          // Virtualised: the merged catalog is ~990 rows, and mounting that
          // many at once is a visible stall on a phone.
          initialNumToRender={12}
          windowSize={9}
          removeClippedSubviews
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
                {isFiltered ? 'Nothing matches this filter.' : 'Nothing here yet.'}
              </Text>
            )
          }
          renderItem={({ item }) =>
            item.kind === 'exercise' ? (
              <ExerciseRow ex={item.ex} onPress={() => router.push(`/exercise/${item.ex.id}`)} />
            ) : (
              <TechniqueRow t={item.t} onPress={() => router.push(`/technique/${item.t.id}`)} />
            )
          }
        />
      )}
    </View>
  );
}

function ExerciseRow({ ex, onPress }: { ex: Exercise; onPress: () => void }) {
  const [code, accent] = patternBadge(ex.movement_pattern);
  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${ex.name}, ${ex.sport} exercise. See your last session.`}
      testID={`exercise-${ex.id}`}
    >
      <LibraryTile uri={pickImage(ex, 'thumbnail')} code={code} accent={accent} />
      <View style={styles.rowBody}>
        <Text style={styles.name}>{ex.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {ex.movement_pattern.replace(/_/g, ' ')} · {LOAD_LABEL[ex.load_type]}
          {ex.is_unilateral ? ' · per side' : ''}
        </Text>
        {ex.primary_muscles.length > 0 && (
          <Text style={styles.muted} numberOfLines={1}>
            {ex.primary_muscles.map((m) => m.replace(/_/g, ' ')).join(', ')}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function TechniqueRow({ t, onPress }: { t: TechniqueSummary; onPress: () => void }) {
  const [code, accent] = categoryBadge(t.category);
  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      // The tile's colour and code are decorative to a screen reader, so the
      // category has to be said here or it is not conveyed at all.
      accessibilityLabel={`${t.name}, ${t.category} from ${t.position}. BJJ technique.`}
      testID={`technique-${t.id}`}
    >
      <LibraryTile code={code} accent={accent} />
      <View style={styles.rowBody}>
        <Text style={styles.name}>{t.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {t.position}
          {t.position_detail ? ` · ${t.position_detail}` : ''}
        </Text>
        {t.aliases.length > 0 && (
          <Text style={styles.muted} numberOfLines={1}>
            {t.aliases.join(', ')}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  controls: { paddingHorizontal: 20, gap: 12 },

  search: {
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: vola.text,
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: vola.lime, borderColor: vola.lime },
  chipText: { color: vola.textMuted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: vola.navy },

  positionRow: { gap: 8, paddingRight: 20 },
  posChip: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  posChipActive: { borderColor: vola.textMuted, backgroundColor: vola.surfaceRaised },
  posText: { color: vola.textDim, fontSize: 12, fontWeight: '600' },
  posTextActive: { color: vola.text },

  error: { color: vola.danger, fontSize: 13, paddingHorizontal: 20, paddingTop: 10 },
  loader: { marginTop: 32 },

  list: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: TAB_BAR_CLEARANCE },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
  },
  rowBody: { flex: 1, gap: 3 },
  name: { fontSize: 15, fontWeight: '600' },
  meta: { color: vola.textMuted, fontSize: 12 },
  muted: { color: vola.textDim, fontSize: 12 },
});
