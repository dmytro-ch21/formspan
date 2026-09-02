import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
} from 'react-native';

import { useAuth } from '@clerk/clerk-expo';

import {
  KeyboardAwareFlatList,
  KeyboardAwareScrollView,
} from '@/components/KeyboardAwareScroll';
import { LibraryTile, categoryBadge, patternBadge, positionBadge } from '@/components/LibraryTile';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { ApiError, transportDiagnosis } from '@/lib/apiError';
import { getStanding } from '@/lib/bjj';
import { stillWanted } from '@/lib/inflight';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/Icon';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import {
  MOVEMENT_GROUPS,
  MUSCLE_GROUPS,
  inMovementGroup,
  inMuscleGroup,
} from '@/lib/exerciseFacets';
import { PREF_LIBRARY_BELT, PREF_LIBRARY_SPORT, readPref, writePref } from '@/lib/prefs';
import { cacheExercises, cachedExercises } from '@/lib/sessionStore';
import {
  fetchRulesets,
  fetchTechniques,
  searchTechniques,
  type Ruleset,
  type TechniqueSummary,
} from '@/lib/techniques';
import { fetchPositions, type Position } from '@/lib/positions';
import { listCurricula, type Curriculum } from '@/lib/curriculum';
import { beltLabel, beltSyllabuses } from '@/lib/syllabuses';
import { useModules } from '@/lib/ModulesProvider';
import {
  enabledSports,
  moduleFor,
  moduleOffWithCatalog,
  moduleWithCatalog,
  type Module,
  usesBelt,
} from '@/lib/modules';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The Library — **one** library.
 *
 * Exercises and BJJ techniques live in the same list, behind the same search
 * box, filtered by the same chips. An earlier version put techniques behind a
 * "BJJ Techniques" link row that pushed a separate screen with its own search
 * and its own visual language, and it was wrong twice over: it split a thing
 * the product treats as one, and tapping the existing "BJJ" chip gave you
 * twenty bear-crawl drills while the 542 actual techniques sat somewhere else
 * entirely. If the word "library" means anything it means one place to look.
 *
 * What differs between the two kinds is what a row *says*, not where it lives:
 * an exercise shows its movement pattern and load type, a technique shows its
 * position and category. Both get a tile (see components/LibraryTile), which
 * is what stops a 1046-row list reading as a wall of text.
 *
 * Performance shape: exercises are filtered server-side (the catalog is
 * paginated and the query is cheap there), techniques are fetched **once** and
 * filtered in memory — 542 summaries are ~197 KB, so holding them makes typing
 * free and works with no signal. Different mechanisms, deliberately; the same
 * search box drives both.
 */

/**
 * How long this screen is willing to wait, handed to the transport.
 *
 * **This used to be armed here, and the mechanism was dead on a phone (N55).**
 * A superseded request (silent) and a timeout (a real error) both abort the
 * same controller, so they were told apart by an abort *reason* —
 * `abort(TIMED_OUT)` and `abort(SUPERSEDED)`, read back off `signal.reason`.
 *
 * React Native replaces the global `AbortController` with
 * `abort-controller@3.0.0`, which has no `reason` at all: `abort(x)` takes the
 * argument and drops it, and `signal.reason` is `undefined` forever. Measured
 * against the installed module. Jest runs on Node, where `reason` works, so
 * every test of this agreed with the code and none of them were about a phone.
 *
 * What that cost on a device: `reason === SUPERSEDED` never matched, so a
 * request abandoned mid-typing fell through to `setError` and printed
 * **"Aborted"**; `reason === TIMED_OUT` never matched, so a real timeout got
 * the generic message instead of its own; and the `finally` guard never
 * matched either, so a superseded request cleared the *newer* request's
 * spinner.
 *
 * Both distinctions are gone rather than repaired. The deadline belongs to
 * `netFetch`, which owns it in a local and reports a `TimeoutError`; this
 * controller is aborted for exactly one reason now — a newer search or an
 * unmount — so `signal.aborted` answers on its own.
 */
const REQUEST_TIMEOUT_MS = 10_000;

function describeError(err: unknown): string {
  // A dead request already says what it was — offline, too slow, or dropped
  // with VOLA reachable. This screen adds its own action because it has a
  // better one than "try again": pull down.
  const diagnosis = transportDiagnosis(err);
  if (diagnosis) return `${diagnosis} Pull down to try again.`;

  // Found under N62: this used to grep the error MESSAGE for the literal
  // substring "(401)", which only ever matched because `fetchExercises`
  // hand-rolled that exact string into a bare `Error`. Now that it throws
  // `ApiError` through `apiRequest` — carrying the real status rather than a
  // string baked at the call site — checking the status is both the more
  // robust answer and the only one that still works: the server's own
  // message never contained "(401)" to begin with.
  if (err instanceof ApiError && err.status === 401) return 'Your session expired. Sign in again.';

  return err instanceof Error ? err.message : String(err);
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

/**
 * Same reasoning again, for the two strength axes.
 *
 * Both read the registry rather than testing `sport === 'strength'`, so a
 * discipline that later declares `muscle` gets the control for free and one
 * that drops it loses the control rather than keeping a dead one.
 */
function usesFacet(sport: string, mods: Module[], facet: string): boolean {
  const m = moduleFor(mods, sport);
  return (m?.enabled && m.capabilities.facets.includes(facet)) ?? false;
}

type FacetKey = 'position' | 'belt' | 'muscle' | 'movement';

/**
 * One collator, built once.
 *
 * `String.prototype.localeCompare` re-enters ICU per call; sorting ~1046 merged
 * rows on every keystroke is ~10k of those on the JS thread, which is felt as
 * typing lag. Both sources are kept pre-sorted instead and merged linearly, so
 * a keystroke costs ~1046 comparisons through a reused collator rather than 10k
 * through a fresh one.
 */
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

/**
 * Position filters, keyed on the *family* rather than the exact position.
 *
 * Exact keys ("Mount - Top") reach 219 of 542 techniques and quietly
 * exclude every bottom and escape position — most of the library, and the part
 * a white belt needs most. Worse, a chip labelled "Mount" that returns only
 * Mount-Top is a label making a promise the filter doesn't keep. Matching the
 * family covers 539 of 542; the 3 left out are the catch-all "Other" position.
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
  // Its 8 techniques were unreachable by any chip while the glossary row
  // directly above advertises the position with a card — the filter has to
  // offer at least what the glossary names.
  { key: 'North-South', label: 'North-south' },
  // Same rule, same reason. The ashi garami family became its own position,
  // and its 30 techniques moved out from under the Guard chip in the same
  // change — so without this they are reachable only by typing. A saddle
  // entry is exactly what someone browses for and cannot spell.
  { key: 'Leg Entanglement', label: 'Leg entanglement' },
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
  const accent = useAccent();
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
   * should cut the request: the technique list is ~197 KB and was pulled on
   * every Library visit regardless of whether the user does BJJ.
   */
  const techniqueSport = moduleWithCatalog(modules, 'techniques');
  /**
   * A technique discipline this server HAS, which this athlete has turned off.
   *
   * The distinction from `techniqueSport` is the whole point of N61. With BJJ
   * off, `techniqueSport` is undefined and every technique surface on this
   * screen — the round map, the belt roadmaps, the position glossary —
   * rendered NOTHING. An athlete cannot tell that from *not built* or from
   * *broken*, and the user proved it: they went looking for the belt roadmaps
   * on a real phone and reported them missing. They exist and work.
   *
   * Deliberately NOT `modules.some(m => !m.enabled)` and not a `key === 'bjj'`
   * comparison. It asks whether this SERVER offers a technique catalog at all,
   * so a build talking to a deployment that genuinely has no such discipline
   * still shows nothing — promising a feature that does not exist would be the
   * same lie pointing the other way.
   */
  const techniqueSportOff = moduleOffWithCatalog(modules, 'techniques');
  const { userId } = useAuth();
  const router = useRouter();

  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);
  const [rulesets, setRulesets] = useState<Map<string, Ruleset>>(new Map());
  const [techniquesFailed, setTechniquesFailed] = useState(false);
  // No matching `positionsFailed`. The glossary is an extra on this screen —
  // if it doesn't load the row is absent, which is quieter and more honest
  // than an error about content the user never asked for.
  const [positions, setPositions] = useState<Position[]>([]);
  // The belt syllabuses, for the reference block below. Same silent-failure
  // treatment as the glossary: this is an extra on a screen whose job is the
  // catalog, and an error banner about content nobody asked for would make an
  // offline Library look broken.
  const [syllabuses, setSyllabuses] = useState<Curriculum[]>([]);
  const [sport, setSportState] = useState<string>('');
  const [position, setPosition] = useState('');
  const [belt, setBeltState] = useState('');
  const [query, setQuery] = useState('');
  // The strength axes. Client-side, over the catalog already loaded — see
  // `lib/exerciseFacets.ts` for why they are groupings and not the raw fields.
  const [muscle, setMuscle] = useState('');
  const [movement, setMovement] = useState('');
  // Which facet's picker is open, or null. One piece of state for all four
  // sheets, the same way the Plan screen's day sheet serves seven rows.
  const [openFacet, setOpenFacet] = useState<FacetKey | null>(null);
  /**
   * What the sheet is DRAWING, which outlives what is open.
   *
   * React Native keeps a modal's children mounted through the iOS dismissal
   * animation — `_shouldShowModal()` stays true until the native `onDismiss`.
   * So rendering straight from `openFacet` meant that after picking an option
   * there was a frame where the title resolved to `''` and the option list to
   * `[]`: the sheet emptied and, now that it is content-sized rather than
   * full-screen, collapsed from ~660pt to ~110pt and *then* slid away. On
   * every single use.
   *
   * This is cleared by `onDismiss` instead, so the sheet keeps its contents
   * until it is actually gone. Android unmounts immediately and never reaches
   * that callback, which is harmless — the modal is already invisible.
   */
  const [shownFacet, setShownFacet] = useState<FacetKey | null>(null);
  /**
   * The "More from your library" sheet — N469 (#794).
   *
   * Everything that used to be three permanently-stacked cards ("Your own
   * chains", "Your class plans", the round map / curricula / belt syllabuses
   * / position glossary) now lives behind this one boolean. None of it
   * filters the technique list — every row inside is a navigation shortcut
   * to a different screen — so it is presented as a bottom sheet rather than
   * folded into the filter row above, which stays reserved for controls that
   * change what THIS list shows.
   */
  const [openExtras, setOpenExtras] = useState(false);
  /**
   * What the sheet is DRAWING, which outlives what is open — the exact
   * `shownFacet`/`openFacet` split above, for the identical reason: a
   * `Modal`'s children are rebuilt by the parent on every render (every
   * keystroke in the search box) whether or not `visible` is true, so an
   * ungated sheet would reconstruct the positions/syllabuses maps and
   * seven `Pressable`s on each keystroke while invisible. Gating the whole
   * subtree on `shownExtras` avoids that; `onDismiss` clears it only once
   * the sheet has genuinely left the screen, so closing doesn't empty its
   * content mid-slide the way rendering straight off `openExtras` would.
   */
  const [shownExtras, setShownExtras] = useState(false);
  // The home indicator's real height, not a guess. `ScreenHeader` already
  // reads insets this way; a hardcoded 28 is right on exactly one device.
  const insets = useSafeAreaInsets();


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
   * The four axes, in the order they are offered.
   *
   * Declared as data rather than four near-identical blocks of JSX, because
   * that is what the two scroll rows were and they had already drifted apart
   * (one said "Filter by", the other "Filter up to"). One table means one
   * button, one sheet, and one place to add the fifth.
   */
  const FACETS: { key: FacetKey; label: string; options: { key: string; label: string }[] }[] = [
    { key: 'position', label: 'Position', options: [...POSITIONS] },
    { key: 'belt', label: 'Belt', options: [...BELT_CAPS] },
    { key: 'muscle', label: 'Muscle', options: [{ key: '', label: 'All' }, ...MUSCLE_GROUPS] },
    { key: 'movement', label: 'Movement', options: [{ key: '', label: 'All' }, ...MOVEMENT_GROUPS] },
  ];
  const facetValue = (k: FacetKey) =>
    k === 'position' ? position : k === 'belt' ? belt : k === 'muscle' ? muscle : movement;
  const setFacetValue = (k: FacetKey, v: string) => {
    if (k === 'position') setPosition(v);
    else if (k === 'belt') setBelt(v);
    else if (k === 'muscle') setMuscle(v);
    else setMovement(v);
  };

  /**
   * Clear the search on the way out — but not when the way out is a result.
   *
   * The blur fires for pushing `/technique/[id]` too, so "search, open a
   * result, come back" used to return an empty box and all ~1046 rows. That
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
    // technique list plus rulesets (~213 KB) were pulled on every Library mount
    // and every pull-to-refresh, for every user, regardless of whether they do
    // the discipline. Hiding a module has to cut the request, not just the
    // pixels — otherwise "hidden" costs exactly as much as shown.
    if (!techniqueSport) {
      setTechniques([]);
      setTechniquesFailed(false);
      setPositions([]);
      // The fourth. Turning the discipline off left stale syllabuses in state,
      // invisible only because the block renders behind a positions check —
      // which is the kind of accident that becomes a bug the day the gate moves.
      setSyllabuses([]);
      return;
    }
    techniqueAbortRef.current?.abort();
    const ac = new AbortController();
    techniqueAbortRef.current = ac;
    const deadline = { timeoutMs: REQUEST_TIMEOUT_MS };

    // Superseded OR unmounted, both of which must set nothing — see
    // `lib/inflight.ts` for why the ref check alone is not enough, and why
    // this is a tested function rather than an inline comparison.
    const wanted = () => stillWanted(techniqueAbortRef.current, ac);
    try {
      const [list, rs] = await Promise.all([
        fetchTechniques(getToken, ac.signal, deadline),
        fetchRulesets(getToken, ac.signal, deadline),
      ]);
      setTechniques(list);
      setRulesets(rs);
      setTechniquesFailed(false);

      // Deliberately after the two that matter, and deliberately swallowed.
      // The glossary must never be the reason the library shows an error.
      //
      // Guarded on the controller for the same reason the outer catch is: a
      // superseded request that rejects after the newer one already populated
      // the row would otherwise blank it.
      try {
        const [list, curricula] = await Promise.all([
          fetchPositions(getToken, ac.signal),
          // Independent of the glossary but on the same swallowed footing:
          // both are reference extras beside the catalog. Promise.all rather
          // than sequential because neither needs the other, and a beginner
          // waiting on two round trips to see a reference block is two too
          // many.
          // ac.signal, not bare: these share a Promise.all with the glossary,
          // so an unbounded request here holds `setPositions` hostage until
          // iOS gives up at ~60s — past the 10s deadline this block builds
          // precisely for the captive-portal case. Review caught it; the
          // premise that this function took no signal was simply wrong.
          listCurricula(getToken, ac.signal).catch(() => [] as Curriculum[]),
        ]);
        if (wanted()) {
          setPositions(list);
          setSyllabuses(beltSyllabuses(curricula));
        }
      } catch {
        if (wanted()) {
          setPositions([]);
          // Cleared together: they are fetched together, so leaving one
          // populated after the pair failed shows a reference block that is
          // half a previous load.
          setSyllabuses([]);
        }
      }
    } catch {
      // A supersede is not a failure, and neither is an unmount; a timeout is.
      // A timeout no longer aborts THIS controller — the deadline lives in the
      // transport and arrives as a `TimeoutError` — so `stillWanted()` is true
      // for one and false for the other two, which is the whole distinction.
      if (wanted()) setTechniquesFailed(true);
    }
  }, [getToken, techniqueSport]);

  useEffect(() => {
    void loadTechniques();
    return () => techniqueAbortRef.current?.abort();
  }, [loadTechniques]);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

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
          // Without a deadline the initial spinner can spin forever on a
          // captive or dead network — and the RefreshControl isn't mounted in
          // the spinner branch, so there'd be no way to recover.
          { timeoutMs: REQUEST_TIMEOUT_MS },
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
        // Superseding our own request is not a failure — showing an error for
        // it would make fast typing look broken. This controller is aborted
        // for that reason only now that the deadline lives in the transport,
        // so `aborted` says it without needing a reason the runtime drops.
        if (controller.signal.aborted) return;
        // With a cached catalog on screen, failing to refresh is an ordinary
        // offline state, not an error worth covering it with.
        if (showedCache) return;
        // Including a timeout, which arrives as a `TimeoutError` and says so.
        setError(describeError(err));
        setEverLoaded(true); // so the empty state stops claiming to be authoritative
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

  /**
   * Whether the "More from your library" affordance has anything behind it.
   *
   * Both halves mirror the gates the sheet's own content already applies —
   * `techniqueSport !== undefined` for the chains/class-plans rows,
   * `usesPosition(sport, modules) && positions.length > 0` for the round map,
   * curricula, belt syllabuses and position glossary. A strength-only account
   * (or BJJ genuinely turned off) has nothing behind either half, and a
   * button that opens an empty sheet is the "state that cannot be
   * constructed" failure this codebase keeps re-finding — so the row itself
   * is absent rather than present-and-empty.
   */
  const showExtras =
    techniqueSport !== undefined || (usesPosition(sport, modules) && positions.length > 0);

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
    let ex = q
      ? sortedExercises.filter((e) => e.name.toLowerCase().includes(q))
      : sortedExercises;
    // Gated on the registry like the technique axes below, so a cap left in
    // state with its control hidden cannot silently filter an unrelated
    // catalog — the bug the belt row's comment records.
    if (usesFacet(sport, modules, 'muscle') && muscle) {
      ex = ex.filter((e) => inMuscleGroup(e, muscle));
    }
    if (usesFacet(sport, modules, 'movement') && movement) {
      ex = ex.filter((e) => inMovementGroup(e, movement));
    }

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
  }, [
    sortedExercises, sortedTechniques, showTechniques, sport, position, belt, query,
    muscle, movement, modules,
  ]);

  // Each clause has to match the condition the `rows` memo actually filters
  // on, not just "is this value set". Belt is deliberately NOT cleared when
  // the sport chip moves off BJJ, so a cap can sit in state with its row
  // hidden and doing nothing — counting it there would answer an empty
  // catalog with "Nothing matches this filter" when nothing is filtering.
  const isFiltered =
    query.trim() !== '' ||
    sport !== '' ||
    position !== '' ||
    (usesBelt(sport, modules) && belt !== '') ||
    (usesFacet(sport, modules, 'muscle') && muscle !== '') ||
    (usesFacet(sport, modules, 'movement') && movement !== '');

  return (
    <View style={styles.container} testID="library-screen">
      {/* No bottom rule here: the search field and filter chips below sit
          between the header and the list, so nothing scrolls under the
          header — `styles.chrome` below is the fixed chrome that owns the
          real boundary, and it draws the rule itself (F21/#497). Two rules
          would be the stacked-seams pattern ScreenHeader exists to have
          removed, so this stays `false`. */}
      <ScreenHeader title="Library" contentScrollsUnder={false} />

      {/* `styles.chrome` wraps the controls block AND the two error banners
          below, not `styles.controls` alone — an error is fixed chrome too
          (it renders as a sibling of the scroll view, never inside it), so
          when one is showing, the actual top of the scrolling region sits
          below it, not below the search/chips. A rule that only ever sat
          under `controls` would leave exactly that state bg-on-bg again:
          the mechanism this ticket exists to fix, reappearing the moment an
          athlete is offline. Wrapping both in one bordered box means the
          rule always sits immediately above whatever is genuinely first in
          the scroll view, in every state. */}
      <View style={styles.chrome} testID="library-chrome">
      <View style={styles.controls} testID="library-controls">
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
        {/*
          ONE slim, single-row filter control — N469 (#794), replacing what
          used to be two separate rows (a wrapping sport-chip row, then a
          horizontally-scrolling facet-button row). Both halves change what
          THIS list shows, which is the one property that earns a spot in
          this row at all: the Spotify Library screen and Hevy's exercise
          library both put every filter that narrows the same list into one
          thin horizontal strip rather than a stack of sections, and this
          merges VOLA's own two into that same strip.

          Sport chips select directly; facet buttons (position/belt/muscle/
          movement) open the picker sheet below. Different interaction, same
          row, same reason for being visible by default: using either one
          changes the catalog underneath it.
        */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {sportChips.map((s) => {
            const active = sport === s.key;
            return (
              <Pressable
                key={s.key || 'all'}
                onPress={() => setSport(s.key)}
                style={[
                  styles.chip,
                  active && [
                    styles.chipActive,
                    { backgroundColor: accent.accent, borderColor: accent.accent },
                  ],
                ]}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Filter by ${s.label}`}
                accessibilityState={{ selected: active }}
                testID={`library-filter-${s.key || 'all'}`}
              >
                <Text style={[styles.chipText, active && [styles.chipTextActive, { color: accent.on }]]}>{s.label}</Text>
              </Pressable>
            );
          })}
          {FACETS.filter((f) => usesFacet(sport, modules, f.key)).map((f) => {
            const value = facetValue(f.key);
            const chosen = f.options.find((o) => o.key === value);
            const active = value !== '';
            return (
              <Pressable
                key={f.key}
                onPress={() => {
                  setShownFacet(f.key);
                  setOpenFacet(f.key);
                }}
                style={[styles.facet, active && styles.facetActive]}
                hitSlop={8}
                accessibilityRole="button"
                // Names the axis AND the value, so a screen reader is not
                // left with a bare "Mount" that could be anything.
                accessibilityLabel={
                  active ? `${f.label}: ${chosen?.label ?? value}. Change` : `Filter by ${f.label}`
                }
                testID={`library-facet-${f.key}`}
              >
                <Text style={[styles.facetText, active && styles.facetTextActive]}>
                  {active ? (chosen?.label ?? value) : f.label}
                </Text>
                <View style={styles.facetCaret}>
                  <Icon name="chevron" size={10} color={active ? vola.text : vola.textDim} />
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* The one expand affordance for everything that is reading rather
            than filtering — "Your own chains", "Your class plans", the round
            map, curricula, belt syllabuses and the position glossary. None of
            these change what the list above shows; every one of them is a
            navigation shortcut to a different screen, so they collapse behind
            a single compact row rather than reappearing as permanent cards.
            See the sheet below (`openExtras`/`shownExtras`) for why a bottom sheet was
            picked over an inline accordion or a full second screen. */}
        {showExtras && (
          <Pressable
            onPress={() => {
              setShownExtras(true);
              setOpenExtras(true);
            }}
            style={styles.extrasRow}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="More from your library"
            accessibilityHint="Your chains, your class plans, and the round map"
            testID="library-extras-toggle"
          >
            <Icon name="layers" size={16} color={vola.textMuted} />
            <Text style={styles.extrasRowText}>More from your library</Text>
            <View style={styles.facetCaret}>
              <Icon name="chevron" size={11} color={vola.textDim} />
            </View>
          </Pressable>
        )}

        {/* What the block below says when the discipline that owns it is off.
            NOT an empty state for "no positions loaded" — that is a different
            failure with a different cause, and conflating them is how "we
            could not reach the server" starts reading as "you do not train
            this". This branch fires only when the module is off, which is a
            fact the app is certain of.

            `techniqueSport === undefined` as well, so an on-and-off PAIR — BJJ
            enabled, a second technique discipline not — cannot render "Judo is
            turned off" directly above the roadmaps it claims are missing.
            Impossible with today's single-technique registry, but the predicate
            matches on the CAPABILITY precisely so a second one can arrive
            server-side without an app change. Raised in review. */}
        {techniqueSport === undefined && techniqueSportOff !== undefined && sport === '' && (
          <View style={styles.glossary} testID="library-techniques-off">
            <Text style={styles.glossaryLabel} accessibilityRole="header">
              {techniqueSportOff.label} is turned off
            </Text>
            <Pressable
              onPress={() => router.push('/profile/edit')}
              accessibilityRole="button"
              accessibilityLabel={`Turn ${techniqueSportOff.label} on to see the belt roadmaps, the position map, your own chains and the technique library`}
              style={({ pressed }) => [styles.mapLink, pressed && styles.posCardPressed]}
              testID="library-techniques-off-link"
            >
              <Text style={styles.mapLinkTitle}>
                Turn it on to see the belt roadmaps
              </Text>
              {/* `your own chains` joined this list with N181 (#586), because
                  the sequences block inside the extras sheet is gated on the
                  same toggle — so turning the discipline off now hides an
                  athlete's OWN captured chains, not only reference content.
                  An absence with nothing accounting for it is N61 exactly,
                  and this explainer is the one place that accounts for the
                  others. */}
              <Text style={styles.mapLinkNote}>
                The position map, your own chains and {techniqueSportOff.label} techniques come
                back too.
              </Text>
            </Pressable>
          </View>
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
      </View>{/* /styles.chrome */}

      {loading && !everLoaded && rows.length === 0 ? (
        <ActivityIndicator style={styles.loader} testID="library-loading" />
      ) : (
        <KeyboardAwareFlatList
          data={rows}
          keyExtractor={(r) => r.key}
          // Bottom padding from the SAFE AREA rather than the tab-bar constant this
        // screen used as a tab. It is pushed over the tabs now, so it runs to the
        // physical bottom of the display — and TAB_BAR_CLEARANCE (28pt) is less
        // than the home indicator's inset, which would leave the last row sitting
        // under it. Raised in review of the move.
        contentContainerStyle={[styles.list, { paddingBottom: Math.max(insets.bottom, 16) + 12 }]}
          // Virtualised: the merged catalog is ~1046 rows, and mounting that
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

      {/*
        One sheet for all four axes.

        The options for an axis are its own; everything else — the title, the
        selected mark, dismissal — is identical, so writing it once is what
        stops the four drifting the way the two scroll rows already had.
      */}
      {/*
        A compact glass sheet, not a full-screen page.

        `presentationStyle="pageSheet"` took over the whole display to offer
        nine short options — a modal context switch for what is really a
        dropdown. This is `transparent` with the card sized to its content and
        anchored to the bottom, so the list you are filtering stays visible
        behind it and the sheet reads as attached to this screen rather than
        as somewhere else.

        The glass follows `BjjRankHeader`'s recipe exactly, including its
        reasoning: NOT `expo-blur`, because a BlurView samples what is behind
        it and would cost a native view to blur a nearly-flat ground. Glass
        here is a translucent panel, a lit top-left edge, and a wash.
      */}
      {/* Gated, matching `WeekPlanner`: a Modal's children are constructed by
          the parent on every render — here, on every keystroke in the search
          box — whether or not it is showing. `shownFacet` rather than
          `openFacet` so the subtree survives the dismissal animation. */}
      {shownFacet !== null && (
      <Modal
        visible={openFacet !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setOpenFacet(null)}
        // iOS-only, and the point of `shownFacet`: fires once the sheet has
        // genuinely left the screen.
        onDismiss={() => setShownFacet(null)}
      >
        {/* Tapping off the sheet closes it — the affordance a bottom sheet is
            expected to have, and which the full-screen version could not offer
            because it had no outside. */}
        {/*
          A touch affordance, NOT an accessibility element. As subview 0 it was
          first in the VoiceOver order and screen-sized, so opening the sheet
          announced "Close filter options, button" instead of the sheet that
          had just appeared. Apple's own convention is that a dimming view is
          not an element; dismissal is the Done button and the two-finger
          escape, both of which this sheet has.
        */}
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpenFacet(null)}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="library-facet-backdrop"
        />
        <View
          style={styles.sheetWrap}
          pointerEvents="box-none"
          // `transparent` is an over-full-screen presentation, so unlike the
          // page sheet it replaced, the screen behind stays in the hierarchy.
          // This is the one prop that makes focus containment certain rather
          // than likely.
          accessibilityViewIsModal
          onAccessibilityEscape={() => setOpenFacet(null)}
        >
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 10 }]}>
          <LinearGradient
            colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.03)', 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          {/* The grab handle a sheet of this shape is read by. */}
          <View style={styles.grabber} />
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>
              {FACETS.find((f) => f.key === shownFacet)?.label ?? ''}
            </Text>
            <Pressable
              onPress={() => setOpenFacet(null)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="library-facet-close"
            >
              <Text style={styles.sheetClose}>Done</Text>
            </Pressable>
          </View>
          <KeyboardAwareScrollView contentContainerStyle={styles.sheetBody}>
            {(FACETS.find((f) => f.key === shownFacet)?.options ?? []).map((o) => {
              const on = shownFacet !== null && facetValue(shownFacet) === o.key;
              return (
                <Pressable
                  key={o.key || 'all'}
                  onPress={() => {
                    if (shownFacet) setFacetValue(shownFacet, o.key);
                    setOpenFacet(null);
                  }}
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  testID={`library-option-${shownFacet}-${o.key || 'all'}`}
                >
                  <Text style={[styles.optionText, on && styles.optionTextOn]}>{o.label}</Text>
                  {/* A mark, not just colour — the row reads as chosen without
                      relying on the accent being distinguishable. */}
                  {/* `ink`, not `accent`: the glass composite is lighter than
                      any surface the palette validator checks, and purple's
                      FILL measures 2.91:1 here — under the 3:1 the palette's
                      own contract requires of a graphic that carries meaning.
                      `ink` exists for precisely that ("fine as a shape, fails
                      as type"). The row also switches to `text` at weight 700,
                      so the state was never carried by the mark alone. */}
                  {on && <Icon name="check" size={14} color={accent.ink} />}
                </Pressable>
              );
            })}
          </KeyboardAwareScrollView>
        </View>
        </View>
      </Modal>
      )}

      {/*
        "More from your library" — the one expand affordance for everything
        that used to be three permanently-stacked cards: your own chains,
        your class plans, the round map, curricula, belt syllabuses and the
        position glossary. N469 (#794).

        **Why a bottom sheet, against the issue's three cited sources.**

        1. General 2026 mobile UX guidance (Apple Maps folding its whole
           search/suggestion surface into a bottom sheet; Telegram moving
           search off the main list) is the direct precedent: a secondary
           surface reachable by one tap, layered over the primary one, rather
           than permanent on-screen chrome. This file already rejected a
           full-screen `pageSheet` for the facet picker above for the same
           reason — "a modal context switch for what is really a dropdown" —
           and everything in this sheet is even more clearly optional than a
           filter picker, so the same reasoning applies at least as strongly.
           A dedicated overlay screen (push a route) was rejected for the same
           reason: it would cost a back-navigation for content the athlete is
           meant to glance at and dismiss.
        2. Spotify's Library pattern keeps *filtering* controls as a thin
           permanent row and reserves anything heavier for the list itself or
           a picker — it doesn't offer a direct precedent for "several
           unrelated navigation shortcuts", because Spotify's personal items
           (pinned playlists) are folded INTO the one list rather than kept as
           links to other screens. VOLA's chains/class-plans/round-map are
           genuinely links elsewhere, so the closest fit is "the thing you tap
           to see more," which a sheet models more directly than an inline
           accordion would.
        3. Hevy folds personal (custom) exercises into the SAME searchable
           list — which is exactly why the position/belt/muscle facets above
           stayed a single filter row rather than gaining a "your content"
           tab. But "Your own chains" and "Your class plans" are not rows of
           the technique/exercise catalog at all; they open entirely different
           screens with their own data. Hevy's answer doesn't transfer to
           content that isn't part of the same list.

        **Why not an inline accordion**, which was the other option this
        ticket named as defensible: expanding one in place, directly above the
        list, either pushes the list down (reintroducing the scroll-past-
        the-header problem this ticket exists to fix, just gated behind a
        tap) or requires the list itself to make room, which risks exactly
        the "loses scroll position" failure the acceptance criteria calls
        out by name. A Modal sheet is laid completely outside the FlatList's
        own tree, so opening and closing it cannot move or remount the list
        underneath — the scroll position survives by construction, not by
        care taken to preserve it.

        **Gated the same way as the facet sheet above, and for the identical
        reason.** `Modal`'s children are constructed by the PARENT on every
        render — here, on every keystroke in the search box — whether or not
        `visible` is true, so an ungated `<Modal visible={openExtras}>` would
        rebuild `positions.map`, `syllabuses.map`, seven `Pressable`s and a
        `LinearGradient` on every keystroke while invisible. Wrapping the
        whole subtree in `shownExtras` (set the moment the affordance is
        tapped, cleared only by `onDismiss` — i.e. once the sheet has
        genuinely finished leaving the screen) is what the facet sheet above
        already does, and review caught this sheet skipping it.
      */}
      {shownExtras && (
      <Modal
        visible={openExtras}
        animationType="slide"
        transparent
        onRequestClose={() => setOpenExtras(false)}
        // iOS-only, matching the facet sheet: fires once the dismissal
        // animation has actually finished, not the instant `openExtras` flips.
        onDismiss={() => setShownExtras(false)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpenExtras(false)}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="library-extras-backdrop"
        />
        <View
          style={styles.sheetWrap}
          pointerEvents="box-none"
          accessibilityViewIsModal
          onAccessibilityEscape={() => setOpenExtras(false)}
        >
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 10 }]}>
            <LinearGradient
              colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.03)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 0.9, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.grabber} />
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>More from your library</Text>
              <Pressable
                onPress={() => setOpenExtras(false)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Close"
                testID="library-extras-close"
              >
                <Text style={styles.sheetClose}>Done</Text>
              </Pressable>
            </View>
            {/* `KeyboardAwareScrollView`, not a bare `ScrollView` — this
                sheet has no `TextInput` of its own, but this file's keyboard-
                coverage guard (`components/__tests__/keyboardCoverage.test.ts`)
                is file-scoped, not scroller-scoped: ANY bare vertical scroller
                anywhere in a file that contains a `TextInput` fails it, since
                the whole point is that a screen doesn't get to reason about
                which of its scrollers is "the one near the input". Matching
                the facet sheet's own container just above keeps the file
                uniform rather than carving out an exception here. */}
            <KeyboardAwareScrollView contentContainerStyle={styles.extrasBody}>
              {/* The chains this athlete captured — moved to the Library by
                  N181 (#586) and moved rather than copied, so there is exactly
                  one entry point to `/sequence` in the app; moved AGAIN here,
                  behind the expand affordance, by N469 (#794).

                  **Three things about the gate, and all three are still
                  load-bearing because this row is now the only way in.**
                  (#414 is the ticket for what happens when a destination is
                  reachable only by having just arrived at it.)

                  1. It reads `techniqueSport`, so it is gated on the technique
                     MODULE and on this server having a technique catalog at
                     all — the same predicate that gates the fetch. A
                     strength-only account has no use for a chain list that
                     can only be empty.
                  2. It deliberately does NOT read `sport`, unlike the
                     position block below it. The sport chip is PERSISTED
                     (`PREF_LIBRARY_SPORT`), so an athlete whose last visit
                     left the filter on Strength would open this screen with
                     the app's only route to their own chains already gone,
                     and nothing on screen saying why.
                  3. It is its own block rather than a row inside the position
                     glossary, because that block additionally requires
                     `positions.length > 0` — a server read. Putting this
                     inside it would make a failed positions fetch silently
                     take the sequences away too. */}
              {techniqueSport !== undefined && (
                <View style={styles.glossary} testID="library-sequences">
                  <Text style={styles.glossaryLabel} accessibilityRole="header">
                    Your own chains
                  </Text>
                  <Pressable
                    onPress={() => {
                      setOpenExtras(false);
                      router.push('/sequence');
                    }}
                    accessibilityRole="button"
                    // A LABEL PLUS A HINT — an `accessibilityLabel` REPLACES
                    // the concatenation of child text, so the hint carries
                    // *and the ones partners sent you*, precisely #414's
                    // audience, the athlete hunting for a chain a partner
                    // shared last week.
                    accessibilityLabel="Your sequences"
                    accessibilityHint="Chains you captured, step by step, and the ones partners sent you"
                    testID="library-sequences-link"
                    style={({ pressed }) => [styles.mapLink, pressed && styles.posCardPressed]}
                  >
                    <Text style={styles.mapLinkTitle}>Your sequences</Text>
                    <Text style={styles.mapLinkNote}>
                      Chains you captured, step by step — and the ones partners sent you.
                    </Text>
                  </Pressable>
                </View>
              )}

              {/* N441 (#728): the guided runner's only entry point on the
                  phone. Read-only here too — `classplans/index.tsx`'s own
                  empty state already says a plan is built on web, so this row
                  is "run one", not "build one". Same gate as the sequences
                  block above and for the same reason. */}
              {techniqueSport !== undefined && (
                <View style={styles.glossary} testID="library-classplans">
                  <Text style={styles.glossaryLabel} accessibilityRole="header">
                    Your class plans
                  </Text>
                  <Pressable
                    onPress={() => {
                      setOpenExtras(false);
                      router.push('/classplans');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Your class plans"
                    accessibilityHint="Pick one to run, built on the web app"
                    testID="library-classplans-link"
                    style={({ pressed }) => [styles.mapLink, pressed && styles.posCardPressed]}
                  >
                    <Text style={styles.mapLinkTitle}>Your class plans</Text>
                    <Text style={styles.mapLinkNote}>
                      Pick one to run — warmup, drilling, rounds, timed block by block.
                    </Text>
                  </Pressable>
                </View>
              )}

              {usesPosition(sport, modules) && positions.length > 0 && (
                <View style={styles.glossary}>
                  <Text style={styles.glossaryLabel} accessibilityRole="header">
                    Start with positions
                  </Text>
                  {/* Above the cards, because it is what to read BEFORE any
                      single position: the glossary says what each place is,
                      the map says how they connect and which way is up. */}
                  <Pressable
                    onPress={() => {
                      setOpenExtras(false);
                      router.push('/bjj/roundmap');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="How a round goes: every position on one map"
                    testID="library-roundmap-link"
                    style={({ pressed }) => [styles.mapLink, pressed && styles.posCardPressed]}
                  >
                    <Text style={styles.mapLinkTitle}>How a round goes</Text>
                    <Text style={styles.mapLinkNote}>
                      Every position on one map, stacked by what it is worth.
                    </Text>
                  </Pressable>
                  {/* N83: build or correct your OWN curriculum, on the phone. */}
                  <Pressable
                    onPress={() => {
                      setOpenExtras(false);
                      router.push('/curriculum');
                    }}
                    style={({ pressed }) => [styles.mapLink, pressed && styles.posCardPressed]}
                    accessibilityRole="button"
                    testID="library-my-curricula"
                  >
                    <Text style={styles.mapLinkTitle}>My curricula</Text>
                    <Text style={styles.mapLinkNote}>
                      Build or edit your own list — techniques, phases, and what
                      mastering each one takes.
                    </Text>
                  </Pressable>
                  {/* Between the map and the positions on purpose. The map is
                      the shape of a round, a syllabus is what a belt owes
                      you, and a position is one place on it — widest first,
                      narrowest last. */}
                  {syllabuses.length > 0 && (
                    <>
                      <Text style={styles.syllabusLabel} accessibilityRole="header">
                        What each belt should know
                      </Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.glossaryRow}
                      >
                        {syllabuses.map((c) => (
                          <Pressable
                            key={c.id}
                            onPress={() => {
                              setOpenExtras(false);
                              router.push(`/curriculum/${c.id}`);
                            }}
                            hitSlop={6}
                            style={({ pressed }) => [
                              styles.syllabusCard,
                              pressed && styles.posCardPressed,
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={`${beltLabel(c)} belt, the whole list, ${c.item_count} entries`}
                            testID={`library-syllabus-${c.id}`}
                          >
                            <Text style={styles.syllabusBelt}>{beltLabel(c)}</Text>
                            <Text style={styles.syllabusCount}>{c.item_count} entries</Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    </>
                  )}
                  <Text style={styles.syllabusLabel} accessibilityRole="header">
                    {syllabuses.length > 0 ? 'Or read one position' : 'Read one position'}
                  </Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.glossaryRow}
                  >
                    {positions.map((p) => {
                      const [code, accent] = positionBadge(p.id);
                      return (
                        <Pressable
                          key={p.id}
                          onPress={() => {
                            setOpenExtras(false);
                            router.push(`/position/${p.id}`);
                          }}
                          hitSlop={6}
                          style={({ pressed }) => [styles.posCard, pressed && styles.posCardPressed]}
                          accessibilityRole="button"
                          accessibilityLabel={`Read about ${p.name}`}
                          testID={`library-glossary-${p.id}`}
                        >
                          <LibraryTile code={code} accent={accent} />
                          <Text style={styles.posCardText} numberOfLines={2}>
                            {p.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              )}
            </KeyboardAwareScrollView>
          </View>
        </View>
      </Modal>
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
          441 ordinary techniques instead of the real 27. */}
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
  // F21 (#497): the boundary the ScreenHeader call site above opts out of —
  // content scrolls under THIS chrome, not under the header, so this is where
  // W10's mechanism actually needed marking. Wraps `styles.controls` AND the
  // two error banners (see the render-side comment), so the rule always sits
  // immediately above whatever is genuinely first in the scroll view, error
  // state or not — a rule pinned to `controls` alone would leave the exact
  // bug this ticket fixes reappearing the moment either error banner shows.
  // Full-bleed rather than inset by `paddingHorizontal`, same reasoning as
  // `ScreenHeader`'s `scrollEdge`: the border draws at the outer edge of the
  // box regardless of the padding inside it, so it marks the edge of the
  // scroll view rather than the edge of the text. `lineBoundary` is the exact
  // same token `ScreenHeader` and the tab bar draw with — F20 (#496) named
  // and documented it precisely so this ticket would read it rather than
  // pick a third value. `paddingBottom` matches `ScreenHeader`'s own `wrap`
  // (10), the established precedent for the gap between fixed chrome and the
  // rule it draws under itself.
  chrome: {
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineBoundary,
  },
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

  // ONE slim, horizontally-scrolling filter row — N469 (#794) — holding both
  // the sport chips and the facet buttons that used to be two separate rows
  // (a wrapping chip row, then a scrolling facet row). Both change what the
  // list shows, which is the one thing that earns a control a spot here.
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 20 },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  // Fill and border set inline, from the accent.
  chipActive: {},
  chipText: { color: vola.textMuted, fontSize: 13, fontWeight: '600' },
  // Ink set inline: what may be written on the accent is the accent's own.
  chipTextActive: {},

  // The facet buttons, sharing the row above with the sport chips.
  facet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  // A set facet is filled, so "something is filtering this list" survives a
  // glance — the state that used to be one highlighted chip in a long row.
  facetActive: { borderColor: vola.textMuted, backgroundColor: vola.surfaceRaised },
  // `textMuted` (7.38:1), not `textDim` (3.96:1 — under AA). Inherited from the
  // `posText` this replaced, where it was one option among a dozen; it is now
  // the resting state of the only control that names the axis. The glossary
  // label in this same file was moved off `textDim` for exactly this.
  facetText: { color: vola.textMuted, fontSize: 12, fontWeight: '600' },
  facetTextActive: { color: vola.text },
  facetCaret: { transform: [{ rotate: '90deg' }] },

  // The one expand affordance for everything that reads rather than filters
  // — deliberately NOT chip-shaped, unlike the row above. A pill next to
  // other pills would read as one more filter; a bordered rectangular row
  // with a leading icon reads as "opens something else", which is the
  // distinction the acceptance criteria asks for between the two rows.
  extrasRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  extrasRowText: { color: vola.textMuted, fontSize: 13, fontWeight: '600' },
  // The extras sheet body. Horizontal padding lives here rather than on each
  // section, because inside the sheet nothing else provides it — the fixed
  // header's `styles.controls` supplied it before this content moved out.
  extrasBody: { paddingHorizontal: 20, paddingBottom: 24 },

  // Dims the list behind without hiding it — you can still see what you are
  // filtering, which is the point of not taking the whole screen.
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(4,6,10,0.62)',
  },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    // Same translucency, radius and lit edge as the rank card's glass. It only
    // reads as glass if some of what is behind shows through, so the fill is
    // deliberately not opaque.
    // 0.93, not the rank card's 0.72. That card sits on a flat ground with
    // nothing behind it to read through; this one sits over a dense list of
    // exercise names, and at 0.86 they showed through the option labels
    // clearly enough to fight them. "A little transparent" is the brief —
    // enough to see what you are filtering, not enough to read it.
    backgroundColor: 'rgba(23,30,43,0.93)',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.07)',
    // Capped so the sheet cannot grow past the display: Movement has eleven
    // options and already fills most of it, and at a larger text size it would
    // push its own title off the top. The inner ScrollView takes over instead
    // of the sheet getting taller.
    maxHeight: '80%',
    overflow: 'hidden',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginTop: 8,
    marginBottom: 4,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  sheetTitle: { fontSize: 16, fontWeight: '800' },
  sheetClose: { fontSize: 14, fontWeight: '700', color: vola.lime },
  sheetBody: { paddingVertical: 4 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    // 46pt tall, over the 44 the HIG asks — this is a list of targets, which
    // is where an undersized row is felt most.
    paddingVertical: 14,
  },
  optionPressed: { backgroundColor: 'rgba(255,255,255,0.05)' },
  optionText: { fontSize: 15, color: vola.textMuted },
  optionTextOn: { color: vola.text, fontWeight: '700' },

  // The glossary row. A hairline above it, because this is where the header
  // stops being controls and starts being content.
  glossary: {
    gap: 9,
    paddingTop: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.lineSoft,
  },
  // textMuted, not textDim, and 11px rather than 10. This label is the only
  // thing telling a reader that the cards below it open a page while the chips
  // above narrow a list, and at textDim/10px it measured 3.96:1 on `bg` —
  // under AA, and a step smaller than the chips it has to distinguish itself
  // from. textMuted is 7.19:1 and still reads as secondary.
  // Uppercased by style, not by typing it in caps — the caps are the look, and
  // a screen reader should still be handed the words. `apps/web`'s `.eyebrow`
  // does the same with `text-transform`, so both clients now announce the same
  // accessible name rather than one of them spelling it out.
  syllabusBelt: { color: vola.text, fontSize: 15, fontWeight: '700' },
  syllabusCard: {
    borderColor: vola.line,
    borderRadius: 12,
    borderWidth: 1,
    gap: 2,
    minWidth: 104,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  syllabusCount: { color: vola.textMuted, fontSize: 12 },
  syllabusLabel: {
    color: vola.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  mapLink: {
    borderColor: vola.line,
    borderRadius: 12,
    borderWidth: 1,
    gap: 2,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mapLinkNote: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },
  mapLinkTitle: { color: vola.text, fontSize: 14, fontWeight: '700' },
  glossaryLabel: {
    color: vola.textMuted,
    fontSize: 11,
    letterSpacing: 1,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  glossaryRow: { gap: 10, paddingRight: 20 },
  // Fixed width so the names wrap to a predictable two lines and the cards
  // form an even row — "Knee on Belly" and "Mount" cannot share an intrinsic
  // width without one of them looking broken.
  posCard: { width: 92, gap: 7 },
  posCardPressed: { opacity: 0.6 },
  posCardText: { color: vola.text, fontSize: 12, fontWeight: '600', lineHeight: 16 },

  error: { color: vola.danger, fontSize: 13, paddingHorizontal: 20, paddingTop: 10 },
  loader: { marginTop: 32 },

  list: { paddingHorizontal: 20, paddingTop: 14 },
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
