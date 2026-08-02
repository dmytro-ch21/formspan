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
import { getStanding } from '@/lib/bjj';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import { PREF_LIBRARY_BELT, PREF_LIBRARY_SPORT, readPref, writePref } from '@/lib/prefs';
import { cacheExercises, cachedExercises } from '@/lib/sessionStore';
import {
  fetchRulesets,
  fetchTechniques,
  searchTechniques,
  type Ruleset,
  type TechniqueSummary,
} from '@/lib/techniques';
import { useModules } from '@/lib/ModulesProvider';
import { enabledSports, moduleFor, type Module } from '@/lib/modules';
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

/**
 * Position is a BJJ-only axis, so its chips render only under the BJJ filter —
 * which means the filter may only be *applied* there too. Applying it whenever
 * techniques were on screen (which includes "All") left a selection from a
 * previous visit narrowing the list with its control nowhere in sight:
 * BJJ → Mount → All silently hid every non-Mount technique, so searching
 * "triangle" found nothing while Triangle from Guard sat in the database.
 */
function usesPosition(sport: string, mods: Module[]): boolean {
  const m = moduleFor(mods, sport);
  // `enabled` as well as the facet. Without it this answers "does BJJ have
  // positions" rather than "should position chips be reachable" — true even
  // with BJJ off. Unreachable today because `sport` can only hold a rendered
  // (therefore enabled) chip, but that is a property of two other guards
  // rather than of this function, and the next caller won't know that.
  return (m?.enabled && m.capabilities.facets.includes('position')) ?? false;
}

/** Same reasoning as {@link usesPosition}, for the belt cap. */
function usesBelt(sport: string, mods: Module[]): boolean {
  const m = moduleFor(mods, sport);
  return (m?.enabled && m.capabilities.facets.includes('belt')) ?? false;
}

/**
 * One collator, built once.
 *
 * `String.prototype.localeCompare` re-enters ICU per call; sorting ~990 merged
 * rows on every keystroke is ~10k of those on the JS thread, which is felt as
 * typing lag. Both sources are kept pre-sorted instead and merged linearly, so
 * a keystroke costs ~990 comparisons through a reused collator rather than 10k
 * through a fresh one.
 */
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

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

/**
 * Belt filters, capped rather than exact-match.
 *
 * Picking "Blue" shows White and Blue material, not Blue alone — a curriculum
 * is cumulative, so a Blue-belt technique doesn't stop being relevant the day
 * you reach Brown. An exact-match filter would hide material a higher belt
 * still uses, which is the opposite of what "commonly taught from" means.
 *
 * Deliberately NOT the same axis as IBJJF legality (`gi_allowed_belts` /
 * `no_gi_allowed_belts` on the ruleset) — see the technique-library history
 * entries on why "commonly taught from" and "legal to compete with" are two
 * different questions that must not collapse into one filter.
 */
const BELT_CAPS = [
  { key: '', label: 'All levels' },
  { key: 'White', label: 'White' },
  { key: 'Blue', label: 'Blue' },
  { key: 'Purple', label: 'Purple' },
  { key: 'Brown', label: 'Brown' },
  { key: 'Black', label: 'Black' },
] as const;

/** Matches the technique catalog's own capitalisation of `typical_belt`. */
const BELT_RANK: Record<string, number> = { White: 0, Blue: 1, Purple: 2, Brown: 3, Black: 4 };

function atOrBelowBelt(typicalBelt: string, cap: string): boolean {
  const capRank = BELT_RANK[cap];
  const rowRank = BELT_RANK[typicalBelt];
  // An unrecognised value on either side means "don't filter this out" —
  // hiding real content because its categorisation is unreadable is worse
  // than showing one extra row. Same reasoning as bjj.StandingFrom skipping
  // an unknown belt rather than sorting it as zero.
  if (capRank === undefined || rowRank === undefined) return true;
  return rowRank <= capRank;
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
  const { modules } = useModules();

  /**
   * Chips from the registry, with All first. This replaces a hardcoded list
   * that disagreed with three others in this app.
   */
  const sportChips = [{ key: '', label: 'All' }, ...enabledSports(modules)];

  /**
   * Which content kinds are reachable, derived from capabilities rather than
   * from a hardcoded set of sport keys.
   *
   * `showTechniques` gates the FETCH, not just the chips. Hiding a module
   * should cut the request: the technique list is ~65 kB and was pulled on
   * every Library visit regardless of whether the user does BJJ.
   */
  const techniqueSport = modules.find((m) => m.enabled && m.capabilities.catalog === 'techniques');
  const { userId } = useAuth();
  const router = useRouter();

  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);
  const [rulesets, setRulesets] = useState<Map<string, Ruleset>>(new Map());
  const [techniquesFailed, setTechniquesFailed] = useState(false);
  const [sport, setSportState] = useState<string>('');
  const [position, setPosition] = useState('');
  const [belt, setBeltState] = useState('');
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
      .then((v) => {
        // Guarded: a stored key whose discipline has since been turned off
        // would filter the list to a chip that is no longer rendered — the
        // exact bug this file documents above for positions, one level up.
        if (v && enabledSports(modules).some((m) => m.key === v)) setSportState(v);
      })
      .catch(() => {});
    // `modules` is a dependency because the guard reads it: on a cold start
    // the cache resolves first and this must re-check against it.
  }, [userId, modules]);

  const setSport = useCallback(
    (next: string) => {
      setSportState(next);
      // Belt and braces alongside `usesPosition`: clearing it means returning
      // to BJJ starts unfiltered rather than resuming a selection the user
      // last saw several screens ago.
      if (!usesPosition(next, modules)) setPosition('');
      if (userId) writePref(userId, PREF_LIBRARY_SPORT, next).catch(() => {});
    },
    // `modules` is read via usesPosition; without it this captures the
    // first-render empty list forever and over-clears the position filter.
    [userId, modules],
  );

  /**
   * The belt cap, restored like the sport filter — with one thing sport
   * doesn't have: a first-time default. A brand-new visit with no stored
   * choice suggests the athlete's own recorded rank, once, the same way a
   * belt-level curriculum would open on "your level" rather than "everything"
   * — see the design note in docs/decisions/history.md on why belt is meant
   * to be the entry point into that loop rather than decoration. It is only
   * ever a suggestion: every chip stays reachable, for browsing above or
   * below your own rank.
   *
   * `beltDefaultedFor` holds the ACCOUNT already suggested for, not a
   * boolean, because a boolean conflates two questions: "have we already
   * spent a request on this?" (so a `modules` reference change — this
   * effect's own dependency, for the same cold-start reason the sport
   * restore has it — doesn't repeat a call whose answer cannot have
   * changed) and "was that for the person currently signed in?" (so the
   * next athlete on a shared device still gets their own default instead of
   * being skipped because the flag was already set by the previous one).
   */
  const beltDefaultedFor = useRef<string | null>(null);
  /**
   * The CURRENT account, readable from inside an in-flight callback.
   *
   * The same guard, for the same reason, as `ModulesProvider`'s: this effect
   * closes over `userId`, so comparing a captured copy against the
   * closed-over one compares a value with itself and can never fire. Only a
   * ref changes underneath a running promise — and this promise awaits a
   * network round trip, which is a wide enough window to land athlete A's
   * belt on athlete B's screen after a fast sign-out/sign-in.
   */
  const currentUser = useRef(userId);
  useEffect(() => {
    currentUser.current = userId;
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const forUser = userId;
    readPref(forUser, PREF_LIBRARY_BELT)
      .then(async (v) => {
        if (forUser !== currentUser.current) return;
        if (v && BELT_RANK[v] !== undefined) {
          setBeltState(v);
          beltDefaultedFor.current = forUser;
          return;
        }
        if (beltDefaultedFor.current === forUser) return;
        const bjjModule = modules.find((m) => m.key === 'bjj');
        // Modules haven't loaded yet — wait for a real answer rather than
        // guessing "off" from an empty list.
        if (!bjjModule) return;
        // Nothing stored for THIS account, so whatever is on screen belongs
        // to whoever was signed in before. Cleared before the lookup rather
        // than after it, because the lookup can legitimately end without a
        // value (no rank recorded, BJJ off, offline) and every one of those
        // outcomes must still leave B looking at B's state, not A's.
        setBeltState('');
        beltDefaultedFor.current = forUser;
        if (!bjjModule.enabled) return;
        try {
          const standing = await getStanding(getToken);
          // The account may have changed while this was in flight.
          if (forUser !== currentUser.current) return;
          if (!standing.current) return;
          const capitalised =
            standing.current.belt.charAt(0).toUpperCase() + standing.current.belt.slice(1);
          setBeltState(capitalised);
          writePref(forUser, PREF_LIBRARY_BELT, capitalised).catch(() => {});
        } catch {
          // No default is a fine default — the row still lets them pick one.
        }
      })
      .catch(() => {});
  }, [userId, modules, getToken]);

  const setBelt = useCallback(
    (next: string) => {
      setBeltState(next);
      if (userId) writePref(userId, PREF_LIBRARY_BELT, next).catch(() => {});
    },
    [userId],
  );

  /**
   * Clear the search on the way out — but not when the way out is a result.
   *
   * The blur fires for pushing `/technique/[id]` too, so "search, open a
   * result, come back" used to return an empty box and all ~990 rows. That
   * breaks the one flow this screen exists for (compare three armbars), while
   * the original reason for clearing — coming back next session to a short
   * list for no visible reason — only applies to leaving via the tab bar.
   */
  const keepQueryRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      keepQueryRef.current = false;
      return () => {
        if (!keepQueryRef.current) setQuery('');
      };
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

  const techniqueAbortRef = useRef<AbortController | null>(null);

  /**
   * Techniques load once, independently of the exercise query.
   *
   * Not folded into `load()` on purpose: it is a single unfiltered fetch that
   * is then reused for every keystroke, so re-running it per query would undo
   * the reason for holding it. A failure here must not take the exercise list
   * down with it — the two halves of the library fail separately.
   *
   * It needs its own deadline for the same reason the exercise fetch has one:
   * a captive portal accepts the connection and never answers, and iOS won't
   * give up for ~60s. Without it the technique half is simply absent that whole
   * time, with no spinner and no message to say so.
   */
  const loadTechniques = useCallback(async () => {
    // The gate the commit message CLAIMED existed and didn't. Without this the
    // technique list plus rulesets (~65 kB) were pulled on every Library mount
    // and every pull-to-refresh, for every user, regardless of whether they do
    // the discipline. Hiding a module has to cut the request, not just the
    // pixels — otherwise "hidden" costs exactly as much as shown.
    if (!techniqueSport) {
      setTechniques([]);
      setTechniquesFailed(false);
      return;
    }
    techniqueAbortRef.current?.abort();
    const ac = new AbortController();
    techniqueAbortRef.current = ac;
    const deadline = setTimeout(() => ac.abort(), 10_000);
    try {
      const [list, rs] = await Promise.all([
        fetchTechniques(getToken, ac.signal),
        fetchRulesets(getToken, ac.signal),
      ]);
      setTechniques(list);
      setRulesets(rs);
      setTechniquesFailed(false);
    } catch (err) {
      // A supersede is not a failure; a timeout is. `fetchTechniques` rejects
      // with AbortError for both, so the only way to tell them apart is
      // whether this controller is still the current one.
      if (techniqueAbortRef.current === ac) setTechniquesFailed(true);
    } finally {
      clearTimeout(deadline);
    }
  }, [getToken, techniqueSport]);

  useEffect(() => {
    void loadTechniques();
    return () => techniqueAbortRef.current?.abort();
  }, [loadTechniques]);

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

      // LOCAL FIRST. This screen wrote the cache and never read it, so the
      // catalog was online-only — and the exercise picker it feeds is the one
      // thing you reach for mid-workout, in the room with the worst signal in
      // the building. Rendering the cache first also means the spinner is
      // reserved for a genuinely empty device rather than shown over content
      // we already hold.
      let showedCache = false;
      try {
        const q = query.trim().toLowerCase();
        const local = (await cachedExercises(sport || undefined)).filter(
          (e) => !q || e.name.toLowerCase().includes(q),
        );
        if (!controller.signal.aborted && local.length > 0) {
          setExercises(local);
          setEverLoaded(true);
          setLoading(false);
          showedCache = true;
        }
      } catch {
        // The network read below is still the real attempt.
      }

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
        // With a cached catalog on screen, failing to refresh is an ordinary
        // offline state, not an error worth covering it with.
        if (showedCache) return;
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

  // Symmetric to the stored-filter guard on load: if the discipline currently
  // filtering the list gets turned off while the user is standing here, the
  // chip disappears and the filter would keep applying with no visible
  // control — the invisible-filter bug this file documents for positions.
  useEffect(() => {
    if (sport && !enabledSports(modules).some((m) => m.key === sport)) {
      setSportState('');
      setPosition('');
    }
  }, [modules, sport]);

  // "All" shows techniques when the athlete does that discipline; a specific
  // sport shows them when that sport is the one carrying them.
  const showTechniques =
    techniqueSport !== undefined && (sport === '' || sport === techniqueSport.key);

  // Sorted once per source, not once per keystroke. Filtering preserves order,
  // so the filtered halves stay sorted and merge linearly below.
  const sortedExercises = useMemo(
    () => [...exercises].sort((a, b) => collator.compare(a.name, b.name)),
    [exercises],
  );
  const sortedTechniques = useMemo(
    () => [...techniques].sort((a, b) => collator.compare(a.name, b.name)),
    [techniques],
  );

  /**
   * The merged list, alphabetical across both kinds.
   *
   * Alphabetical rather than exercises-then-techniques: a grouped order is a
   * split wearing a different hat, and it makes the answer to "is armbar in
   * here?" depend on knowing which group an armbar belongs to.
   *
   * Exercises are filtered locally *as well as* server-side. The server is the
   * authority, but its answer is 250 ms + a round trip behind the keystroke,
   * and without the local pass every technique match appeared interleaved
   * through the full stale exercise catalog, which then vanished when the
   * response landed. Two visible settling phases per keystroke reads as jank
   * regardless of how fast it actually is.
   */
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const ex = q
      ? sortedExercises.filter((e) => e.name.toLowerCase().includes(q))
      : sortedExercises;

    let tq: TechniqueSummary[] = [];
    if (showTechniques) {
      let scoped = sortedTechniques;
      if (usesPosition(sport, modules) && position) {
        scoped = scoped.filter((t) => inPositionFamily(t.position, position));
      }
      if (usesBelt(sport, modules) && belt) {
        scoped = scoped.filter((t) => atOrBelowBelt(t.typical_belt, belt));
      }
      tq = searchTechniques(scoped, query);
    }

    // Linear merge of two sorted runs.
    const out: Row[] = [];
    let i = 0;
    let j = 0;
    while (i < ex.length || j < tq.length) {
      const takeExercise =
        j >= tq.length || (i < ex.length && collator.compare(ex[i].name, tq[j].name) <= 0);
      if (takeExercise) {
        const e = ex[i++];
        out.push({ kind: 'exercise', key: `e:${e.id}`, name: e.name, ex: e });
      } else {
        const t = tq[j++];
        out.push({ kind: 'technique', key: `t:${t.id}`, name: t.name, t });
      }
    }
    return out;
  }, [sortedExercises, sortedTechniques, showTechniques, sport, position, belt, query]);

  // Each clause has to match the condition the `rows` memo actually filters
  // on, not just "is this value set". Belt is deliberately NOT cleared when
  // the sport chip moves off BJJ, so a cap can sit in state with its row
  // hidden and doing nothing — counting it there would answer an empty
  // catalog with "Nothing matches this filter" when nothing is filtering.
  const isFiltered =
    query.trim() !== '' ||
    sport !== '' ||
    position !== '' ||
    (usesBelt(sport, modules) && belt !== '');

  return (
    <View style={styles.container} testID="library-screen">
      <ScreenHeader title="Library" />

      <View style={styles.controls}>
        <TextInput
          style={styles.search}
          placeholder={showTechniques ? 'Search exercises and techniques' : 'Search exercises'}
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
          {sportChips.map((s) => {
            const active = sport === s.key;
            return (
              <Pressable
                key={s.key || 'all'}
                onPress={() => setSport(s.key)}
                style={[styles.chip, active && styles.chipActive]}
                hitSlop={8}
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
        {usesPosition(sport, modules) && (
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
                  hitSlop={8}
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

        {/* Same reasoning as the position row, one axis over: BJJ-only, and
            hidden rather than shown-and-inert against a strength catalog. */}
        {usesBelt(sport, modules) && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.positionRow}
          >
            {BELT_CAPS.map((b) => {
              const active = belt === b.key;
              return (
                <Pressable
                  key={b.key || 'all'}
                  onPress={() => setBelt(b.key)}
                  style={[styles.posChip, active && styles.posChipActive]}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter up to ${b.label}`}
                  accessibilityState={{ selected: active }}
                  testID={`library-belt-${b.key || 'all'}`}
                >
                  <Text style={[styles.posText, active && styles.posTextActive]}>{b.label}</Text>
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
          BJJ techniques couldn&apos;t load. Pull down to try again.
        </Text>
      )}

      {loading && !everLoaded && rows.length === 0 ? (
        <ActivityIndicator style={styles.loader} testID="library-loading" />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={styles.list}
          // Without this the first tap on a result only dismisses the keyboard,
          // so search-then-open — the main use of this screen — takes two taps.
          keyboardShouldPersistTaps="handled"
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
                // The technique half has its own request, so a refresh that
                // only re-ran the exercise fetch made "Pull down to try again"
                // a promise the screen could not keep.
                void loadTechniques();
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
              <ExerciseRow
                ex={item.ex}
                onPress={() => {
                  keepQueryRef.current = true;
                  router.push(`/exercise/${item.ex.id}`);
                }}
              />
            ) : (
              <TechniqueRow
                t={item.t}
                restricted={rulesets.get(item.t.ibjjf_ruleset_id)?.is_restricted ?? false}
                onPress={() => {
                  keepQueryRef.current = true;
                  router.push(`/technique/${item.t.id}`);
                }}
              />
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

function TechniqueRow({
  t,
  restricted,
  onPress,
}: {
  t: TechniqueSummary;
  restricted: boolean;
  onPress: () => void;
}) {
  const [code, accent] = categoryBadge(t.category);
  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      // The tile's colour and code are decorative to a screen reader, so the
      // category has to be said here or it is not conveyed at all.
      accessibilityLabel={
        `${t.name}, ${t.category} from ${t.position}. BJJ technique.` +
        // The badge is a bordered View with no text a screen reader reaches,
        // so the restriction has to be said here or it isn't conveyed at all.
        (restricted ? ' Restricted in IBJJF competition.' : '')
      }
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
      {/* Straight from the API's is_restricted. Never inferred from belt
          counts — adult no-gi has no white belt division, so counting flags
          ~130 ordinary techniques instead of the real 20. */}
      {restricted && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>IBJJF</Text>
        </View>
      )}
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

  badge: {
    borderWidth: 1,
    borderColor: vola.warn,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  badgeText: { color: vola.warn, fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
});
