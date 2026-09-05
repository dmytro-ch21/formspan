import { useAuth } from '@clerk/clerk-expo';
import { request as requestSync } from '@/lib/sync';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput } from 'react-native';

import {
  KeyboardAwareScreen,
  KeyboardAwareScrollView,
  useEnsureVisible,
} from '@/components/KeyboardAwareScroll';
import { SwipeToDelete } from '@/components/SwipeToDelete';

import { useCountdown } from '@/components/Countdown';
import { TIMER_BAR_SPACE, TimerSurface } from '@/components/Timer';
import { HoldToConfirm } from '@/components/HoldToConfirm';
import { HRSessionReport } from '@/components/HRSessionReport';
import { SessionCelebration } from '@/components/SessionCelebration';
import { ShareCardHost, ShareSessionButton, useSessionShare } from '@/components/SessionShare';
import { getSessionMetrics, type SessionMetrics } from '@/lib/biometric';
import {
  recordsFromSession,
  summariseSession,
  worthCelebrating,
  type SessionRecord,
  type SessionSummary,
} from '@/lib/celebration';
import { fetchRecords } from '@/lib/records';
import { carriedTheStreak, fetchHistory, localZone, streakRange, weekStreak } from '@/lib/history';
import { milestoneForSession, type Milestone } from '@/lib/milestones';
import { elapsedOf } from '@/lib/countdown';
import {
  adjustStepFor,
  defaultDurationUnit,
  durationInputUnit,
  durationUnitKey,
  fromDisplayDuration,
  timerTargetEdit,
  parseDurationUnit,
  toDisplayDuration,
  type DurationUnit,
} from '@/lib/duration';
import {
  groupModeOf,
  isDualMode,
  measuresForSet,
  setModeOf,
  withGroupMode,
  type SetMode,
} from '@/lib/setMode';
import {
  buildExerciseRun,
  buildSessionRun,
  canRun,
  runSeconds,
  type RunContext,
} from '@/lib/intervalRun';
import {
  readPref,
  writePref,
  PREF_SUGGESTIONS,
  PREF_SUGGESTIONS_OFF,
} from '@/lib/prefs';
import { parseMaster, parseIdSet, suggestionsAllowed } from '@/lib/suggestion';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { CardGlass } from '@/components/ui/CardGlass';
import { Stat, StatRow } from '@/components/ui/Stat';
import { useAuthToken } from '@/lib/useAuthToken';
import { vola } from '@/constants/Colors';
import { Radius, Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import { useAccent } from '@/lib/AccentProvider';
import { formatElapsed, readAutoRest, readRestSeconds, writeRestSeconds } from '@/lib/rest';
import {
  distanceInputUnit,
  formatEstimate,
  formatVolume,
  formatWeight,
  fromDisplayDistance,
  fromDisplayWeight,
  toDisplayDistance,
  toDisplayWeight,
  weightUnit,
  weightUnitName,
  type UnitSystem,
} from '@/lib/units';
import { useUnits } from '@/lib/useUnits';
import { getExerciseUnits, setExerciseUnit } from '@/lib/profile';
import { useTrackEffort } from '@/lib/useTrackEffort';
import { fetchExercises, type Exercise } from '@/lib/exercises';
import {
  cacheExercises,
  cachedExercises,
  cachedWorkouts,
  deleteLocalSession,
  finishLocalSession,
  hydrateSession,
  readLocalSession,
  pushSession,
  saveLocalSets,
} from '@/lib/sessionStore';
import { ApiError, isPermanentRejection } from '@/lib/apiError';
import * as Haptics from 'expo-haptics';
import { report } from '@/lib/report';
import {
  describeSet,
  emptyDropSet,
  emptySet,
  groupSets,
  setOrdinals,
  localVolume,
  hasUnresolvedLoad,
  isPastLocalDay,
  soloReps,
  withSetChange,
  fetchSuggestions,
  pendingSuggestableIndices,
  fillForward,
  measuresFor,
  reorderGroups,
  timedSetStillAt,
  elapsedBelongsInSeconds,
  offersTimerTarget,
  DEFAULT_TIMER_SECONDS,
  workSecondsFor,
  offeredGrips,
  SET_TYPES,
  type LoggedSet,
  type Measure,
  type Grip,
  type Session,
  type SetType,
  type Suggestion,
  type SuggestionCode,
  type Volume,
} from '@/lib/sessions';
import { finishTimestampFor } from '@/lib/calendar';
import { OptionSelect } from '@/components/ui/OptionSelect';
import { gripGuide, setTypeGuide } from '@/lib/setGuide';
import { getWorkout } from '@/lib/workouts';

/**
 * Attaches the real exercise name to each record, from the catalog already
 * loaded for this screen (N447/#745).
 *
 * A plain `.map` rather than something threaded into the fetch effects that
 * built `records` in the first place: `catalog` arrives on its own schedule
 * (cache first, then the network) and can update AFTER a records effect has
 * already run, so resolving names inside those effects would read whatever
 * `catalog` closed over at fetch time and could silently miss a name that
 * had, by the time of rendering, already arrived. Doing it here instead — at
 * render, alongside the other "merged at render" record-shaping below — means
 * a late-arriving catalog is picked up on the very next render for free.
 *
 * `null`, not the raw id, when the catalog has nothing: `SessionRecord`'s own
 * doc explains why, and `prBadgeFor` treats it as "no caption" rather than a
 * name.
 */
function withExerciseNames(
  records: SessionRecord[],
  catalog: Map<string, Exercise>,
): SessionRecord[] {
  return records.map((r) => ({
    ...r,
    exerciseName: catalog.get(r.exerciseID)?.name ?? null,
  }));
}

/**
 * Logging a session, on the phone, mid-workout.
 *
 * The whole screen is designed around one number: taps per set. Someone
 * between sets has one hand, ~20 seconds, and no patience — so the previous
 * set's weight and reps are carried forward and "+ Set" is a single tap that
 * repeats them. The common case is confirming, not typing.
 *
 * Effort (RIR/RPE) is deliberately *not* carried forward: the third set at
 * the same weight is not the same effort as the first, and prefilling it
 * would invite recording a number nobody actually judged.
 */
export default function SessionScreen() {
  const accent = useAccent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  /**
   * N435 — a finished session is a record by DEFAULT, correctable on purpose.
   *
   * "Correct this session" flips this on; "Done editing" flips it back off.
   * Local and un-persisted on purpose: it is a mode of looking at the screen,
   * not a fact about the session, so it starts false on every fresh open —
   * the just-reopened record is read-only until asked otherwise, same as it
   * always was. See `sessionEditable` below for what it actually unlocks.
   */
  const [editingFinished, setEditingFinished] = useState(false);
  // The sets are held locally rather than read off `session`, because the
  // server's copy arrives asynchronously and would otherwise overwrite
  // whatever's being typed at the moment a save lands.
  const [sets, setSets] = useState<LoggedSet[]>([]);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [suggestions, setSuggestions] = useState<Map<string, Suggestion>>(new Map());
  /**
   * N473/#812 (item 9) — the strength-suggestion preference
   * (`/settings/suggestions`) silenced Today's suggestions but never this
   * screen's, so turning "strength" off there left the mid-session hint and
   * its "Use" button showing anyway. Read on FOCUS, not once per mount, for
   * the exact reason `readSuggestionPrefs` in `app/(tabs)/index.tsx` does:
   * Settings is a Stack route pushed OVER this screen, which stays mounted
   * underneath it, so a mount-only read never sees a change made there.
   *
   * `null` until read, same as Today's own `policy` state and for the same
   * reason (found in review, N473/#812): starting optimistically at
   * "allowed" showed the hint for a frame or two on returning from Settings
   * after switching it off, while the real SQLite read was still in flight —
   * Today's own comment on this exact state calls that "the setting not
   * working". A FAILED read still falls back to allowed (see the `.catch`
   * below) — a suggestions feature that silently disables itself on a read
   * failure is a worse outcome than one that occasionally shows what a
   * settings toggle would have hidden; the gap this closes is specifically
   * the window before any read (success or failure) has resolved at all.
   */
  const [suggestionPrefs, setSuggestionPrefs] = useState<{
    master: boolean;
    off: ReadonlySet<string>;
  } | null>(null);
  // The workout's goal, resolved once. Immutable for the life of a session,
  // and `load` re-runs on every focus.
  const goalRef = useRef<{ workoutID: string | null; goal: string | null }>({
    workoutID: null,
    goal: null,
  });
  /**
   * A work countdown reaching zero is a set that happened, so it logs itself.
   *
   * Only `work` does anything here — a rest running out has produced no number
   * for the session to keep, which is the whole difference between the two.
   * The hook holds this in a ref, so this closure is the current render's and
   * sees the current `sets`.
   */
  const timerState = useCountdown(
    (finished, elapsed) => {
      if (finished.kind !== 'work' || finished.setIndex == null || !finished.exerciseID) return;
      // `elapsed`, not `total`. A countdown that ran out reports its full length,
      // so the ordinary case is unchanged; one ended deliberately early — "Done
      // early" mid-plank — reports the seconds that actually happened. Logging
      // the prescription there would put a number in the history nobody
      // performed, which is the whole reason the hook hands this over.
      recordTimedSet(finished.setIndex, finished.exerciseID, elapsed, true);
    },
    () => {
      // A run that reached its own end. The session is not over — there may be
      // untimed work left — so this only says the run is, and the celebration
      // still belongs to Finish.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
  );
  // The switch in Settings writes this; reading the same hook is what makes
  // the two agree. An earlier version imported the hook and never called it,
  // leaving a useState(true) nothing ever updated — so the setting silently
  // did nothing while the commit claimed it worked.
  const { trackEffort: showEffort } = useTrackEffort();

  /**
   * How long you've been training. Derived from started_at on every tick
   * rather than accumulated, for the same reason the rest timer is: a
   * counter stops when the JS thread is throttled, and a session spends most
   * of its life with the phone in a pocket.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!session) return;
    const from = new Date(session.started_at).getTime();
    const to = session.ended_at ? new Date(session.ended_at).getTime() : null;
    const tick = () => setElapsed(((to ?? Date.now()) - from) / 1000);
    tick();
    // A finished session's duration is fixed, so there's nothing to tick.
    if (to !== null) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [session]);

  /**
   * A finished session is a record, so no countdown may outlive it.
   *
   * Hiding the bar would not be enough: the interval keeps running behind it,
   * and a work countdown reaching zero WRITES — `seconds` onto a set, plus the
   * tick. That would land in a session the screen has already declared
   * read-only, and the sync would push it, logging a full 60-second plank for
   * a hold the athlete cut short precisely BY finishing.
   *
   * Keyed on the timestamp rather than the derived `finished` flag, because
   * that flag is computed below the early returns where a hook cannot go.
   */
  const stopTimer = timerState.stop;
  useEffect(() => {
    if (session?.ended_at) stopTimer();
  }, [session?.ended_at, stopTimer]);

  const { units, unitsReady } = useUnits();
  // Per-exercise overrides: a lifter who thinks in kilograms still faces a
  // leg press marked in pounds, and converting in your head at the moment
  // you're trying to record a number is exactly what this avoids.
  const [exerciseUnits, setExerciseUnits] = useState<Record<string, UnitSystem>>({});
  // Off unless asked for — see PREF_AUTO_REST for why that's the default.
  /**
   * The finished-session card, or null.
   *
   * Held as the summary itself rather than a boolean, so the card renders from
   * a plain data object and nothing else — the same object a share image would
   * be built from later.
   */
  const [celebrating, setCelebrating] = useState<SessionSummary | null>(null);
  /**
   * The records, held apart from the summary they end up on.
   *
   * **This separation is the fix for an infinite refetch, not tidiness.** The
   * first version wrote the records back into `celebrating`, which is the
   * effect's own dependency — so every fill produced a new object, re-triggered
   * the effect, fetched again, and produced another. The guard meant to stop it
   * was inverted: it bailed out when the session set NO records, so the loop
   * ran precisely in the case the feature exists for, one request per
   * round-trip for as long as the card stayed open, with nothing visibly wrong.
   *
   * Writing to state the effect does not depend on cannot do that.
   */
  const [celebrationRecords, setCelebrationRecords] = useState<SessionRecord[]>([]);
  /*
    Whether the records lookup has finished, either way.

    The streak chime waits on this. Both lookups race, and if the streak landed
    first it would chime and then latch the PR chime out — backwards, because a
    personal record is the bigger moment. Gating on "records are known" makes
    the precedence a property instead of a timing accident, and it is a
    separate flag from the array because an EMPTY result is an answer while a
    pending one is not.
  */
  const [recordsSettled, setRecordsSettled] = useState(false);
  /**
   * Whether the HISTORY lookup has finished — the mirror of `recordsSettled`,
   * and the thing that makes the milestone actually outrank a personal record.
   *
   * The two lookups are deliberately parallel, so "milestone beats record" is
   * only true within a single commit; across two independent fetches it is a
   * race, and the records call is the likelier to win it (a lookup by exercise
   * id against a rollup of 371 days). Whichever effect fires first claims the
   * shared chime latch, so without this the PR chime latched on ARRIVAL and the
   * rarer event was silenced by the commoner one — precisely the failure
   * `recordsSettled` already exists to prevent one rung further down. Found in
   * review.
   */
  const [streakSettled, setStreakSettled] = useState(false);
  /** `null` until history answers; `carried` is what decides the chime. */
  const [celebrationStreak, setCelebrationStreak] = useState<{
    weeks: number;
    carried: boolean;
  } | null>(null);
  /**
   * A streak rung this session crossed, or null — almost always null.
   *
   * Its own state rather than derived from `celebrationStreak.weeks`, because
   * the milestone is about the SESSION, not the week: `milestoneForSession`
   * needs `carriedTheStreak` as well, and a rung reached earlier in the week by
   * a different session must not re-fire on this one.
   */
  const [celebrationMilestone, setCelebrationMilestone] = useState<Milestone | null>(null);

  /**
   * Personal records arrive after the card does, if at all.
   *
   * Records live on the server and finishing is offline-first, so the card
   * must not wait for the network to appear — it opens immediately with the
   * numbers the phone already has, and the PR row fills in when the answer
   * comes back. Offline it simply never does, which is the honest outcome:
   * silence is not a claim, a guessed medal would be.
   */
  useEffect(() => {
    if (!celebrating || !id) return;
    let live = true;
    fetchRecords(getToken, celebrating.recordExerciseIDs)
      .then((all) => {
        if (live) setCelebrationRecords(recordsFromSession(all, id));
      })
      .catch(() => {
        // No network, no PR row. Deliberately silent — a failed lookup is not
        // an error the athlete needs to hear about on a celebration screen.
      })
      .finally(() => {
        // `finally`, so a failure still settles: offline the answer is "no
        // records", and the streak chime must not wait forever for a lookup
        // that is never coming back.
        if (live) setRecordsSettled(true);
      });
    return () => {
      live = false;
    };
  }, [celebrating, getToken, id]);

  /*
    The weekly streak, fetched the same way and for the same reason as the
    records above: the card opens on what the phone already knows and this
    fills in behind it. Its own effect rather than chained onto the records
    one, so a slow history cannot hold up the PR row.
  */
  useEffect(() => {
    if (!celebrating) return;
    let live = true;
    const { from, to } = streakRange();
    fetchHistory(getToken, { from, to, tz: localZone() })
      .then((h) => {
        if (!live) return;
        const carried = carriedTheStreak(h.days);
        setCelebrationStreak({ weeks: weekStreak(h.days), carried });
        // Same history, same pass — so the card can never show a milestone
        // whose streak line disagrees with it.
        setCelebrationMilestone(milestoneForSession(h.days, carried));
      })
      .catch(() => {
        // Same silence as the records lookup. No history, no streak line, no
        // chime — the phone cannot know what the week holds.
      })
      .finally(() => {
        // `finally` for the same reason the records lookup has one, now load
        // bearing in the other direction: offline the answer is "no milestone",
        // and the PR chime must not wait forever for a history that is never
        // coming back.
        if (live) setStreakSettled(true);
      });
    return () => {
      live = false;
    };
  }, [celebrating, getToken]);

  /*
    Sharing a session that finished at some point in the past — which, after
    the celebration modal is dismissed, is every session.

    The card was reachable for exactly as long as that modal was open: close
    it and the session could never be shared again. So a finished session now
    carries the same card permanently, built from the same `summariseSession`
    the celebration uses, so the two can never disagree about one workout.

    Everything here is above the early returns because these are hooks, and
    that is why `useSessionShare` takes a nullable summary: a live session has
    nothing to share, but it must still make the call.
  */
  const readBackSummary =
    session?.ended_at && volume ? summariseSession(session, volume, showEffort) : null;

  /*
    The PRs this session set, fetched again for the read-back card.

    Without them a session shared the day after it happened loses its medal
    and its headline drops from "NEW BEST." to a generic line — the same
    session, told two different ways depending on when you tapped Share.

    Keyed on a STRING, never the id array: `summariseSession` builds a fresh
    array every render, so an array dependency here would re-fetch forever.
    That exact loop already shipped once on the celebration's own records
    effect — see `celebrationRecords` above.

    Note this stays honest over time rather than freezing a claim: a PR that
    has since been beaten is no longer returned for this session, so the medal
    correctly disappears.
  */
  const [readBackRecords, setReadBackRecords] = useState<SessionRecord[]>([]);
  const readBackExerciseKey = readBackSummary?.recordExerciseIDs.join(',') ?? '';
  useEffect(() => {
    if (!id || !readBackExerciseKey) return;
    let live = true;
    fetchRecords(getToken, readBackExerciseKey.split(','))
      .then((all) => {
        if (live) setReadBackRecords(recordsFromSession(all, id));
      })
      .catch(() => {
        // Offline, a shared card simply carries no medal. Silence is the
        // honest answer — a guessed one would be a claim.
      });
    return () => {
      live = false;
    };
  }, [id, getToken, readBackExerciseKey]);

  const sessionShare = useSessionShare({
    // Undefined while the session is live, which is what hides the button.
    sessionID: readBackSummary ? id : undefined,
    summary: readBackSummary
      ? { ...readBackSummary, records: withExerciseNames(readBackRecords, catalog) }
      : null,
    formatTonnage: (v) => formatVolume(v, units),
    formatWeight: (v) => formatWeight(v, units),
    // The session's own date, not today's. Without this, a workout shared a
    // week later posts stamped with the day it was shared.
    date: session?.ended_at ? new Date(session.ended_at) : undefined,
  });

  const [autoRest, setAutoRest] = useState(false);
  useEffect(() => {
    if (userId) readAutoRest(userId).then(setAutoRest).catch(() => {});
  }, [userId]);
  useEffect(() => {
    getExerciseUnits(getToken).then(setExerciseUnits).catch(() => {});
  }, [getToken]);
  const unitFor = useCallback(
    (exerciseID: string): UnitSystem => exerciseUnits[exerciseID] ?? units,
    [exerciseUnits, units],
  );
  const toggleUnitFor = useCallback(
    (exerciseID: string) => {
      const next: UnitSystem = unitFor(exerciseID) === 'metric' ? 'imperial' : 'metric';
      // Cleared rather than stored when it matches the default, so the map
      // only ever holds genuine exceptions.
      const override = next === units ? null : next;
      setExerciseUnits((m) => {
        const copy = { ...m };
        if (override) copy[exerciseID] = override;
        else delete copy[exerciseID];
        return copy;
      });
      setExerciseUnit(getToken, exerciseID, override).catch(() => {});
    },
    [getToken, unitFor, units],
  );

  /**
   * Seconds or minutes, per exercise — the duration counterpart of kg/lb above.
   *
   * Holds **only genuine overrides**, which is why the read parses to null
   * rather than to a default: an exercise with no entry falls through to the
   * scale its own prescription implies, so a 4-minute round opens in minutes and
   * a 45-second plank opens in seconds without anybody having chosen anything.
   * Storing a default would freeze the first guess and make the map lie about
   * what the athlete actually asked for.
   *
   * Local (`prefs`) rather than on the profile, unlike the weight unit — see
   * `lib/duration.ts` for why the two differ.
   */
  const [durationUnits, setDurationUnits] = useState<Record<string, DurationUnit>>({});
  const durationFor = useCallback(
    (exerciseID: string, seconds?: number | null): DurationUnit =>
      durationUnits[exerciseID] ?? defaultDurationUnit(seconds),
    [durationUnits],
  );
  const toggleDurationFor = useCallback(
    (exerciseID: string, current: DurationUnit) => {
      const next: DurationUnit = current === 'minutes' ? 'seconds' : 'minutes';
      setDurationUnits((m) => ({ ...m, [exerciseID]: next }));
      if (userId) writePref(userId, durationUnitKey(exerciseID), next).catch(() => {});
    },
    [userId],
  );
  /*
    Keyed on the SET OF EXERCISE IDS rather than on `sets`.

    `sets` changes on every keystroke, so depending on it would re-read every
    preference from SQLite while somebody types a weight. The ids only change
    when an exercise is added, removed or swapped, which is exactly when a new
    preference might need reading — and the sorted join makes reordering a
    no-op, because moving an exercise does not change which ones are here.
  */
  const exerciseKey = [...new Set(sets.map((s) => s.exercise_id))].sort().join(',');
  useEffect(() => {
    if (!userId || !exerciseKey) return;
    let live = true;
    Promise.all(
      exerciseKey.split(',').map(async (eid) => {
        return [eid, parseDurationUnit(await readPref(userId, durationUnitKey(eid)))] as const;
      }),
    )
      .then((pairs) => {
        if (!live) return;
        const next: Record<string, DurationUnit> = {};
        for (const [eid, unit] of pairs) if (unit) next[eid] = unit;
        setDurationUnits(next);
      })
      .catch(() => {
        // Unreadable preferences leave the prescription-derived defaults.
      });
    return () => {
      live = false;
    };
  }, [userId, exerciseKey]);
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const queued = useRef<LoggedSet[] | null>(null);

  /**
   * Refreshes the progression suggestions shown next to each exercise.
   *
   * Extracted out of `load` so `toggleDone` can call it too — see N191. The
   * standing prescription (code/reason/target) stays history-only, but this
   * request also carries whatever of THIS session's own working sets are
   * already logged, so the server can flag when today's own numbers
   * disagree with it — see `fetchSuggestions`'s doc comment.
   *
   * `currentSets` is a parameter rather than read off `sets` state so a
   * caller mid-commit (`toggleDone`, which updates state and then calls this)
   * hands over the sets it just committed, not a stale render's.
   */
  const refreshSuggestions = useCallback(
    async (sport: string, workoutID: string | null, currentSets: LoggedSet[]) => {
      if (!userId) return;
      let goal: string | null = null;
      if (workoutID) {
        // Resolved once per session, not once per call. `load` runs under
        // useFocusEffect, so it re-fires every time you come back from the
        // exercise picker or the rest timer — and a workout's goal cannot
        // change mid-session, so re-fetching it is pure waste.
        //
        // The cache is consulted first and is usually enough: the plan is
        // already on the phone, and since schema v6 it carries the goal.
        // That also makes this work with no signal at all, where the
        // network path would silently fall back to the general rep range.
        if (goalRef.current.workoutID === workoutID) {
          goal = goalRef.current.goal;
        } else {
          const local = (await cachedWorkouts(userId, sport).catch(() => []))
            .find((w) => w.id === workoutID);
          // Advisory: a template deleted since must not stop the
          // suggestions appearing, it just costs the narrower range.
          goal =
            local?.goal ??
            (await getWorkout(getToken, workoutID)
              .then((w) => w.goal)
              .catch(() => null));
          goalRef.current = { workoutID, goal };
        }
      }
      setSuggestions(
        await fetchSuggestions(
          getToken,
          currentSets.map((x) => x.exercise_id),
          goal,
          currentSets,
          undefined,
          // N473/#812 item 8 — the one global unit preference, not
          // per-exercise `unitFor`; see fetchSuggestions's own doc comment
          // for why one value per request is the deliberate simplification.
          units,
        ),
      );
    },
    [getToken, userId, units],
  );

  // Local first, always. The network can only ever *add* to what's on
  // screen — it is never the thing the screen waits for.
  const load = useCallback(async () => {
    if (!id || !userId) return;
    try {
      let s = await readLocalSession(userId, id);
      if (!s) {
        // Never seen on this device — started on the web, say. Needs the
        // network, and offline there is genuinely nothing to show.
        s = await hydrateSession(userId, id, getToken);
      }
      if (!s) {
        setError('This session isn\'t on this device, and it can\'t be reached right now.');
        setEverLoaded(true);
        return;
      }
      setSession(s);
      setSets(s.sets);
      setVolume(localVolume(s.sets));
      setError(null);
      setEverLoaded(true);

      // The cache renders the screen; the fetch refreshes the cache for
      // next time. Offline, the first half still works.
      const cached = await cachedExercises(s.sport);
      if (cached.length > 0) setCatalog(new Map(cached.map((e) => [e.id, e])));
      fetchExercises(getToken, { sport: s.sport })
        .then((list) => {
          setCatalog(new Map(list.map((e) => [e.id, e])));
          return cacheExercises(list);
        })
        .catch(() => {});

      // Advice, not content — it simply doesn't appear offline.
      refreshSuggestions(s.sport, s.workout_id, s.sets).catch(() => {});

      // Tell the orchestrator something may have changed; it decides whether
      // that warrants a run. This used to be a fire-and-forget sync on every
      // focus, which is one of seven places that each guessed at a good
      // moment — see lib/sync.ts.
      requestSync('session-focus');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEverLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [getToken, id, userId, refreshSuggestions]);

  // Runs on mount and again on every return from the exercise picker, which
  // appends its set server-side — without this the new set wouldn't appear.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // See suggestionPrefs's own doc comment above for why this is read on
  // focus rather than once per mount.
  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      let alive = true;
      Promise.all([readPref(userId, PREF_SUGGESTIONS), readPref(userId, PREF_SUGGESTIONS_OFF)])
        .then(([m, o]) => {
          if (alive) setSuggestionPrefs({ master: parseMaster(m), off: parseIdSet(o) });
        })
        .catch(() => {
          if (alive) setSuggestionPrefs({ master: true, off: new Set() });
        });
      return () => {
        alive = false;
      };
    }, [userId]),
  );

  // Everything writes through — there is no Save button. A Save button in a
  // gym is a way to lose a session: you put the phone down, pick up a bar,
  // and the app gets killed with the last three sets only in memory.
  //
  // The response updates the summary but never the sets: replacing them
  // mid-keystroke would fight whoever is typing.
  // Saves are chained rather than fired in parallel. Two overlapping PUTs of
  // the whole set list have no ordering guarantee, so the older one landing
  // second would leave the server holding the older list while the screen
  // shows the newer one — a lost update with nothing left to reconcile it.
  const inFlight = useRef<Promise<unknown>>(Promise.resolve());

  // The local write is the save. The push is an attempt, and failing it is
  // an ordinary state — not an error worth interrupting a workout for.
  const persist = useCallback(
    (next: LoggedSet[]) => {
      if (!id || !userId) return Promise.resolve();
      const run = inFlight.current.then(async () => {
        setSaving(true);
        try {
          // The local write *is* the save, so its failure is never quiet.
          // The screen is already showing these sets; if SQLite didn't take
          // them, the athlete is looking at work that doesn't exist
          // anywhere, and the only honest thing to do is say so.
          try {
            await saveLocalSets(userId, id, next);
          } catch (err) {
            setError(
              `Couldn't save on this device: ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
          }
          setVolume(localVolume(next));
          setError(null);

          try {
            // Only this session, not a full reconciliation. Pushing every
            // dirty session and pulling twenty more on each keystroke is
            // what turned one workout into hundreds of requests.
            await pushSession(userId, id, getToken);
          } catch (err) {
            // A push that failed because the network did is an ordinary
            // state: the row stays dirty and goes out with the next sync.
            // A push the server actively *refused* will fail the same way
            // forever, and staying quiet about that means finishing a
            // workout that was never going to sync.
            if (isPermanentRejection(err)) {
              const detail = err instanceof Error ? err.message : String(err);
              setError(detail);
              // Tell the server, because it will never find out otherwise: the
              // request that would carry this session is not going to be made
              // again, so every API-side metric stays green while the training
              // sits on this phone. The athlete sees the message above; this
              // is what puts it in front of an operator.
              report(getToken, 'sync_blocked', detail, {
                session_id: id,
                error_code: err instanceof ApiError ? err.code : 'unknown',
                status: err instanceof ApiError ? err.status : null,
              });
            }
          }
        } finally {
          setSaving(false);
        }
      });
      inFlight.current = run.catch(() => {});
      return run;
    },
    [getToken, id, userId],
  );

  // Typing a weight is several keystrokes; one PUT each would be a request
  // per character. Edits coalesce, structural changes (add/remove) go
  // immediately.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = queued.current;
    queued.current = null;
    if (next) await persist(next);
    // Awaited even with nothing queued: a save may already be flying, and
    // callers flush precisely because they're about to read the session back.
    await inFlight.current;
  }, [persist]);

  const persistSoon = useCallback(
    (next: LoggedSet[]) => {
      queued.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  // Leaving the screen must not drop the last edit.
  useEffect(() => () => void flush(), [flush]);

  // HR report (N488/#849) — best-effort and non-blocking, same shape as the
  // BJJ screen's own read (`bjj/session/[id].tsx`). A session that never
  // ended has no window to have computed metrics from, so this doesn't even
  // ask; a finished one may still have nothing (no wearable, offline, or the
  // watch hasn't synced yet — normal per design doc §6.4). `hrLoaded` is kept
  // separate from `hrMetrics` because `null` means both "haven't asked yet"
  // and "asked, and there is genuinely nothing" — see the BJJ screen's own
  // comment on this exact distinction.
  const [hrMetrics, setHrMetrics] = useState<SessionMetrics | null>(null);
  const [hrLoaded, setHrLoaded] = useState(false);
  useEffect(() => {
    if (!id || !session?.ended_at) return;
    let cancelled = false;
    getSessionMetrics(getToken, id)
      .then((m) => {
        if (!cancelled) {
          setHrMetrics(m);
          setHrLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHrMetrics(null);
          setHrLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, session?.ended_at, getToken]);

  /**
   * Open the exercise picker, having settled pending writes.
   *
   * Both entry points already did this; `openPicker` only puts the flush in
   * one place instead of two. **It is not the fix for the lost-add report** —
   * an earlier version of this comment claimed it was, on the strength of a
   * stale-debounce theory that `main` disproves: the Add button had `await
   * flush()` too, so nothing about the ordering changed. The real mechanism
   * was a check-then-act in the sync pull, and it is fixed in
   * `lib/sessionStore.ts` with the wrong diagnosis recorded beside it.
   *
   * The flush still earns its place: the picker reads the session back out of
   * SQLite, so an edit sitting in the debounce would be invisible to it.
   */
  async function openPicker(href: Parameters<typeof router.push>[0]) {
    await flush();
    router.push(href);
  }

  function update(index: number, next: LoggedSet) {
    const updated = sets.map((s, i) => (i === index ? next : s));
    setSets(updated);
    persistSoon(updated);
  }


  // Inserted directly after the group it belongs to, not appended to the end
  // of the session. Groups are formed by adjacency, so appending put the new
  // set in a second group of the same exercise at the very bottom of the
  // screen — from the top it looked like the tap had done nothing at all,
  // even as the volume summary counted it.
  // Adding, removing, or applying a recommendation is a structural change: it
  // goes now, not on the debounce.
  function commit(updated: LoggedSet[]) {
    setSets(updated);
    queued.current = updated;
    void flush();
  }

  function addSet(exerciseID: string, afterIndex: number) {
    // This INSERTS mid-array, so every later index shifts — which makes it a
    // structural change exactly like removal and reordering, and it was the one
    // mutator not saying so. Found in review. A countdown running on a later
    // group would then write one row above its target, and when that row is the
    // same exercise (set 2 of a plank with set 1 above it) `timedSetStillAt`
    // passes and the wrong-row write is silent. "+ Set" during a run's rest step
    // is an ordinary thing to do: the bar is minimised and the list is live.
    stopTimerForStructureChange();
    commit(
      [
        ...sets.slice(0, afterIndex + 1),
        emptySet(exerciseID, afterIndex + 1, sets[afterIndex]),
        ...sets.slice(afterIndex + 1),
      ].map((s, i) => ({ ...s, position: i })),
    );
  }

  /**
   * A drop off the LAST set of this exercise — strip the weight, keep going.
   *
   * Inserted immediately after its parent, because that adjacency IS the
   * relationship: there is no id linking a drop to the set it came off, and
   * there cannot be one while the server replaces every row on save. Anything
   * that moves this row away from its parent re-parents it, which is why the
   * only way to make one is here, attached to a specific set.
   *
   * Same structural change as `addSet` — every later index shifts — so it stops
   * a running timer for the same reason.
   *
   * Takes only the index: the exercise comes from the parent set, because a
   * drop is defined by the set it hangs off rather than by an exercise chosen
   * separately. Passing both would let the two disagree.
   */
  function addDropSet(afterIndex: number) {
    stopTimerForStructureChange();
    commit(
      [
        ...sets.slice(0, afterIndex + 1),
        emptyDropSet(sets[afterIndex], afterIndex + 1),
        ...sets.slice(afterIndex + 1),
      ].map((s, i) => ({ ...s, position: i })),
    );
  }

  /**
   * Ticking a set records that it happened — and nothing else.
   *
   * Whether it also starts the rest countdown is the athlete's call, not
   * ours: for some people ticking *is* the moment they rack the bar, and for
   * others it happens late or for a set they finished five minutes ago. We
   * guessed wrong in both directions before making it a setting, so now it's
   * "Auto rest timer" — off by default, because a countdown that starts
   * itself is one you spend attention cancelling.
   *
   * Un-ticking never starts rest, and stays possible: mis-taps happen
   * mid-set, and an un-undoable checkbox is worse than none.
   */
  function toggleDone(index: number, exerciseID: string) {
    const now = !sets[index].completed;
    const marked = sets.map((s, i) => (i === index ? { ...s, completed: now } : s));
    // Marking done is the moment the numbers are final — and it is a tap the
    // athlete already makes, so prefill costs no new interaction. Un-ticking
    // fills nothing: that is a correction, not a confirmation.
    //
    // One commit, not two: a second setState here would compute from the
    // pre-toggle `sets` and drop the tick.
    const next = now
      ? fillForward(marked, index, measuresForSet(sets[index], loadTypeOf(exerciseID), measuresFor))
      : marked;
    commit(next);
    // Ticking a set is the moment its weight becomes real evidence for the
    // REST of today — see N191. Only on the way to done: un-ticking is a
    // correction, and refreshing suggestions off a row someone just decided
    // didn't happen would show a signal built on a set that, as far as the
    // athlete is concerned, never occurred.
    if (now && session) {
      refreshSuggestions(session.sport, session.workout_id, next).catch(() => {});
    }
    // A haptic, not a sound. This fires 20+ times a session — more than
    // anything else the app does — and a chime that often is the one thing
    // guaranteed to wear out its welcome. A buzz is felt through a pocket,
    // survives a loud gym, needs no preference of its own (it already rides
    // the OS System Haptics setting), and costs nothing when the phone is
    // face-down on a bench.
    //
    // BOTH directions, which is where this parts company with the sound it
    // replaces. That fired on tick-on only, because a chime reads as approval
    // and un-ticking is a correction rather than an achievement. A haptic
    // carries no such verdict — it is a receipt that the tap landed, and that
    // is worth exactly as much when you are undoing a mis-tap mid-set.
    //
    // Deliberately NOT in `recordTimedSet`: a work countdown that reaches zero
    // ticks its own set, and `Countdown` has already fired a success
    // notification haptic by then. Adding this on top would be two buzzes for
    // one event — the same collision the sound was kept out of, for the same
    // reason.
    Haptics.selectionAsync().catch(() => {});
    // N435 — never on a finished session, edit mode or not. A rest countdown
    // is a live-workout affordance; the `stopTimer` effect that keeps one
    // from outliving a finished session is keyed on `session?.ended_at`
    // CHANGING, which correcting a tick does not do, so a bar started here
    // would have nothing left to catch it.
    if (now && autoRest && !finished) startRest(exerciseID);
  }

  /**
   * Starts rest for one exercise, at that exercise's own duration.
   *
   * The duration is per exercise and editable — a triple on a heavy squat
   * and a set of lateral raises are not the same wait, and the movement
   * pattern's default is a starting point rather than an answer.
   */
  /**
   * Bank a running work countdown before something replaces it.
   *
   * Stop logs honest elapsed time; starting a *different* timer used to discard
   * it — so a minimised plank plus one tap on another row's timer glyph erased
   * the plank from history with nothing on screen to say so. Found in review,
   * and it is the same rule Stop follows: the seconds happened, so they are
   * kept, and the set is not ticked because the athlete did not say it was done.
   *
   * Only a countdown still running. A finished one has already written itself
   * through the completion callback, and writing again would double up.
   */
  function bankRunningWork() {
    const t = timerState.timer;
    if (t?.kind !== 'work' || t.setIndex == null || !t.exerciseID) return;
    if (timerState.remaining <= 0) return;
    const elapsed = elapsedOf(t, timerState.remaining);
    // A banked ZERO is not a shorter set, it is an invalid row. `elapsedOf`
    // rounds, so starting a timer and tapping another one within half a second
    // banks 0 — and the server's CHECK is `seconds IS NULL OR seconds > 0`, so
    // that set fails to sync and takes its whole session's write with it. The
    // honest reading of "no time passed" is that there is nothing to bank.
    // (Pre-existing, found by review of N4; it only ever bit exercises where
    // `seconds` is the measure, since a targeted set no longer takes the
    // clock's value at all.)
    if (elapsed <= 0) return;
    recordTimedSet(t.setIndex, t.exerciseID, elapsed, false);
  }

  async function startRest(exerciseID: string) {
    bankRunningWork();
    const ex = catalog.get(exerciseID);
    const seconds = userId ? await readRestSeconds(userId, ex, exerciseID) : 90;
    timerState.startRest(seconds, ex?.name ?? 'Rest', exerciseID, stepFor(exerciseID, seconds));
  }

  /**
   * Starts the countdown for a timed set — a plank, a hold, a carry.
   *
   * The duration comes off the set itself, because that is where the
   * prescription already is: a template's `target_seconds` is copied onto every
   * set it creates, so "3 × 1 min" needs no second source. See
   * `workSecondsFor`.
   *
   * **Counted in, always.** The three seconds before it starts are not
   * decoration: without them the first seconds of every timed set are spent
   * putting the phone down and getting into position, and they get logged as
   * work that happened. See `READY_SECONDS`.
   */
  function startWork(index: number, exerciseID: string) {
    bankRunningWork();
    const ex = catalog.get(exerciseID);
    const seconds = workSecondsFor(sets[index], ex?.load_type);
    if (seconds == null) return;
    timerState.startWorkWithLeadIn(
      seconds,
      ex?.name ?? 'Work',
      exerciseID,
      index,
      stepFor(exerciseID, seconds),
    );
  }

  /** The catalog's load type for an exercise, or undefined while it is loading. */
  function loadTypeOf(exerciseID: string): Exercise['load_type'] | undefined {
    return catalog.get(exerciseID)?.load_type;
  }

  /** How much ± moves this exercise's clock — 15s, or 30s if it thinks in minutes. */
  function stepFor(exerciseID: string, seconds?: number | null): number {
    return adjustStepFor(durationFor(exerciseID, seconds));
  }

  /**
   * Everything a run needs to know about the exercises in it.
   *
   * Built here rather than inside `lib/intervalRun.ts` because this is the only
   * place that holds the catalog, the resolved rest durations and the duration
   * units at once — the module itself stays free of all three, which is what
   * lets it be tested without a database.
   */
  function runContext(rests: Record<string, number>): RunContext {
    return {
      workSeconds: (set, exerciseID) => workSecondsFor(set, loadTypeOf(exerciseID)),
      restSeconds: (exerciseID) => rests[exerciseID] ?? 60,
      name: (exerciseID) => catalog.get(exerciseID)?.name ?? 'Exercise',
      // Seeded from the exercise's own first duration, not from nothing: a
      // four-minute round with no stored override would otherwise fall to the
      // seconds default and put ±15 on the timer for it.
      step: (exerciseID) =>
        stepFor(exerciseID, sets.find((s) => s.exercise_id === exerciseID)?.seconds ?? null),
    };
  }

  /**
   * The rest durations for a list of exercises, resolved together.
   *
   * Up front rather than at each transition, and that is the point of building
   * the plan in advance: looking a preference up from SQLite inside a countdown
   * callback would put an await between one interval ending and the next
   * beginning, which is a gap the athlete stands in.
   */
  async function restsFor(exerciseIDs: string[]): Promise<Record<string, number>> {
    const unique = [...new Set(exerciseIDs)];
    const pairs = await Promise.all(
      unique.map(async (eid) => {
        const seconds = userId
          ? await readRestSeconds(userId, catalog.get(eid), eid)
          : 60;
        return [eid, seconds] as const;
      }),
    );
    return Object.fromEntries(pairs);
  }

  /**
   * Run every remaining set of one exercise, hands free.
   *
   * "Run all sets" on the group header. Only offered when every pending set of
   * that exercise is timed — see `canRun` for why that is all-or-nothing.
   */
  async function runExercise(group: { exerciseID: string; indices: number[] }) {
    bankRunningWork();
    const rests = await restsFor([group.exerciseID]);
    const steps = buildExerciseRun(sets, group.indices, runContext(rests));
    timerState.startRun(steps, 'exercise');
  }

  /**
   * Run the whole session, hands free, with spoken cues.
   *
   * The "Guided" button, and it appears only when every pending set in the
   * session is timed — which in practice means a conditioning or circuit
   * workout, the kind VOLA Workouts ships. A mixed session cannot be guided
   * honestly: the app has no way to know when you racked a bar.
   */
  async function runSession() {
    bankRunningWork();
    const rests = await restsFor(sets.map((s) => s.exercise_id));
    const steps = buildSessionRun(sets, groups, runContext(rests));
    timerState.startRun(steps, 'session');
  }

  /**
   * Writes what a timed set actually took, and optionally ticks it.
   *
   * **`seconds` is what the clock counted, never what was asked for.** A plank
   * held for 40 of a planned 60 is a 40-second plank; logging the target
   * because the target is what the timer started from would put a number in
   * the history that never happened.
   *
   * Which is why running out and stopping early are not the same event. A
   * countdown that reaches zero is a set you completed, so it ticks itself and
   * hands over to rest exactly as the manual tick does. Stopping early records
   * the honest elapsed time but leaves the tick alone — an accidental Stop
   * should not silently commit a two-second plank, and `toggleDone`'s contract
   * is that ticking is the moment the numbers are final.
   *
   * One commit either way, for the reason `toggleDone` documents: a second
   * setState here would compute from the pre-write `sets` and drop the value.
   */
  function recordTimedSet(index: number, exerciseID: string, seconds: number, tick: boolean) {
    /*
      `setIndex` is a POSITION, and positions move.

      `LoggedSet` carries no stable id, so a countdown identifies its row by
      where that row sat when it started. Delete a set above it, reorder the
      groups, or swap the exercise, and the index now names a different set —
      at which point a finishing countdown writes seconds onto, and ticks,
      somebody else's squat. Silent wrong-row corruption, in the one screen
      that must not lose data.

      `stopTimerForStructureChange` below cancels the countdown whenever the
      shape changes, and this check is the backstop that does not depend on
      anyone remembering to call it. A mutator that forgets loses the elapsed
      seconds, which is a shame; writing them to the wrong exercise is a lie.
    */
    if (!timedSetStillAt(sets, index, exerciseID)) return;
    // Whether the clock may write into `seconds` at all — see
    // `elapsedBelongsInSeconds`. On a plank it is the measure and elapsed is
    // the honest record; on a squat carrying a 40s target it is the
    // prescription, and letting the clock overwrite it means racking at 25
    // silently rewrites the target to 25. The tick still happens either way;
    // only the number is withheld.
    const keepsElapsed = elapsedBelongsInSeconds(loadTypeOf(exerciseID));
    const written = sets.map((s, i) =>
      i === index
        ? { ...s, ...(keepsElapsed ? { seconds } : {}), completed: tick || s.completed }
        : s,
    );
    const next = tick
      ? fillForward(written, index, measuresForSet(written[index], loadTypeOf(exerciseID), measuresFor))
      : written;
    commit(next);
    // Never inside a run: the plan already has its own rest steps, and starting a
    // second countdown here would race the one the run is about to start —
    // whichever landed last would win, and it would not reliably be the plan's.
    if (tick && autoRest && !timerState.run) void startRest(exerciseID);
  }

  /**
   * Cancels a running work countdown when the rows move under it.
   *
   * Only `work` — a rest belongs to an exercise, not to a position, so
   * reordering does not invalidate it.
   *
   * **A run always dies, whatever step it is on**, and that asymmetry is the
   * point: every remaining step in the plan carries a `setIndex` that the
   * reorder has just invalidated, so a run allowed to continue through a rest
   * would come out the other side writing to somebody else's squat. One
   * cancelled circuit is a nuisance; a set logged against the wrong exercise is
   * a lie in the training history.
   */
  function stopTimerForStructureChange() {
    if (timerState.run || timerState.timer?.kind === 'work') timerState.stop();
  }

  function removeSet(index: number) {
    stopTimerForStructureChange();
    commit(sets.filter((_, i) => i !== index).map((s, i) => ({ ...s, position: i })));
  }

  if (loading && !everLoaded) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator accessibilityLabel="Loading session" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>{error ?? 'Session not found.'}</Text>
      </View>
    );
  }

  // Grouped by exercise so "+ Set" sits under the movement it belongs to,
  // rather than making someone re-pick the exercise for every set. See
  // `groupSets`'s own doc comment for why it is deliberately blind to
  // `set_type` — the orphaned-drop handling lives in `setOrdinals` below.
  const groups = groupSets(sets);

  /**
   * Switch a whole exercise between reps and time.
   *
   * Per exercise rather than per set — see `lib/setMode.ts`. Cancels any running
   * countdown first: a work countdown started against a duration that is about
   * to be cleared is a countdown writing seconds onto a row that no longer
   * measures them.
   */
  function setGroupMode(group: { exerciseID: string; indices: number[] }, mode: SetMode) {
    const next = withGroupMode(sets, group.indices, loadTypeOf(group.exerciseID), mode);
    if (next === sets) return;
    stopTimerForStructureChange();
    commit(next);
    Haptics.selectionAsync().catch(() => {});
  }



  /**
   * REMOVE-GROUP DOC MOVED — see removeGroup below.
   *
   * Remove an exercise and every set under it.
   *
   * Confirmed, unlike removing one set: this can discard several sets at once,
   * including completed ones, and an accidental tap on a header would
   * otherwise silently delete a chunk of the workout. `Swap` is the
   * non-destructive neighbour for "wrong exercise" — this is for "I'm not
   * doing this at all".
   */
  function moveGroup(groupIndex: number, delta: -1 | 1) {
    const next = reorderGroups(sets, groups.map((g) => g.indices), groupIndex, delta);
    if (!next) return;
    stopTimerForStructureChange();
    commit(next);
  }

  function removeGroup(groupIndex: number) {
    const g = groups[groupIndex];
    const name = catalog.get(g.exerciseID)?.name ?? 'this exercise';
    const logged = g.indices.filter((i) => sets[i].completed).length;
    Alert.alert(
      `Remove ${name}?`,
      logged > 0
        ? `${logged} logged ${logged === 1 ? 'set' : 'sets'} will be deleted too.`
        : 'Its sets will be removed from this session.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            stopTimerForStructureChange();
            const drop = new Set(g.indices);
            commit(
              sets.filter((_, i) => !drop.has(i)).map((x, position) => ({ ...x, position })),
            );
          },
        },
      ],
    );
  }

  const finished = session.ended_at !== null;

  /**
   * N435 — whether "Correct this session" may be offered at all.
   *
   * Scoped to PAST-DAY sessions only, not every finished one: a session that
   * finished five minutes ago still gets the "is this locked in" moment the
   * read-only state exists for, and the ticket's own framing ("editing past
   * sessions") is about days already closed, not the one still running. See
   * `isPastLocalDay`'s doc comment for why this is a calendar-day comparison
   * rather than an elapsed-time one, and why it reads `started_at` rather
   * than `ended_at`.
   */
  const pastDay = finished && isPastLocalDay(session.started_at);

  /**
   * Whether the set controls (weight/reps/count) are live right now.
   *
   * True while the session is still open, exactly as before — and true again
   * once "Correct this session" has been tapped on a past-day one. A finished
   * session is a record by DEFAULT; this is what makes it correctable on
   * purpose rather than reopening it as a workspace outright. Deliberately
   * NOT threaded onto the exercise-level controls below (rest, reps/time and
   * unit chips, reorder/swap/remove-exercise, guided run, "Use" suggestion) —
   * those stay `!finished` exactly as they did, so editing a past session
   * corrects the numbers logged against it without reopening the broader
   * in-workout affordances a correction has no use for. Narrower on purpose;
   * see the history entry for the reasoning.
   */
  const sessionEditable = !finished || editingFinished;

  /**
   * Whether the session as a whole can be run hands-free.
   *
   * Computed over every set rather than per group, because "Guided" claims to
   * take the athlete through the entire workout. One untimed exercise anywhere
   * means it cannot, and offering it anyway would be a guided run that stops
   * guiding in the middle without saying so. `runContext({})` is safe here
   * because `canRun` only ever consults `workSeconds` — the rest durations are
   * resolved later, when a run is actually built.
   */
  const guidable =
    !finished &&
    !timerState.run &&
    groups.length > 0 &&
    canRun(sets, sets.map((_, i) => i), runContext({}));

  /**
   * How long a guided run would take, for the label on the button.
   *
   * Built with the DEFAULT rest rather than the athlete's stored per-exercise
   * ones, because the real durations need SQLite and this renders on every
   * keystroke. It is an estimate on a button, not a prescription — the run
   * itself resolves the real values before it starts.
   */
  const guidedSeconds = guidable
    ? runSeconds(buildSessionRun(sets, groups, runContext({})))
    : 0;

  return (
    /* N445 — this screen no longer has a `KeyboardAwareFooter` (Finish moved
       back into ordinary scroll content, reverting N184 — see that block's
       own comment below). `KeyboardAwareScreen` still wraps the screen: it is
       a no-op with no footer registered (the "no footer" default in
       `KeyboardAwareScroll.tsx`), and keeping it is cheap insurance against a
       future sibling footer reintroducing the coordination need silently
       instead of by inspection. See `needsPlatformKeyboardInset`. */
    <KeyboardAwareScreen>
      <View style={styles.container} testID="session-screen">
      <Stack.Screen
        options={{
          title: session.name || 'Session',
          headerRight: () =>
            saving ? <ActivityIndicator accessibilityLabel="Saving" /> : null,
        }}
      />

      <KeyboardAwareScrollView
        contentContainerStyle={[
          styles.scroll,
          // Only for the collapsed bar. The expanded card is modal by intent
          // and overlays instead — see TIMER_BAR_SPACE.
          timerState.timer && timerState.minimized ? { paddingTop: TIMER_BAR_SPACE } : null,
        ]}
        // `keyboardShouldPersistTaps` and `automaticallyAdjustKeyboardInsets`
        // used to be restated here. They are the wrapper's defaults, and as of
        // N445 this screen has no `KeyboardAwareFooter` sibling any more, so
        // the wrapper resolves the inset to plain `true` — the ordinary,
        // native-lift behaviour every footer-less screen gets. Left unstated
        // rather than pinned so a future footer on this screen (should one
        // come back) is picked up automatically instead of silently
        // overridden. The wrapper is the authority — see
        // `needsPlatformKeyboardInset`.
      >
        {/* Three numbers while you train — time, sets, reps — and volume
            on top once you finish.
            "Top RPE" is gone entirely: mid-session it only repeated the
            effort typed thirty seconds earlier. Both are still computed by
            the API; they're real data for the trends screen, just not worth
            a permanent slot in a header read between sets. */}
        {volume && (
          <StatRow testID="session-summary">
            {/* The same discs the Today week row uses, and each a different
                hue for the same reason: these are unrelated measures, not a
                ramp, so one accent-coloured set would imply a single scale. */}
            <Stat
              label="Time"
              value={formatElapsed(elapsed)}
              size={22}
              fit
              icon="timer"
              tone={accent.accent}
            />
            <Stat
              label="Sets"
              value={String(volume.working_sets)}
              size={22}
              fit
              icon="layers"
              tone={vola.warn}
            />
            <Stat
              label="Reps"
              value={String(volume.total_reps)}
              size={22}
              fit
              icon="progress"
              tone={vola.info}
            />
            {/* Volume is a result, not a readout. Mid-session it's a
                number nobody acts on — you don't change the next set
                because the running total crossed 1,500kg — so it appears
                once the session is done and the figure means something. */}
            {finished && (
              <Stat
                label="Volume"
                size={22}
                fit
                icon="barbell"
                tone={vola.green}
                value={
                  // `hasUnresolvedLoad` is the "absent beats wrong" guard
                  // (#425): an offline exercise swap this session made has a
                  // set whose `load_factor` could not be resolved locally, so
                  // `localVolume`'s own sum left that set's tonnage out
                  // rather than guessing it — which means the number here is
                  // a silent UNDER-count, not merely a stale one, and
                  // displaying it would be the exact "reports half its
                  // eventual tonnage" bug this exists to fix. Sync corrects
                  // it; until then the tile says nothing rather than a
                  // number that changes on its own with no explanation.
                  unitsReady && volume.tonnage_kg > 0 && !hasUnresolvedLoad(sets)
                    ? formatVolume(volume.tonnage_kg, units)
                    : '—'
                }
              />
            )}
          </StatRow>
        )}

        {/* N488/#849 — the same HR report BJJ and running show, reused
            unchanged. Strength has no single session-level RPE (per-set RPE
            only — `lib/sessions.ts`), so `sessionRPE` is `null` and the
            effectiveness card simply does not render here; see
            `lib/hrSessionReport.ts`'s doc comment. */}
        {finished && hrLoaded && (
          <HRSessionReport metrics={hrMetrics} sessionRPE={null} testID="session-hr" />
        )}

        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite" testID="session-error">
            {error}
          </Text>
        )}

        {/*
          The whole workout, hands free.

          Only on a session where EVERY pending set is timed — in practice a
          conditioning or circuit plan, the shape VOLA Workouts ships. That is
          the "only the ones that make sense" rule, made mechanical: the app
          cannot know when you racked a bar, so a run through a mixed session
          would have to stop and wait without being able to say what for.

          It says how long it will take, because that is the one thing an
          athlete wants to know before handing the next eleven minutes to a
          timer.
        */}
        {guidable && (
          <Pressable
            onPress={() => void runSession()}
            style={[styles.guided, { borderColor: accent.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Run this whole workout hands free, with spoken cues"
            testID="run-session"
          >
            {/* N508 — the glass wash, first so the icon/text paint over it.
                See `CardGlass`'s own doc comment for the material. */}
            <CardGlass />
            <Icon name="play" size={15} color={accent.ink} strokeWidth={2.2} />
            <View style={styles.guidedBody}>
              <Text style={[styles.guidedTitle, { color: accent.ink }]}>Guided workout</Text>
              <Text style={styles.guidedSub}>
                {formatElapsed(guidedSeconds)} · counts you in and calls each set
              </Text>
            </View>
          </Pressable>
        )}

        {groups.map((g, gi) => {
          const exercise = catalog.get(g.exerciseID);
          const dual = isDualMode(exercise?.load_type);
          const mode = groupModeOf(sets, g.indices, exercise?.load_type);
          // The first pending duration, so the chip and the fields agree about
          // which scale this exercise is being written at.
          const groupSeconds = g.indices.map((i) => sets[i]?.seconds).find((s) => s != null) ?? null;
          const durationUnit = durationFor(g.exerciseID, groupSeconds);
          const measures = measuresFor(exercise?.load_type ?? 'reps');
          // `groupSeconds != null` is the N4 half: an exercise that does not
          // MEASURE time can now still carry a timer target on one of its sets,
          // and that target is typed in these units. Without this the athlete
          // gets a duration field for squats and no way to say whether the
          // number means seconds or minutes — the unit chip's own comment
          // ("a control for a field that is not there") stops being true the
          // moment the field is there.
          const timed = mode === 'time' || measures.includes('seconds') || groupSeconds != null;
          // The kg/lb chip now appears only where there IS a weight. It used to
          // sit on every header, including planks and jump rope, offering to
          // switch the units of a field those rows do not have — harmless until
          // the duration chip arrived beside it and the two read as a pair.
          const weighted = measures.includes('weight');
          const runnable = !finished && !timerState.run && canRun(sets, g.indices, runContext({}));
          return (
            <View key={g.exerciseID + g.indices[0]} style={styles.group}>
              <View style={styles.groupHead}>
                <Text style={styles.groupName}>{exercise?.name ?? g.exerciseID}</Text>
                {!finished && (
                  <Pressable
                    onPress={() => startRest(g.exerciseID)}
                    hitSlop={10}
                    style={styles.restChip}
                    accessibilityRole="button"
                    accessibilityLabel={`Start rest for ${exercise?.name ?? 'this exercise'}`}
                    testID={`rest-${g.exerciseID}`}
                  >
                    <Text style={styles.restChipText}>Rest</Text>
                  </Pressable>
                )}
                {/* Reps or time, for the movements that are honestly both.
                    On the header rather than on each row because nobody does
                    set 1 of burpees in reps and set 2 in seconds — see
                    lib/setMode.ts. */}
                {!finished && dual && (
                  <Pressable
                    onPress={() => setGroupMode(g, mode === 'time' ? 'reps' : 'time')}
                    hitSlop={10}
                    style={[
                      styles.modeChip,
                      mode === 'time' && { borderColor: accent.accent },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: mode === 'time' }}
                    accessibilityLabel={`${exercise?.name ?? 'This exercise'} is counted in ${
                      mode === 'time' ? 'time' : 'reps'
                    }. Switch to ${mode === 'time' ? 'reps' : 'time'}.`}
                    testID={`mode-${g.exerciseID}`}
                  >
                    <Text
                      style={[styles.modeChipText, mode === 'time' && { color: accent.ink }]}
                    >
                      {mode === 'time' ? 'Time' : 'Reps'}
                    </Text>
                  </Pressable>
                )}
                {/* Seconds or minutes — the duration counterpart of the kg/lb
                    chip beside it. Only on an exercise actually measured in
                    time; on a set of squats it would be a control for a field
                    that is not there. */}
                {!finished && timed && (
                  <Pressable
                    onPress={() => toggleDurationFor(g.exerciseID, durationUnit)}
                    hitSlop={10}
                    style={styles.unitChip}
                    accessibilityRole="button"
                    accessibilityLabel={`${exercise?.name ?? 'This exercise'} is in ${
                      durationUnit === 'minutes' ? 'minutes' : 'seconds'
                    }. Switch.`}
                    testID={`duration-${g.exerciseID}`}
                  >
                    <Text style={styles.unitChipText}>{durationInputUnit(durationUnit)}</Text>
                  </Pressable>
                )}
                {/* Every remaining set, back to back, counted in and rested
                    between. Only when all of them are timed — a run that
                    skipped the untimed ones would stop guiding halfway
                    through without saying so. */}
                {runnable && (
                  <Pressable
                    onPress={() => void runExercise(g)}
                    hitSlop={10}
                    style={[styles.runChip, { borderColor: accent.accent }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Run all remaining sets of ${
                      exercise?.name ?? 'this exercise'
                    } back to back`}
                    testID={`run-${g.exerciseID}`}
                  >
                    <Icon name="play" size={11} color={accent.ink} strokeWidth={2.2} />
                    <Text style={[styles.runChipText, { color: accent.ink }]}>Run all</Text>
                  </Pressable>
                )}
                {!finished && weighted && (
                  <Pressable
                    onPress={() => toggleUnitFor(g.exerciseID)}
                    hitSlop={10}
                    style={styles.unitChip}
                    accessibilityRole="button"
                    accessibilityLabel={`${exercise?.name ?? 'This exercise'} is in ${weightUnitName(
                      unitFor(g.exerciseID),
                    )}. Switch.`}
                    testID={`unit-${g.exerciseID}`}
                  >
                    <Text style={styles.unitChipText}>{weightUnit(unitFor(g.exerciseID))}</Text>
                  </Pressable>
                )}
              </View>
              {/* Reorder, swap, remove — structural moves on the EXERCISE,
                  made every so often rather than every set. Split onto their
                  own row, below the name and the per-set chips above, so the
                  thing read between every set (what is this, is it resting,
                  what unit) is not competing for attention with a control
                  reached for maybe once a session. Muted rather than hidden:
                  still one tap each, still in the same place every time —
                  just not shouting as loud as the header they used to share.

                  "Swap" used to render in `accent.ink`, the one colour this
                  screen reserves for what was earned (see the drop-set
                  indentation note below) — which made a rarely-used control
                  brighter than Rest, Time and the unit chips it sat beside.
                  `textMuted` now matches those three; only Remove keeps a
                  colour of its own, because destructive is a real distinction
                  the other three don't share. */}
              {!finished && (
                <View style={styles.groupActions}>
                  {/* Order and removal live on the exercise, not on a set:
                      "the rack is taken, do legs first" moves a movement and
                      everything logged under it. Buttons rather than a drag
                      handle — a long-press-and-drag is a poor bet with one hand
                      and a bar to get back to, and it fights the scroll view.
                      Dimmed rather than hidden at the ends (see `moveChipOff`),
                      so there is no dead target to aim at between sets and a
                      screen reader still gets to announce "unavailable"
                      rather than losing the control outright. */}
                  <Pressable
                    disabled={gi === 0}
                    onPress={() => moveGroup(gi, -1)}
                    hitSlop={10}
                    style={[styles.moveChip, gi === 0 && styles.moveChipOff]}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: gi === 0 }}
                    accessibilityLabel={`Move ${exercise?.name ?? 'this exercise'} earlier`}
                    testID={`up-${g.exerciseID}`}
                  >
                    <Text style={styles.moveChipText}>↑</Text>
                  </Pressable>
                  <Pressable
                    disabled={gi === groups.length - 1}
                    onPress={() => moveGroup(gi, 1)}
                    hitSlop={10}
                    style={[styles.moveChip, gi === groups.length - 1 && styles.moveChipOff]}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: gi === groups.length - 1 }}
                    accessibilityLabel={`Move ${exercise?.name ?? 'this exercise'} later`}
                    testID={`down-${g.exerciseID}`}
                  >
                    <Text style={styles.moveChipText}>↓</Text>
                  </Pressable>
                  <Pressable
                    // openPicker flushes first — the swap screen reads the
                    // session back, so an unsaved edit still in flight would
                    // be overwritten.
                    onPress={() =>
                      void openPicker(`/session/${id}/add?swap=${encodeURIComponent(g.exerciseID)}`)
                    }
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={`Swap ${exercise?.name ?? 'this exercise'} for another`}
                    testID={`swap-${g.exerciseID}`}
                  >
                    <Text style={styles.swapText}>Swap</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => removeGroup(gi)}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${exercise?.name ?? 'this exercise'} from this session`}
                    testID={`remove-group-${g.exerciseID}`}
                  >
                    <Text style={styles.removeGroupText}>Remove</Text>
                  </Pressable>
                </View>
              )}
              {/* A drop does not get a set number. "225x3 then 185x8" is ONE
                  set with a drop off it — numbering them 3 and 4 tells the
                  athlete they did four sets when they did three, and that
                  number is the one they count. So the ordinal only advances on
                  a non-drop row, and a drop carries its parent's. */}
              {/* Once per group, not once per row: `setOrdinals` walks the
                  whole group, so calling it inside the map made rendering a
                  group quadratic in its own size — inside the render of the
                  app's most complex screen. Harmless at real set counts and
                  still not worth doing. */}
              {((ordinals) =>
                g.indices.map((i, n) => {
                  const isDrop = sets[i].set_type === 'drop';
                  const ordinal = ordinals[n];
                  return (
                <SwipeToDelete
                  key={i}
                  // A finished session is a record, not a workspace, by
                  // DEFAULT — the same reason every other control here gates
                  // on `finished`. `sessionEditable` is that default with one
                  // deliberate escape hatch: "Correct this session" (N435).
                  enabled={sessionEditable}
                  onDelete={() => removeSet(i)}
                  // Rows are keyed by index and a set has no stable id, so
                  // any change to WHAT LIVES AT THIS INDEX must close an open
                  // swipe — otherwise Delete stays armed against whichever
                  // set shifted into the slot. Keyed on identity rather than
                  // on `sets.length`: a count only catches add/remove, and a
                  // reorder that preserves length would slip through. (Today
                  // `moveGroup` happens to remount the subtree via its group
                  // key, so a count would survive by luck — which is not a
                  // thing to depend on.)
                  closeOn={`${sets[i].exercise_id}:${sets[i].set_type}:${sets.length}`}
                  // The ORDINAL, not the row index. This announced "set 4"
                  // on a drop whose own row announced "drop off set 3" — the
                  // exact miscount the ordinal exists to prevent, surviving one
                  // level up because the container was never told.
                  accessibilityLabel={isDrop ? `drop off set ${ordinal}` : `set ${ordinal}`}
                  testID={`set-${i}-swipe`}
                >
                  <SetRow
                    index={i}
                    ordinal={ordinal}
                    isDrop={isDrop}
                    set={sets[i]}
                    exercise={exercise}
                    editable={sessionEditable}
                    onChange={(next) => update(i, next)}
                    onRemove={() => removeSet(i)}
                    onToggleDone={() => toggleDone(i, g.exerciseID)}
                    // Null on anything that isn't measured in seconds, which
                    // is what keeps a play button off a set of squats. The
                    // running row hides its own button rather than offering a
                    // restart mid-hold. Also null whenever `finished` — N435's
                    // edit mode unlocks correcting the numbers already on a
                    // set, not starting a live countdown against one; without
                    // this a `stopTimer` effect keyed on `ended_at` (which
                    // does not change when edit mode toggles) would have
                    // nothing left to catch a countdown newly armed here.
                    onStartTimer={
                      !finished &&
                      workSecondsFor(sets[i], exercise?.load_type) != null &&
                      timerState.timer?.setIndex !== i &&
                      // Never inside a run: the plan is already driving this
                      // exercise, and a second countdown started by hand would
                      // race it for the same row.
                      !timerState.run
                        ? () => startWork(i, g.exerciseID)
                        : undefined
                    }
                    /*
                      The other half of the same clock. `offersTimerTarget`
                      excludes a set that already MEASURES seconds (a plank's
                      clock is its measurement, not a target) and a dual-mode
                      exercise (writing `seconds` on a burpee set logged in reps
                      flips it to time mode and hides the rep count — what the
                      exercise-level reps/time switch exists to do properly).

                      The two timer suppressions are repeated deliberately: a
                      row that is ticking, or a run already driving this
                      exercise, should show no clock at all rather than swapping
                      the start button for an arm one. Raised in review — the
                      first version gated only on the load type, so clearing the
                      field mid-countdown grew a dim clock on the running row.
                    */
                    canArmTimer={
                      !finished &&
                      offersTimerTarget(exercise?.load_type) &&
                      sets[i].seconds == null &&
                      timerState.timer?.setIndex !== i &&
                      !timerState.run
                    }
                    showEffort={showEffort}
                    units={unitFor(g.exerciseID)}
                    duration={durationUnit}
                  />
                </SwipeToDelete>
                  );
                }))(setOrdinals(g.indices.map((j) => sets[j])))}
              {(() => {
                const hint = suggestions.get(g.exerciseID);
                if (!hint || hint.code === 'not_applicable') return null;
                // N473/#812 (item 9) — see suggestionPrefs's own doc comment
                // above for why this is read on every focus, and why it
                // starts `null`. Keyed on `session?.sport ?? 'strength'`,
                // matching Today's own `suggestionsAllowed` call
                // (`app/(tabs)/index.tsx`) rather than a literal — this
                // screen is used by every sport this app logs sets/reps for,
                // not only strength, and a future non-BJJ, non-running
                // discipline routed here should respect ITS OWN off-switch
                // rather than strength's. A non-weighted sport never reaches
                // this branch at all: `not_applicable` already suppressed it
                // above.
                if (
                  suggestionPrefs === null ||
                  !suggestionsAllowed(suggestionPrefs.master, suggestionPrefs.off, session?.sport ?? 'strength')
                ) {
                  return null;
                }
                const u = unitFor(g.exerciseID);
                const phase = PROGRESSION_PHASE[hint.code] ?? UNKNOWN_PHASE;
                // Defaulted rather than dereferenced: an app build newer than
                // the deployed API is routine with Expo Go against a rolling
                // backend, and a missing field should cost the pips, not throw
                // inside the logging screen's render.
                const range = hint.rep_range ?? { low: 0, high: 0 };
                const w = hint.target_weight_kg;
                const reps = hint.target_reps;
                // Applied is judged on the first set: a session mid-flight
                // legitimately has later sets still empty, and treating that
                // as un-applied leaves the button offering what's already done.
                // Only the sets still ahead of you. A completed set is a
                // record of what happened — rewriting its reps to a target
                // would put numbers in the log nobody performed, and then
                // count them in the volume. `add_reps` is where most sessions
                // land, so this control is visible exactly when the early sets
                // hold fresh real data.
                //
                // N473/#812 (item 7) — see pendingSuggestableIndices's own
                // doc comment (lib/sessions.ts) for why this is straight
                // working sets only, not every non-warm-up set.
                const pending = pendingSuggestableIndices(g.indices, sets);
                const first = sets[pending[0]];
                const applied =
                  pending.length > 0 &&
                  (w == null || first?.weight_kg === w) &&
                  (reps == null || first?.reps === reps);
                const canApply =
                  !finished && !applied && pending.length > 0 && (w != null || reps != null);
                const target = [
                  w != null ? formatWeight(w, u) : null,
                  reps != null ? `× ${reps}` : null,
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <View style={styles.hintRow}>
                    <View style={styles.hintBody}>
                      <View style={styles.hintPhaseRow}>
                        <View style={[styles.hintDot, { backgroundColor: phase.color }]} />
                        <Text style={styles.hintPhase}>{phase.label}</Text>
                        <RepRangePips
                          low={range.low}
                          high={range.high}
                          reached={hint.last_min_reps}
                          color={phase.color}
                        />
                      </View>
                      {target !== '' && <Text style={styles.hintTarget}>{target}</Text>}
                      {/* The reason, verbatim from the API. It's the whole
                          point: a number you can argue with. */}
                      <Text style={styles.hintReason}>{hint.reason}</Text>
                      {/* N191 — an ADDITIONAL note, never a replacement for
                          the line above. The target/reason above are still
                          purely last time's numbers; this says when today's
                          own sets disagree with them, and leaves the athlete
                          to decide, exactly as the API's own doc comment
                          promises. */}
                      {hint.in_session_signal != null && (
                        <Text style={styles.hintInSession}>{hint.in_session_signal.reason}</Text>
                      )}
                      {hint.last_weight_kg != null && (
                        /*
                          Three kinds of number on one line, joined by three
                          identical separators: `Last 5 × 100kg · 2 RIR · Est.
                          1RM 120kg` is a measurement, an opinion and a model
                          output presented as one list. See
                          `backend/internal/modules/session/basis.go`.

                          The rating is set apart. The estimate is not, because
                          it already says "Est." in the text itself — the same
                          call the records card makes, for the same reason.

                          The label spells both out, because italic announces
                          nothing and this line is read as a unit anyway.
                        */
                        <Text
                          style={styles.hintLast}
                          accessibilityLabel={[
                            // "by", not "×": VoiceOver's handling of U+00D7
                            // varies with punctuation verbosity and can skip it
                            // entirely. This label exists because styles are
                            // silent, so it should not depend on a glyph being
                            // spoken. The visible text keeps the ×.
                            `Last ${hint.last_reps != null ? `${hint.last_reps} by ` : ''}${formatWeight(hint.last_weight_kg, u)}`,
                            hint.last_rir != null
                              ? `reported ${hint.last_rir} RIR`
                              : hint.last_rpe != null
                                ? `reported RPE ${hint.last_rpe}`
                                : null,
                            hint.estimated_1rm_kg != null
                              ? `estimated 1RM ${formatEstimate(hint.estimated_1rm_kg, u)}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join('. ')}
                        >
                          Last {hint.last_reps != null ? `${hint.last_reps} × ` : ''}
                          {formatWeight(hint.last_weight_kg, u)}
                          {hint.last_rir != null ? (
                            <Text style={styles.hintReported}> · {hint.last_rir} RIR</Text>
                          ) : null}
                          {hint.last_rir == null && hint.last_rpe != null ? (
                            <Text style={styles.hintReported}> · RPE {hint.last_rpe}</Text>
                          ) : null}
                          {/* Read off the same set the plan reasons from, so
                              the two can't tell different stories. Absent
                              rather than zero when there can't be one. */}
                          {hint.estimated_1rm_kg != null
                            ? ` · Est. 1RM ${formatEstimate(hint.estimated_1rm_kg, u)}`
                            : ''}
                        </Text>
                      )}
                    </View>
                    {canApply && (
                      <Pressable
                        onPress={() => {
                          commit(
                            sets.map((st, i) =>
                              pending.includes(i)
                                ? {
                                    ...st,
                                    ...(w != null ? { weight_kg: w } : {}),
                                    // Never onto a set being counted in time.
                                    // This button bypasses `applySuggestions`,
                                    // so it needs the guard of its own that
                                    // review caught it missing: a rep target on
                                    // a 40-second burpee row leaves it holding
                                    // both measures, which flips the derived
                                    // mode back with a duration still attached
                                    // and feeds phantom reps to the volume
                                    // rollup. See lib/setMode.ts.
                                    ...(reps != null &&
                                    setModeOf(st, loadTypeOf(st.exercise_id)) !== 'time'
                                      ? { reps }
                                      : {}),
                                  }
                                : st,
                            ),
                          );
                        }}
                        style={[styles.hintApply, { backgroundColor: accent.accent }]}
                        accessibilityRole="button"
                        // Built from the numbers, not from `target`: screen
                        // readers announce "×" as "multiplication sign", which
                        // turns a rep target into gibberish.
                        accessibilityLabel={`Use ${[
                          w != null ? formatWeight(w, u) : null,
                          reps != null ? `for ${reps} reps` : null,
                        ]
                          .filter(Boolean)
                          .join(' ')} on the remaining sets of ${
                          exercise?.name ?? 'this exercise'
                        }`}
                        testID={`apply-suggestion-${g.exerciseID}`}
                      >
                        <Text style={styles.hintApplyText}>Use</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })()}

              {sessionEditable && (
                <View style={styles.addRow}>
                  <Pressable
                    style={styles.addSet}
                    onPress={() => addSet(g.exerciseID, g.indices[g.indices.length - 1])}
                    accessibilityRole="button"
                    accessibilityLabel={`Add another set of ${exercise?.name ?? 'this exercise'}`}
                    testID={`add-set-${g.exerciseID}`}
                  >
                    <Text style={[styles.addSetText, { color: accent.ink }]}>+ Set</Text>
                  </Pressable>
                  {/* Only where a drop means anything. A drop set is "same
                      movement, less weight", so it is offered on a set that HAS
                      a weight — offering it on a plank or a run would be a
                      control that cannot do anything. */}
                  {sets[g.indices[g.indices.length - 1]]?.weight_kg != null && (
                    <Pressable
                      style={styles.addSet}
                      onPress={() => addDropSet(g.indices[g.indices.length - 1])}
                      accessibilityRole="button"
                      accessibilityLabel={`Add a drop set of ${
                        exercise?.name ?? 'this exercise'
                      } — same movement at a lower weight`}
                      testID={`add-drop-${g.exerciseID}`}
                    >
                      <Text style={[styles.addSetText, { color: accent.ink }]}>+ Drop</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          );
        })}

        {sets.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing logged yet</Text>
            <Text style={styles.muted}>Add the first exercise below.</Text>
          </View>
        )}

        {!finished && (
          <Pressable
            style={styles.primary}
            // openPicker flushes; the picker reads the session back out of
            // SQLite (not the server, as this comment used to say).
            onPress={() => void openPicker(`/session/${id}/add`)}
            accessibilityRole="button"
            testID="session-add-exercise"
          >
            <Text style={styles.primaryText}>+ Add exercise</Text>
          </Pressable>
        )}

        {/* N445 — reverts N184. Finish used to live here, then moved to a
            `KeyboardAwareFooter` sibling of this scroll view specifically so
            it would not be "reachable only by scrolling past the whole
            workout" — see that entry in docs/decisions/history.md. That
            footer actively lifts itself to sit just above the keyboard
            whenever one is open, which put "Finish session" directly beside
            (often immediately below) whichever set row was being edited: a
            mis-tap while typing a set's weight could end the whole session.
            The user reported this directly, with a device screenshot, and
            asked for it back at the end of the content — this is a deliberate
            reversal of that decision, not a bug fix on top of it.

            Ordinary scroll content again: it scrolls with the page, so it is
            never adjacent to an actively-edited field, and it is still
            reachable in one motion — scrolling to the bottom of a finished
            workout is the expected gesture. `HoldToConfirm` itself, and every
            prop it's given, is unchanged; only the container moved. */}
        {!finished && (
          <View style={styles.finishSection}>
            <HoldToConfirm
              label="Finish session"
              holdingLabel="Keep holding to finish…"
              confirmTitle="Finish session?"
              confirmBody="You won't be able to add to it afterwards."
              style={[styles.finish, { backgroundColor: accent.accent }]}
              textStyle={styles.finishText}
              /*
                `accent.on`, not the default lime. This button's background IS
                `accent.accent`, and on the default (brand) palette that is
                `#D3EC52` — the exact value of `vola.lime`. A lime fill over a
                lime button at 28% opacity is lime: the fill was mathematically
                invisible on the one button this control was built for. Every
                accent ships an `on` colour precisely because it reads against
                that accent, so this contrasts whichever one is chosen.
              */
              fillColor={accent.on}
              testID="session-finish"
              onConfirm={async () => {
                try {
                  await flush(); // the last set typed must land before the session closes
                  // A BACKFILLED session (N434) finishes on a real day that
                  // isn't the day it's dated to — `new Date()` alone would
                  // stamp `ended_at` days after `started_at`. See
                  // `finishTimestampFor`'s own doc for why mapping the finish
                  // moment onto the session's day keeps the real elapsed
                  // duration intact.
                  const endedAt = finishTimestampFor(new Date(session!.started_at), new Date());
                  await finishLocalSession(userId!, id!, endedAt);
                  const s = await readLocalSession(userId!, id!);
                  if (s) {
                    setSession(s);
                    setSets(s.sets);
                    setVolume(localVolume(s.sets));
                  }
                  requestSync('session-finished');
                  // Raised AFTER the finish has been written and the push
                  // requested — the card is a report, never a step in the flow.
                  if (s) {
                    const summary = summariseSession(s, localVolume(s.sets), showEffort);
                    // An empty session gets the plain read-only screen. Marking
                    // "opened it and finished it" with a card is the hollow
                    // praise that teaches people to stop reading the app.
                    if (worthCelebrating(summary)) {
                      /*
                        Every piece of async celebration state, cleared together.

                        These lines exist because somebody judged the transition
                        into a celebration worth defending, and the list had
                        already drifted: `celebrationMilestone` and
                        `streakSettled` were added without joining it. A second
                        celebration in one mount would then open with a fresh
                        `chimed` ref and a STALE milestone — showing and chiming
                        a rung this session did not cross, which is the exact
                        wrong-congratulation this feature is built to avoid.

                        No path to a second celebration exists today (the finish
                        control renders only while `ended_at` is null), so this
                        is defence, not a fix. It is written as one block so the
                        next state added here is obvious. Raised in review.
                      */
                      setCelebrationRecords([]);
                      setRecordsSettled(false);
                      setCelebrationStreak(null);
                      setCelebrationMilestone(null);
                      setStreakSettled(false);
                      setCelebrating(summary);
                    }
                  }
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          </View>
        )}

        {finished && (
          <>
            {/*
              N435 — "a record, not a workspace" is now the DEFAULT, not the
              only state. `editingFinished` decides which of the two messages
              and controls below show; `pastDay` (see its own comment) decides
              whether "Correct this session" is offered at all — a session
              that finished minutes ago still gets the plain read-only line
              with no way to unlock it, on purpose.
            */}
            {editingFinished ? (
              <>
                <Text style={styles.muted} accessibilityLiveRegion="polite">
                  Editing a finished session — corrections save the same way a
                  live set does.
                </Text>
                <Pressable
                  style={[styles.primary, styles.correctToggle, { borderColor: accent.accent }]}
                  onPress={() => setEditingFinished(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Done editing — lock this session back to read-only"
                  testID="session-done-editing"
                >
                  <Text style={[styles.primaryText, { color: accent.ink }]}>Done editing</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.muted}>Finished — this session is read-only.</Text>
                {pastDay && (
                  <Pressable
                    style={styles.primary}
                    onPress={() => setEditingFinished(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Correct this session — unlock weight, reps and set count for editing"
                    testID="session-correct"
                  >
                    <Text style={styles.primaryText}>Correct this session</Text>
                  </Pressable>
                )}
              </>
            )}
            {/*
              Read-only is not the same as finished with. The card that opened
              the moment this session ended is still the card it deserves, and
              until now dismissing that modal was the end of it.

              NOT gated on `worthCelebrating`. That gate exists to stop the app
              congratulating someone for opening and closing a session — praise
              nobody asked for. Sharing is the opposite: the athlete asked, and
              refusing to hand them a thin card would be the app overruling
              them about their own training.
            */}
            {sessionShare.error && (
              <Text style={styles.muted} accessibilityLiveRegion="polite">
                {sessionShare.error}
              </Text>
            )}
            <ShareSessionButton
              share={sessionShare}
              label="Share this session"
              style={styles.share}
              testID="session-share"
            />
          </>
        )}

        {/* The `Alert` this replaces said only "This can't be undone." — which
            a hold says better, and without a dialog. Contrast the two deletes
            that kept theirs: those state a fact the button cannot carry (how
            many logged sets go with it, that it is removed everywhere and not
            just here). */}
        <HoldToConfirm
          label="Delete session"
          holdingLabel="Keep holding to delete…"
          confirmTitle="Delete session?"
          confirmBody="This can't be undone."
          style={styles.deleteButton}
          textStyle={styles.deleteText}
          fillColor={vola.danger}
          destructive
          testID="session-delete"
          onConfirm={async () => {
            try {
              // Writes a tombstone (or hard-deletes a session the server never
              // saw). The delete travels out through the ordinary push path,
              // so there is no fire-and-forget DELETE here any more — that one
              // both raced the push and was silently lost whenever it failed,
              // which offline was always.
              await deleteLocalSession(userId!, id!);
              requestSync('session-deleted');
              router.back();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      </KeyboardAwareScrollView>

      {/* OUTSIDE the scroll view, deliberately — a `ScrollView` clips its
          content, and the capture reads the real native view. See
          `components/SessionShare.tsx`. */}
      <ShareCardHost share={sessionShare} />

      {celebrating && (
        <SessionCelebration
          // Merged at render, so filling the records in cannot feed back into
          // the effect that fetches them. Same reasoning for the exercise
          // names — see `withExerciseNames`.
          summary={{ ...celebrating, records: withExerciseNames(celebrationRecords, catalog) }}
          sessionID={id}
          streak={celebrationStreak}
          milestone={celebrationMilestone}
          recordsSettled={recordsSettled}
          streakSettled={streakSettled}
          formatTonnage={(v) => formatVolume(v, units)}
          formatWeight={(v) => formatWeight(v, units)}
          onDismiss={() => {
            setCelebrating(null);
            setCelebrationRecords([]);
          }}
        />
      )}

      {timerState.timer && (
        <TimerSurface
          timer={timerState.timer}
          remaining={timerState.remaining}
          run={timerState.run}
          minimized={timerState.minimized}
          onMinimize={() => timerState.setMinimized(true)}
          onExpand={() => timerState.setMinimized(false)}
          onAdjust={(delta) => {
            timerState.adjust(delta);
            // Adjusting a REST is how you tell the app this exercise needs a
            // different wait — so it sticks, rather than being redone every
            // set. A work countdown is deliberately not saved anywhere: its
            // length is the set's own `seconds`, and ±15s there is "hold it a
            // bit longer today", not a new prescription. Writing it to the
            // rest preference would silently change how long you rest because
            // you extended a plank.
            //
            // Not inside a RUN either, and for a third reason: the plan's later
            // rest steps were built from the stored duration, so persisting an
            // adjustment mid-run would leave the preference and the remaining
            // steps disagreeing about the same number.
            const t = timerState.timer;
            if (userId && t?.kind === 'rest' && t.exerciseID && !timerState.run) {
              writeRestSeconds(userId, t.exerciseID, t.total + delta).catch(() => {});
            }
          }}
          onTogglePause={timerState.togglePause}
          onSkip={timerState.skipStep}
          onStop={() => {
            // Stopping a running work countdown logs what it actually
            // counted; see `recordTimedSet` for why that is the elapsed time
            // and why it does not tick the set. Once it has finished, the
            // completion callback has already written the set and this button
            // is only dismissing the surface.
            const t = timerState.timer;
            if (t?.kind === 'work' && t.setIndex != null && t.exerciseID && timerState.remaining > 0) {
              recordTimedSet(t.setIndex, t.exerciseID, elapsedOf(t, timerState.remaining), false);
            }
            timerState.stop();
          }}
        />
      )}
    </View>
    </KeyboardAwareScreen>
  );
}

/**
 * The same working-volume arithmetic the API performs, run locally.
 *
 * Duplicating it is a deliberate, narrow exception to "compute it once, on
 * the server": a summary that blanks out the moment you lose signal is worse
 * than a summary computed twice, and this is the one screen guaranteed to be
 * used without a network. The rules it implements — only completed sets
 * count, and warm-ups count toward nothing — are pinned on the server by
 * TestSummarise_CountsOnlyCompletedSets and TestSummarise_ExcludesWarmups.
 * If the two ever disagree, those tests are the authority.
 */
/**
 * The double-progression phase, as a label and a colour.
 *
 * Kept beside the screen that renders it rather than in a shared module: the
 * rule itself lives only on the server, and this is presentation for one
 * surface. Web has its own copy with its own wording, deliberately — mobile is
 * read between sets and needs the shortest true label, not the same one.
 *
 * The label carries the meaning and the dot is redundant encoding, so nothing
 * here depends on telling two colours apart.
 */
/**
 * The fallback for a code this build doesn't know — a server deployed ahead of
 * the app, which is routine with Expo Go. Nameless on purpose: labelling an
 * unknown phase "HOLD" would state something confident and wrong right next to
 * a `reason` saying otherwise, and the reason is the part that stays true.
 */
const UNKNOWN_PHASE = { label: '', color: vola.textMuted };

const PROGRESSION_PHASE: Record<SuggestionCode, { label: string; color: string }> = {
  // `progressionAdvance`, NOT `lime`. Every other colour in this map is a fixed
  // semantic value; reading the brand here would make `add_load` the one entry
  // that moves when the logo does. Same value as before N183. See Colors.ts.
  add_load: { label: 'ADD LOAD', color: vola.progressionAdvance },
  add_reps: { label: 'ADD A REP', color: vola.green },
  deload: { label: 'DELOAD', color: vola.warn },
  hold: { label: 'HOLD', color: vola.textMuted },
  repeat_hard: { label: 'REPEAT', color: vola.warn },
  repeat_stale: { label: 'RESTART', color: vola.textMuted },
  repeat_unknown_effort: { label: 'LOG EFFORT', color: vola.textMuted },
  no_history: { label: 'FIRST TIME', color: vola.textMuted },
  // N474: there IS recent history for this exercise, it was just all
  // light/deload — distinct label from FIRST TIME on purpose, since "never
  // done it" and "nothing normal-intent to build from" read differently.
  no_recent_normal_session: { label: 'NO BASELINE', color: vola.textMuted },
  not_applicable: { label: '', color: vola.textMuted },
  // N473/#812, behind new_recommendation_engine — see SuggestionCode's own
  // doc comment (lib/sessions.ts) for why neither carries a target_*.
  effort_conflict: { label: 'CHECK EFFORT', color: vola.warn },
  // "UNCLEAR", not "NOT ENOUGH DATA" — abstain means the evidence is
  // AMBIGUOUS (some effort recorded, some not; or a materially conflicting
  // read), which repeat_unknown_effort already distinguishes from an
  // outright ABSENCE of data. "Not enough data" reads as the latter.
  abstain: { label: 'UNCLEAR', color: vola.textMuted },
};

/**
 * Where the lift sits in its rep range, as dots.
 *
 * `reached` is the *weakest* working set, which is what the rule gates on —
 * a session opening at 10 and ending at 6 is exactly the case where load
 * doesn't move, and filling to the best set would explain the wrong thing.
 *
 * Ranges wider than 8 (endurance work) would be an unreadable row of dots, so
 * they degrade to "6-10"-style text. Nobody counts nine dots on a phone.
 */
function RepRangePips({
  low,
  high,
  reached,
  color,
}: {
  low: number;
  high: number;
  reached: number | null;
  color: string;
}) {
  const span = high - low + 1;
  if (span <= 0) return null;
  if (span > 8) {
    return (
      // The digits alone announce as "4 slash 12 dash 20", so the label
      // carries it and the glyphs are the visual shorthand.
      <Text
        style={styles.hintRangeText}
        accessibilityLabel={
          reached != null
            ? `Reached ${reached} of a ${low} to ${high} rep range`
            : `Rep range ${low} to ${high}`
        }
      >
        {reached != null ? `${reached}/` : ''}
        {low}-{high}
      </Text>
    );
  }
  return (
    <View
      style={styles.hintPips}
      accessible
      accessibilityLabel={
        reached != null
          ? `Reached ${reached} of a ${low} to ${high} rep range`
          : `Rep range ${low} to ${high}`
      }
    >
      {Array.from({ length: span }, (_, i) => {
        const rep = low + i;
        const filled = reached != null && rep <= reached;
        return (
          <View
            key={rep}
            style={[styles.hintPip, { backgroundColor: filled ? color : vola.line }]}
          />
        );
      })}
    </View>
  );
}


function SetRow({
  index,
  ordinal,
  isDrop = false,
  set,
  exercise,
  editable,
  onChange,
  onRemove,
  onToggleDone,
  onStartTimer,
  canArmTimer = false,
  units,
  duration,
  showEffort,
}: {
  index: number;
  ordinal: number;
  /**
   * A drop off the set above — rendered as part of it rather than as a set of
   * its own. The relationship is adjacency (there is no parent id and there
   * cannot be one while the server reinserts every row on save), so this comes
   * from the list rather than from the set.
   */
  isDrop?: boolean;
  set: LoggedSet;
  exercise: Exercise | undefined;
  editable: boolean;
  onChange: (next: LoggedSet) => void;
  onRemove: () => void;
  onToggleDone: () => void;
  /** Undefined when this set isn't timed — see `workSecondsFor`. */
  onStartTimer?: () => void;
  /**
   * Whether this set can be GIVEN a countdown it does not have.
   *
   * Decided at the call site rather than here, because the answer depends on
   * the running timer and the interval run — state this row does not see. It
   * is the exact complement of `onStartTimer` and carries the same three
   * suppressions, which is what stops a dim "give this a timer" clock
   * appearing on the very row that is currently ticking (clear the field
   * mid-countdown and it otherwise would) or during a run whose plan is
   * already driving this exercise.
   */
  canArmTimer?: boolean;
  units: UnitSystem;
  /** Seconds or minutes, for this exercise — see `lib/duration.ts`. */
  duration: DurationUnit;
  showEffort: boolean;
}) {
  const accent = useAccent();
  const [open, setOpen] = useState(false);
  /*
    Whether the Timed field is SHOWING, which is not quite the same question as
    whether the set carries a duration — and conflating them made a real target
    impossible to type.

    Rendering the field on `set.seconds != null` alone meant every transient
    parse unmounted it mid-keystroke. In minutes mode `0` is the first character
    of `0.5`, and `fromDisplayDuration(0)` is not positive, so the field
    vanished and the switch flipped off under the athlete's finger before the
    second character could be typed. A sub-minute target could not be entered at
    all.

    So the flag is sticky: turned on by the switch, turned off only by the
    switch, and FORCED on whenever a duration is actually stored — a reload,
    carry-forward from the previous set, or a template that prescribed one all
    have to show their field without anyone having tapped anything.

    The invariant the switch exists for is unaffected and still holds in the
    direction that matters: turning it off nulls `seconds`, so the switch can
    never read "off" over a live duration that is still arming the play button.
    The other direction — on, with the field empty — is a row being typed into,
    and it behaves exactly as off does everywhere it counts: `workSecondsFor`
    is null, so no play button, and `canRun` will not take it.
  */
  const [timedOn, setTimedOn] = useState(set.seconds != null);
  const timed = timedOn || set.seconds != null;

  // Mode-aware: burpees switched to time show a duration field and no reps one,
  // which is the whole point of the switch. Going through `measuresFor` directly
  // would offer the one number the row is not keeping.
  const measures: Measure[] = measuresForSet(set, exercise?.load_type, measuresFor);
  const typeShort = SET_TYPES.find((t) => t.key === set.set_type)?.short ?? '';
  // Named in every field's label, so VoiceOver reads "Reps for set 2 of Back
  // Squat" rather than a column of identical "Reps".
  const exerciseName = exercise?.name ?? set.exercise_id;
  // What every control in this row calls itself. A drop borrows its parent's
  // NUMBER, so without this its tick, its remove and its fields all announce
  // exactly what the parent's do — two distinct controls, one label, and a
  // VoiceOver user cannot tell which they are about to press.
  const setName = isDrop ? `the drop off set ${ordinal}` : `set ${ordinal}`;

  const num = (key: keyof LoggedSet, whole = false) => (text: string) => {
    const raw = text.trim() === '' ? null : Number(text.replace(',', '.'));
    if (raw === null || !Number.isFinite(raw)) {
      onChange({ ...set, [key]: null });
      return;
    }
    // reps/seconds/distance are integers on the wire; a fractional one fails
    // Go's decode and returns a generic "invalid JSON body" that says nothing
    // about which field was wrong.
    onChange({ ...set, [key]: whole ? Math.round(raw) : raw });
  };

  return (
    <View
      style={[styles.setRow, set.completed && styles.setRowDone, isDrop && styles.setRowDrop]}
    >
      <Pressable
        style={styles.setHead}
        onPress={() => editable && setOpen((v) => !v)}
        accessibilityRole={editable ? 'button' : undefined}
        accessibilityLabel={
          isDrop
            ? `Drop off set ${ordinal}. ${describeSet(set, units, duration)}`
            : `Set ${ordinal}. ${describeSet(set, units, duration)}`
        }
        accessibilityState={{ expanded: open }}
        testID={`set-${index}`}
      >
        {/* A drop shows a continuation mark, not a number. It is part of the
            set above — numbering it would tell the athlete they did one more
            set than they did, and that count is the one they carry around. The
            `D` badge still says what it is. */}
        <Text style={[styles.setOrdinal, set.completed && styles.setOrdinalDone]}>
          {isDrop ? '↳' : ordinal}
          {typeShort ? <Text style={styles.setBadge}> {typeShort}</Text> : null}
        </Text>
        <Text style={styles.setSummary}>{describeSet(set, units, duration)}</Text>
        {editable && (onStartTimer || canArmTimer) && (
          /*
            One clock, doing the whole job of a set's countdown — and it does
            two things, decided by whether the set already carries a duration.

            **No duration** (`canArmTimer`): dim. Tapping arms one and opens the
            editor onto the field it just revealed. This replaced a `Timed`
            switch that sat in the expanded editor beside the number it
            controlled — a second control for a state this glyph already had to
            express, and one you had to expand a row to reach.

            **A duration** (`onStartTimer`): accent. Tapping starts the
            countdown, exactly as it always did.

            The two never compete, because they are the two halves of one
            state: you cannot start a countdown that has no length, and arming
            is meaningless once there is one. Turning it back OFF is clearing
            the field, which is the same route it has always been — deliberately
            NOT a second tap here, because a mis-tap on the row's most-used
            control must never silently delete a prescription.

            It sits beside the tick rather than inside the editor because
            starting a timed set is the thing you do BEFORE the set, one-handed;
            burying it behind a disclosure would cost the tap the countdown
            exists to save. `hitSlop` matches the tick for the same reason both
            are 10: sweaty thumbs, 20 seconds, one hand.
          */
          <Pressable
            onPress={() => {
              if (onStartTimer) {
                onStartTimer();
                return;
              }
              setTimedOn(true);
              onChange(withSetChange(set, { seconds: DEFAULT_TIMER_SECONDS }));
              // Opened, because the whole point of the tap is to produce the
              // field. Arming a duration the athlete cannot see or change would
              // be the control doing half its job.
              setOpen(true);
            }}
            hitSlop={10}
            style={styles.play}
            accessibilityRole="button"
            accessibilityLabel={
              onStartTimer
                ? `Start the timer for ${setName}${set.seconds ? `, ${set.seconds} seconds` : ''}`
                : `Give ${setName} a timer`
            }
            accessibilityHint={onStartTimer ? undefined : 'Adds a countdown you can edit'}
            testID={onStartTimer ? `start-timer-${index}` : `arm-timer-${index}`}
          >
            {/* The kit's timer glyph rather than a play triangle: this is a
                countdown, and a ▶ next to a ✓ reads as "play the set back".
                Dim until the set has a length, so the two states of the one
                control are distinguishable without reading the row. */}
            <Icon name="timer" size={16} color={onStartTimer ? accent.ink : vola.textDim} />
          </Pressable>
        )}
        {editable && (
          // Records the set; starts rest only if "Auto rest timer" is on.
          <Pressable
            onPress={onToggleDone}
            hitSlop={10}
            style={[styles.tick, set.completed && styles.tickDone]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: set.completed }}
            accessibilityLabel={`${setName} done`}
            testID={`done-${index}`}
          >
            <Text style={[styles.tickMark, set.completed && styles.tickMarkDone]}>✓</Text>
          </Pressable>
        )}
        {editable && (
          <Text style={[styles.disclosure, set.completed && styles.disclosureDone]}>
            {open ? '⌃' : '⌄'}
          </Text>
        )}
      </Pressable>

      {open && editable && (
        <View style={styles.setEditor}>
          <View style={styles.fieldRow}>
            {measures.map((m) => {
              const stored = set[MEASURE_KEY[m]] as number | null;
              const label =
                m === 'weight'
                  ? `Weight ${weightUnit(units)}`
                  : m === 'distance'
                    ? distanceInputUnit(units)
                    : m === 'seconds'
                      ? `Time (${durationInputUnit(duration)})`
                      : MEASURE_LABEL[m];
              // Which number to type, at the moment of typing it. Keyed on the
              // EXERCISE's `load_mode`, not on the set's `load_factor`: a
              // one-arm dumbbell row is entered per hand exactly like a
              // dumbbell bench press, and only the bench press doubles.
              //
              // The factor is the exercise's `implements` (migration 000057),
              // which the server applies before this screen sees it — so the
              // total on the row summary answers "how much moved" while this
              // answers "what do I type", and neither has to know the other.
              const hint =
                m === 'weight' && exercise?.load_mode === 'per_side' ? 'per hand' : undefined;
              // Converted for display, converted back on input — the stored
              // value is always kilograms, metres or seconds, whatever is on
              // screen. Duration is the third of those and works exactly like
              // the other two: see lib/duration.ts.
              const shown =
                stored == null
                  ? null
                  : m === 'weight'
                    ? toDisplayWeight(stored, units)
                    : m === 'distance'
                      ? toDisplayDistance(stored, units)
                      : m === 'seconds'
                        ? toDisplayDuration(stored, duration)
                        : stored;
              return (
                <Field
                  key={m}
                  label={label}
                  value={shown}
                  onChangeText={(text) => {
                    const raw = text.trim() === '' ? null : Number(text.replace(',', '.'));
                    if (raw === null || !Number.isFinite(raw)) {
                      onChange(withSetChange(set, { [MEASURE_KEY[m]]: null }));
                      return;
                    }
                    const canonical =
                      m === 'weight'
                        ? fromDisplayWeight(raw, units)
                        : m === 'distance'
                          ? Math.round(fromDisplayDistance(raw, units))
                          : m === 'seconds'
                            ? fromDisplayDuration(raw, duration)
                            : Math.round(raw);
                    onChange(withSetChange(set, { [MEASURE_KEY[m]]: canonical }));
                  }}
                  hint={hint}
                  // A duration in minutes is the second field that takes a
                  // decimal — 1.5 min is 90 seconds, and forcing a whole number
                  // there would make the unit useless for exactly the durations
                  // it exists for.
                  integer={m !== 'weight' && !(m === 'seconds' && duration === 'minutes')}
                  // The hint is spoken, not just shown. It says WHICH number to
                  // type, so a VoiceOver user reaching this field without it is
                  // the one person given no way to know.
                  accessibilityLabel={`${label}${hint ? ` ${hint}` : ''} for ${setName} of ${exerciseName}`}
                  testID={`set-${index}-${m}`}
                />
              );
            })}
          </View>

          {/* N4 — a duration on a set that does not measure one.

              Its own row, below the measures and not among them, because it is
              not a measure: a squat with 40s on it is still a weight×reps set
              for tonnage, records and the fields it offers. `measuresForSet` is
              deliberately untouched. What this writes is a TIMER TARGET, which
              is why the label says so rather than saying "Time" — the field
              above it on a plank means the number being recorded, and these two
              must not look like the same thing.

              `offersTimerTarget` is the gate, and it excludes dual-mode
              exercises as well as ones that already measure seconds — see its
              note. Gating on the row's measures alone put this field on a
              burpee set in reps mode, where writing a duration silently flips
              the row to time mode.

              **The relationship with the row's clock inverted.** It used to
              read "setting this is what makes the play button appear"; the
              clock is now what puts this field here in the first place, and a
              duration is what turns that same clock from arm into start. What
              is unchanged is the other end: a duration is what lets the set
              join a hands-free run (`canRun`), the circuits N4 exists for, and
              clearing this back to empty takes both away again — still the
              intended undo, and now the ONLY route back, since the clock
              deliberately does not toggle off. */}
          {offersTimerTarget(exercise?.load_type) && (
            <View style={styles.fieldRow}>
              {/* No switch beside it any more — the row's clock is what puts
                  this here, and a second control for the same state was one
                  the athlete had to expand a row to reach. So this is an
                  ordinary field row like the measures above it, which is what
                  it now is. */}
              {timed && (
                <View style={styles.timedField}>
                  <Field
                    label={`Timer (${durationInputUnit(duration)})`}
                    // The one thing about this field an athlete cannot work out
                    // from the screen, and the distinction N4 was built around:
                    // on a plank seconds are the MEASUREMENT, here they are a
                    // TARGET, and stopping early does not rewrite the number.
                    // It carried a hold-for-info panel until the switch that
                    // opened it was removed; four words in the label is a
                    // better home for it than a panel nothing pointed at.
                    hint="target"
                    value={set.seconds == null ? null : toDisplayDuration(set.seconds, duration)}
                    onChangeText={(text) => {
                      // Three outcomes, and the third — write nothing — is what
                      // makes `0.5` typeable in minutes mode. See its note.
                      const edit = timerTargetEdit(text, duration);
                      if (edit.write) onChange(withSetChange(set, { seconds: edit.seconds }));
                    }}
                    integer={duration !== 'minutes'}
                    // Built from the unit-bearing label, exactly as the measure
                    // fields above are. Without the unit a VoiceOver user in
                    // minutes mode hears "Timer" and has no way to know that 1.5
                    // means ninety seconds.
                    accessibilityLabel={`Timer in ${
                      duration === 'minutes' ? 'minutes' : 'seconds'
                    } for ${setName} of ${exerciseName}`}
                    testID={`set-${index}-timer`}
                  />
                </View>
              )}
            </View>
          )}

          {/* Who did the work. Offered only where there ARE reps, because
              "3 of them were assisted" is meaningless on a plank or a run —
              and the database refuses assisted reps without a rep count, so an
              always-present field would be a control that can produce a 400.

              Its own row rather than beside the measures: it is a claim ABOUT
              the reps in the field above, and putting it in the same row reads
              as another measure of the set. */}
          {set.reps != null && (
            <View style={styles.fieldRow}>
              <Field
                label="Assisted"
                value={set.assisted_reps ?? null}
                onChangeText={(text) => {
                  const t = text.trim();
                  if (t === '') {
                    // Cleared means UNRECORDED, not zero. Sending 0 would
                    // assert the set was unaided, which is a different claim
                    // and one nobody made by deleting a number.
                    onChange({ ...set, assisted_reps: null });
                    return;
                  }
                  const raw = Number(t.replace(',', '.'));
                  if (!Number.isFinite(raw)) {
                    onChange({ ...set, assisted_reps: null });
                    return;
                  }
                  // Clamped to the reps performed rather than rejected: the
                  // server and the CHECK both refuse more help than reps, and
                  // a typo mid-set should not cost a failed save. Clamping at
                  // the edit is the only place it can be fixed silently and
                  // still be true.
                  const capped = Math.max(0, Math.min(Math.round(raw), set.reps ?? 0));
                  onChange({ ...set, assisted_reps: capped });
                }}
                hint={
                  set.assisted_reps != null && set.assisted_reps > 0
                    ? `${soloReps(set)} on your own`
                    : 'Reps with help'
                }
                integer
                accessibilityLabel={`Reps completed with help on ${setName} of ${exerciseName}`}
                testID={`set-${index}-assisted`}
              />
            </View>
          )}

          {/* Effort, side by side. Two views of the same thing — record
              whichever you think in rather than converting mid-session.
              Hidden entirely when effort tracking is off: greying the
              fields out would still cost the space and still read as
              something you're failing to fill in. */}
          {showEffort && (
          <View style={styles.fieldRow}>
            <Field
              label="RIR"
              value={set.rir}
              onChangeText={num('rir', true)}
              hint="Reps left"
              integer
              accessibilityLabel={`Reps in reserve for ${setName} of ${exerciseName}`}
              testID={`set-${index}-rir`}
            />
            <Field
              label="RPE"
              value={set.rpe}
              onChangeText={num('rpe')}
              hint="1–10"
              accessibilityLabel={`RPE for set ${ordinal} of ${exerciseName}`}
              testID={`set-${index}-rpe`}
            />
          </View>
          )}

          {/*
            Type and grip on ONE line, because they are two short answers about
            the same set rather than two sections of it. Stacked, they cost two
            full rows of an editor that already carries four fields; and each
            expanding in place pushed everything below it — including the other
            one — down under the athlete's thumb mid-tap. `OptionSelect` opens
            over itself instead, so the editor never reflows.
          */}
          <View style={styles.selects}>
            <OptionSelect
              label="Type"
              options={SET_TYPES}
              selected={set.set_type}
              // Never null — the control is not `clearable`, so the only value
              // it can emit is one of its own keys. The cast is the price of a
              // component that also serves grips, where null is a real answer.
              onSelect={(key) => onChange({ ...set, set_type: key as SetType })}
              guideFor={setTypeGuide}
              context={`${setName} of ${exerciseName}`}
              testID={`set-${index}-type`}
            />
            {/* How the bar was held.
              Which values are offered depends on the movement — `gripsFor`
              is the list, and it SUBSTITUTES rather than extends: a hinge does
              not get the four plus two, it gets its own four. Read that
              function; enumerating it here is what made this comment wrong
              twice. Squats, jumps and conditioning get nothing, because the
              question is meaningless there rather than merely hard to
              answer.

              Gated on the OFFER's length, never on the subset's. They differ in
              exactly one case and it is the one that traps data: a set holding
              a grip on a movement whose subset is empty — an exercise the
              console re-categorised after it was logged, or a pattern a newer
              server grew. The subset is empty there, so gating on it hides the
              row — and the grip is then
              visible in the summary line with no chip to tap, so the single
              route back to "unrecorded" is gone.

              Tapping the selected chip clears it, which is that route. Without
              it a mis-tap is permanent — and unrecorded is a real state here,
              not an absence. */}
            {offeredGrips(exercise, set.grip).length > 0 && (
              <OptionSelect
                label="Grip"
                options={offeredGrips(exercise, set.grip)}
                selected={set.grip ?? null}
                clearable
                emptyLabel="Not recorded"
                onSelect={(key) => onChange({ ...set, grip: key as Grip | null })}
                guideFor={gripGuide}
                context={`${setName} of ${exerciseName}`}
                testID={`set-${index}-grip`}
              />
            )}
          </View>

          <Pressable
            onPress={onRemove}
            style={styles.removeButton}
            accessibilityRole="button"
            accessibilityLabel={`Remove set ${ordinal}`}
            testID={`set-${index}-remove`}
          >
            <Text style={styles.removeText}>Remove set</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/**
 * A numeric field that keeps what you typed.
 *
 * Driving the input straight off the parsed number made a decimal weight
 * impossible to enter: typing "72." parses to 72, re-renders the value as
 * "72", and eats the point — on an app whose primary flow is 2.5 kg jumps.
 * So the raw string is the input's state, and the number is only derived from
 * it. An externally-changed value (a reload, or carry-forward from the
 * previous set) is still adopted, but never at the cost of rewriting a
 * half-typed number.
 */
function Field({
  label,
  value,
  onChangeText,
  hint,
  integer,
  accessibilityLabel,
  testID,
}: {
  label: string;
  value: number | null;
  onChangeText: (t: string) => void;
  hint?: string;
  integer?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const [text, setText] = useState(() => value?.toString() ?? '');
  const lastSeen = useRef(value);
  const inputRef = useRef<TextInput>(null);
  const ensureVisible = useEnsureVisible();

  if (value !== lastSeen.current) {
    lastSeen.current = value;
    const typed = text.trim() === '' ? null : Number(text.replace(',', '.'));
    // Only overwrite when the field doesn't already say this number — so a
    // save echoing back "102.5" doesn't interrupt someone typing "102.55".
    if (typed !== value) setText(value?.toString() ?? '');
  }

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>
        {label}
        {hint ? <Text style={styles.fieldHint}> {hint}</Text> : null}
      </Text>
      <TextInput
        ref={inputRef}
        // Lifts this field above the keyboard. Measured on focus rather than
        // computed from a row index, because rows differ in height by
        // exercise and by whether they are expanded.
        onFocus={() => ensureVisible(inputRef.current)}
        /*
          On blur, the field says what is STORED — the one moment it is safe to
          overwrite what was typed, because typing is over.

          While a field has focus it deliberately keeps its own text, so that a
          half-typed `72.` is not eaten and so that an entry the store refuses
          (the timer's `0`, on its way to `0.5`) survives to its next keystroke.
          The cost is that an ABANDONED entry leaves the two disagreeing: type
          `0` over a stored 60, walk away, and the box reads 0 while the row
          still carries a 60-second countdown that will arm the play button and
          sync. On this screen — one hand, twenty seconds between sets —
          abandoning a half-typed number is ordinary, not exotic.

          Re-deriving here costs nothing anyone can perceive and makes the
          visible number true again. It is not a commit: nothing is written, the
          field simply stops claiming something the set does not hold.
        */
        onBlur={() => setText(value?.toString() ?? '')}
        style={styles.fieldInput}
        // decimal-pad rather than numeric: reps are whole, weight isn't, and
        // the keypad should offer the point where it's meaningful.
        keyboardType={integer ? 'number-pad' : 'decimal-pad'}
        inputMode={integer ? 'numeric' : 'decimal'}
        accessibilityLabel={accessibilityLabel ?? label}
        value={text}
        onChangeText={(t) => {
          setText(t);
          onChangeText(t);
        }}
        placeholder="—"
        placeholderTextColor={vola.textDim}
        selectTextOnFocus
        testID={testID}
      />
    </View>
  );
}

/**
 * Measure NAMES, deliberately carrying no unit.
 *
 * `weight` read `Weight kg` and `distance` read `Metres`, which were dead
 * defaults: the only call site resolves those two from the athlete's
 * preference itself and falls through to this table for `reps` alone. A unit
 * baked into an unused default is how the wrong one eventually gets rendered,
 * so the names are unit-free and the units are resolved where they are known.
 */
const MEASURE_LABEL: Record<Measure, string> = {
  reps: 'Reps',
  weight: 'Weight',
  seconds: 'Seconds',
  distance: 'Distance',
};
const MEASURE_KEY: Record<Measure, keyof LoggedSet> = {
  reps: 'reps',
  weight: 'weight_kg',
  seconds: 'seconds',
  distance: 'distance_m',
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  // N508 — horizontal padding moves from its own 16 to `Spacing.gutter` (20):
  // Strength was the other screen (alongside Running, before that ticket)
  // disagreeing with Plan/Progress/BJJ's 20pt gutter. Vertical top padding
  // stays 16 (`Spacing.lg`) — only the acceptance criterion's shared GUTTER
  // moves, not this screen's own top clearance.
  scroll: {
    paddingHorizontal: Spacing.gutter,
    paddingTop: Spacing.lg,
    gap: Spacing.cardPadding,
    paddingBottom: Spacing.xxxl,
  },
  /**
   * One exercise, as a card.
   *
   * It used to be a bare stack separated from the next by an 8pt gap, which is
   * the same gap that sits between the set rows *inside* it — so where one
   * movement ended and the next began was carried entirely by a name in bold.
   * Mid-session, glancing down between sets, that is not enough: the question
   * is "which block am I in", and a boundary should be a shape.
   *
   * Deliberately restrained. This screen is used standing up, one-handed, with
   * twenty seconds to spare, so it gets *less* decoration than Today rather
   * than more — a border and a ground, no edge stripe, no icon disc. A sport
   * rule would be redundant here anyway: every exercise on this screen belongs
   * to the same session.
   */
  group: {
    gap: Spacing.sm,
    // A border and padding, and deliberately NO fill.
    //
    // The first version filled the card with `surface` and stepped the set
    // rows up to `surfaceRaised`. Both halves of that were wrong. The step is
    // 1.09:1 — the history log already records that exact pair as invisible,
    // so it bought nothing — and filling the card cost something real: the
    // done-row tint is solved *against `surface`*, so putting rows on
    // `surfaceRaised` took done-versus-undone from 1.46:1 to 1.34:1, most of
    // the margin that justified 15% over the rejected 10%. Re-tinting cannot
    // recover it: lime@15% re-solved over `surfaceRaised` drops `textMuted`
    // to 4.17:1, under the 4.5 the original tuning was held to.
    //
    // So the boundary is a line, not a ground, and every figure recorded in
    // `Colors.ts` stays true. `line` rather than `lineSoft` because this sits
    // on the page rather than on a card. **N508 does not add `Card.base` or
    // the glass wash here** — both bundle a `backgroundColor`, and the whole
    // point of this comment is that a fill on this box costs real contrast
    // margin. `Radius.card` is safe to take (a corner radius carries none of
    // that math): it moves this card's radius from its own 16 to the 14 every
    // other converted screen's primary card now shares, which is this
    // ticket's actual acceptance criterion — the fill exemption is unrelated
    // to the radius one.
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.card,
    padding: Spacing.md,
  },
  // Wraps rather than overflows: the header carries the name plus up to four
  // per-set chips (rest, mode, duration unit, weight unit — "run" joins them
  // only mid-workout) beside a name that can be long ("Barbell Bulgarian
  // Split Squat"). On a narrow phone they drop to a second line instead of
  // squeezing the name to an ellipsis or pushing the last chip off-screen.
  // `groupName` keeps flex:1 so it still takes the slack on a wide screen.
  //
  // Reorder/swap/remove used to live on this same row — see `groupActions`
  // below for why they moved.
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    rowGap: Spacing.sm,
    columnGap: Spacing.smPlus,
  },
  groupName: { flex: 1, minWidth: 140, fontSize: 16, fontWeight: '700' },
  // The structural row below the name: reorder, swap, remove. Left-aligned
  // and wrapping independently of `groupHead`, so a long name pushing the
  // per-set chips to a second line does not also reflow these.
  groupActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    rowGap: Spacing.xs,
    columnGap: Spacing.cardPadding,
  },
  // `textMuted`, matching Rest/Time/the unit chips — see the `groupActions`
  // comment at the call site for why this is no longer `accent.ink`.
  swapText: {
    ...Typography.meta,
    fontWeight: '600',
    color: vola.textMuted,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xs,
  },
  restChip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    minHeight: 32,
    justifyContent: 'center',
  },
  restChipText: { ...Typography.caption, fontWeight: '700', color: vola.textMuted },
  unitChip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.smPlus,
    minHeight: 32,
    justifyContent: 'center',
  },
  unitChipText: { ...Typography.caption, fontWeight: '700', color: vola.textMuted },
  modeChip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.pill,
    paddingHorizontal: 11,
    minHeight: 32,
    justifyContent: 'center',
  },
  modeChipText: { ...Typography.caption, fontWeight: '700', color: vola.textMuted },
  runChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 11,
    minHeight: 32,
  },
  runChipText: { ...Typography.caption, fontWeight: '700' },
  // The one glass card on this screen — `group`'s own comment explains why
  // IT stays fill-less; this banner already had a fill, so it's the one that
  // takes the wash (`<CardGlass />` at its JSX call site). Radius unified to
  // `Radius.card` (was its own 16). Border colour stays the accent override
  // at the call site (`{ borderColor: accent.accent }`, applied after this
  // base style so it still wins) — deliberately NOT the settled `vola.line`,
  // since this banner marks itself as the active guidance, not a generic
  // card.
  guided: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderWidth: 1,
    borderRadius: Radius.card,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.cardPadding,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.cardPadding,
    backgroundColor: vola.surface,
    overflow: 'hidden',
  },
  guidedBody: { flex: 1, backgroundColor: 'transparent' },
  guidedTitle: { ...Typography.emphasis, fontWeight: '700' },
  guidedSub: { ...Typography.caption, color: vola.textMuted, marginTop: Spacing.xxs },
  moveChip: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: vola.surfaceRaised,
  },
  // Dimmed rather than removed at the ends. Hiding it slid the other arrow
  // into the spot just tapped, so the second tap of a two-step move undid the
  // first — and it made the control vanish for screen readers instead of
  // announcing itself as unavailable. It also keeps the header geometry the
  // same down the whole screen.
  moveChipOff: { opacity: 0.35 },
  moveChipText: { ...Typography.emphasis, fontWeight: '700', color: vola.textMuted },
  // `danger`, not `textDim`: textDim measured 3.96:1 on the screen background
  // at 13px (needs 4.5), and this control is destructive, so the colour should
  // say so. Padded to a 44pt target rather than relying on hitSlop alone.
  removeGroupText: {
    ...Typography.meta,
    fontWeight: '600',
    color: vola.danger,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xs,
  },
  setRow: { backgroundColor: vola.surface, borderRadius: Radius.md },
  // The whole row, not just the tick: a column of rows is scanned by shape
  // and colour, and a 20px checkmark is not what the eye lands on.
  setRowDone: { backgroundColor: vola.setDone },
  // textDim measures 2.51:1 on the done tint; textMuted is 4.67:1. See the
  // setDone note in constants/Colors.ts.
  setOrdinalDone: { color: vola.textMuted },
  // Same 2.51:1 on the done tint that moved the ordinal.
  disclosureDone: { color: vola.textMuted },
  setHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.md },
  setOrdinal: { width: 34, fontWeight: '700', color: vola.textDim },
  setBadge: { color: vola.lime, fontSize: Typography.eyebrow.fontSize, fontWeight: '700' },
  setSummary: { flex: 1, fontSize: Typography.emphasis.fontSize },
  // Same disc as the tick beside it — two controls of equal weight on one
  // row, sized for a thumb rather than a cursor.
  play: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tick: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickDone: { backgroundColor: vola.lime, borderColor: vola.lime },
  tickMark: { color: vola.textDim, fontWeight: '800', fontSize: Typography.emphasis.fontSize },
  tickMarkDone: { color: vola.navy },
  disclosure: { color: vola.textDim, width: 16, textAlign: 'center' },
  setEditor: { padding: Spacing.md, paddingTop: 0, gap: Spacing.md },
  fieldRow: { flexDirection: 'row', gap: Spacing.smPlus },
  field: { flex: 1, gap: Spacing.xs },
  fieldLabel: { ...Typography.caption, color: vola.textMuted },
  fieldHint: { color: vola.textDim, fontSize: Typography.eyebrow.fontSize },
  fieldInput: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.smPlus,
    paddingVertical: Spacing.smPlus,
    fontSize: 17,
    color: vola.text,
    backgroundColor: vola.bg,
    textAlign: 'center',
  },
  // The switch and its field on one line, baseline-agnostic: `Field` carries a
  // label above the input, so `alignItems: 'flex-end'` is what puts the pill
  // level with the input rather than with the label.
  timedField: { flex: 1 },
  // Two short answers on one line. `alignItems: 'flex-start'` so a control
  // without a sibling does not stretch to a height it has no content for.
  selects: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.smPlus },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.smPlus,
    backgroundColor: vola.surfaceRaised,
    borderRadius: Radius.md,
    paddingVertical: Spacing.smPlus,
    paddingHorizontal: Spacing.md,
  },
  hintBody: { flex: 1, gap: Spacing.xxs },
  hintPhaseRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xsPlus },
  hintDot: { width: 7, height: 7, borderRadius: Radius.pill },
  hintPhase: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: vola.text },
  hintPips: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: Spacing.xxs },
  hintPip: { width: 6, height: 6, borderRadius: Radius.pill },
  hintRangeText: { fontSize: 10, color: vola.textMuted, fontVariant: ['tabular-nums'] },
  hintTarget: {
    ...Typography.title,
    color: vola.text,
    fontVariant: ['tabular-nums'],
  },
  hintLast: {
    fontSize: Typography.caption.fontSize,
    color: vola.textMuted,
    fontVariant: ['tabular-nums'],
  },
  /*
    The colour is set EXPLICITLY, and it has to be.

    `Text` here is `@/components/Themed`'s, which renders
    `<DefaultText style={[{ color }, style]}>` — so every nested Text is handed
    a full-contrast `color` before its own style is applied. Relying on
    inheritance from the muted parent therefore does the opposite of what it
    looks like: the rating renders at 11.5:1 inside a 4.67:1 line and becomes
    the BRIGHTEST number on it, which is the hierarchy this change exists to
    build, inverted. Caught in review; the first version of this comment
    confidently claimed the colour was inherited.

    `textMuted`, not `textDim`: `constants/Colors.ts` measures dim at 2.51:1 and
    says outright it is not used to carry information, and the rating is
    information. Italic alone separates it from the upright measurement. Same
    values `RecordsCard` uses, so the two screens teach one convention.
  */
  hintReported: { color: vola.textMuted, fontStyle: 'italic' },
  // `fontSize`-only (not the full `caption` role) on these three: `caption`
  // bundles a 600 weight, and each of these is deliberately the LOW end of
  // this card's hierarchy — see the comment above and N191's own note below.
  // Bolding them would work against the exact hierarchy those comments argue
  // for.
  hintReason: { fontSize: Typography.caption.fontSize, color: vola.textMuted },
  // N191's in-session note — deliberately NOT `hintReason`'s muted tone. It's
  // an FYI the standing prescription above hasn't seen, and reads as one:
  // `vola.text`, the app's primary colour (already load-bearing elsewhere
  // in this file), rather than a second muted line easy to skim past.
  hintInSession: {
    fontSize: Typography.caption.fontSize,
    color: vola.text,
    fontStyle: 'italic',
    marginTop: Spacing.xxs,
  },
  hintApply: {
    borderRadius: Radius.pill,
    paddingVertical: Spacing.smPlus,
    paddingHorizontal: Spacing.cardPadding,
    minHeight: 44,
    justifyContent: 'center',
  },
  hintApplyText: { ...Typography.body, color: vola.navy, fontWeight: '700' },
  /*
    Both buttons share the row EVENLY (`flex: 1` on each), rather than each
    shrink-wrapping its own two words. Sized by their labels, "+ Set" and
    "+ Drop" came out different widths, left-aligned in a full-width row, and
    read as two fragments of a broken control rather than a pair of choices —
    which is what they are. Even halves, or one full-width button when the drop
    is not offered, is the only arrangement that says that.
  */
  addRow: { flexDirection: 'row', alignItems: 'stretch', gap: Spacing.sm },
  // Indented and rule-marked, so a drop reads as hanging off the row above
  // rather than sitting beside it. The accent is deliberately NOT used: a drop
  // is not an achievement, and this app reserves the accent for what was
  // earned.
  setRowDrop: {
    marginLeft: 22,
    borderLeftWidth: 2,
    borderLeftColor: vola.line,
    paddingLeft: Spacing.sm,
  },
  addSet: {
    flex: 1,
    borderWidth: 1,
    /*
      SOLID, and this is the actual fix rather than a taste change. iOS renders
      `borderStyle: 'dashed'` together with a `borderRadius` by falling back to
      an unrounded, unevenly-dashed box — the corners square off and the dash
      phase restarts per edge, which is the ragged outline in the report. RN has
      never supported the combination on iOS; it is not a value that can be
      tuned. A filled surface with a hairline reads as "another one of these"
      just as well as a dashed one, and it matches `styles.primary` directly
      below it.
    */
    borderColor: vola.line,
    backgroundColor: vola.surface,
    borderRadius: Radius.md,
    // 44 is the floor, not the target: these are pressed with a thumb, standing
    // up, between sets.
    minHeight: 44,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addSetText: { ...Typography.body, fontWeight: '700' },
  primary: {
    backgroundColor: vola.surfaceRaised,
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  primaryText: { ...Typography.emphasis, fontWeight: '700' },
  // N445 — `finish` sits in ordinary scroll content now, not a pinned
  // `KeyboardAwareFooter` sibling (see that block's own comment for why the
  // footer was reverted). `finishSection` is the content-block equivalent of
  // the old footer's padding: a hairline rather than a filled ground, same
  // reasoning as before — the screen behind it is already themed, and a
  // full-width fill would read as a second surface competing with the card
  // boundaries above it. No bottom safe-area padding is needed any more:
  // this is one more scrollable item, not a screen-edge control, so the
  // scroll view's own `contentContainerStyle` padding is what clears the
  // home indicator, exactly as it does for every other item in this list.
  //
  // `borderTopColor: vola.lineSoft` is untouched by N508's border-colour
  // settlement — that settlement is specifically about a CARD's own edge;
  // this is a plain content divider, the role `lineSoft` keeps everywhere
  // else in this app.
  finishSection: {
    marginTop: Spacing.gutter,
    paddingTop: Spacing.smPlus,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.lineSoft,
  },
  finish: {
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  finishText: { color: vola.navy, fontWeight: '700', fontSize: 16 },
  empty: { alignItems: 'center', gap: Spacing.xsPlus, paddingVertical: Spacing.xl },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  muted: { ...Typography.meta, color: vola.textMuted, textAlign: 'center' },
  share: { marginTop: Spacing.md },
  // N435 — "Done editing" reuses `primary`'s shape but marks itself as the
  // active state with an accent border, the same way `guided`'s border does.
  // A filled accent background would compete with Finish for the one loud
  // control on this screen; a border says "you are here" without it.
  correctToggle: { backgroundColor: 'transparent', borderWidth: 1 },
  error: { ...Typography.body, color: vola.danger },
  deleteButton: { alignItems: 'center', paddingVertical: Spacing.lg, marginTop: Spacing.sm },
  deleteText: { color: vola.danger, fontWeight: '600' },
  removeButton: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  removeText: { ...Typography.meta, fontWeight: '600', color: vola.danger },
});
