import { useAuth } from '@clerk/clerk-expo';
import { request as requestSync } from '@/lib/sync';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { RestTimerBar, useRestTimer } from '@/components/RestTimer';
import { Text, View } from '@/components/Themed';
import { useAuthToken } from '@/lib/useAuthToken';
import { vola } from '@/constants/Colors';
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
import { report } from '@/lib/report';
import {
  describeSet,
  emptySet,
  fetchSuggestions,
  fillForward,
  measuresFor,
  reorderGroups,
  SET_TYPES,
  type LoggedSet,
  type Measure,
  type Session,
  type SetType,
  type Suggestion,
  type SuggestionCode,
  type Volume,
} from '@/lib/sessions';
import { getWorkout } from '@/lib/workouts';

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
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  // The sets are held locally rather than read off `session`, because the
  // server's copy arrives asynchronously and would otherwise overwrite
  // whatever's being typed at the moment a save lands.
  const [sets, setSets] = useState<LoggedSet[]>([]);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [suggestions, setSuggestions] = useState<Map<string, Suggestion>>(new Map());
  // The workout's goal, resolved once. Immutable for the life of a session,
  // and `load` re-runs on every focus.
  const goalRef = useRef<{ workoutID: string | null; goal: string | null }>({
    workoutID: null,
    goal: null,
  });
  const timerState = useRestTimer();
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
  const { units, unitsReady } = useUnits();
  // Per-exercise overrides: a lifter who thinks in kilograms still faces a
  // leg press marked in pounds, and converting in your head at the moment
  // you're trying to record a number is exactly what this avoids.
  const [exerciseUnits, setExerciseUnits] = useState<Record<string, UnitSystem>>({});
  // Off unless asked for — see PREF_AUTO_REST for why that's the default.
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
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const queued = useRef<LoggedSet[] | null>(null);

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
      //
      // The workout's goal picks the rep range the rule progresses inside, so
      // this is fetched even though it costs a request: without it a mobile
      // session would advance on the general 5-8 range while web advanced the
      // same session on 3-5, and the two clients would quietly disagree about
      // what the athlete is doing.
      (async () => {
        let goal: string | null = null;
        if (s.workout_id) {
          // Resolved once per session, not once per focus. `load` runs under
          // useFocusEffect, so it re-fires every time you come back from the
          // exercise picker or the rest timer — and a workout's goal cannot
          // change mid-session, so re-fetching it is pure waste.
          //
          // The cache is consulted first and is usually enough: the plan is
          // already on the phone, and since schema v6 it carries the goal.
          // That also makes this work with no signal at all, where the
          // network path would silently fall back to the general rep range.
          if (goalRef.current.workoutID === s.workout_id) {
            goal = goalRef.current.goal;
          } else {
            const local = (await cachedWorkouts(userId, s.sport).catch(() => []))
              .find((w) => w.id === s.workout_id);
            // Advisory: a template deleted since must not stop the
            // suggestions appearing, it just costs the narrower range.
            goal =
              local?.goal ??
              (await getWorkout(getToken, s.workout_id)
                .then((w) => w.goal)
                .catch(() => null));
            goalRef.current = { workoutID: s.workout_id, goal };
          }
        }
        setSuggestions(
          await fetchSuggestions(
            getToken,
            s.sets.map((x) => x.exercise_id),
            goal,
          ),
        );
      })().catch(() => {});

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
  }, [getToken, id, userId]);

  // Runs on mount and again on every return from the exercise picker, which
  // appends its set server-side — without this the new set wouldn't appear.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
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
    commit(
      [
        ...sets.slice(0, afterIndex + 1),
        emptySet(exerciseID, afterIndex + 1, sets[afterIndex]),
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
      ? fillForward(marked, index, measuresFor(catalog.get(exerciseID)?.load_type ?? 'reps'))
      : marked;
    commit(next);
    if (now && autoRest) startRest(exerciseID);
  }

  /**
   * Starts rest for one exercise, at that exercise's own duration.
   *
   * The duration is per exercise and editable — a triple on a heavy squat
   * and a set of lateral raises are not the same wait, and the movement
   * pattern's default is a starting point rather than an answer.
   */
  async function startRest(exerciseID: string) {
    const ex = catalog.get(exerciseID);
    const seconds = userId ? await readRestSeconds(userId, ex, exerciseID) : 90;
    timerState.start(seconds, ex?.name ?? 'Rest', exerciseID);
  }

  function removeSet(index: number) {
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
  // rather than making someone re-pick the exercise for every set.
  const groups: { exerciseID: string; indices: number[] }[] = [];
  sets.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && last.exerciseID === s.exercise_id) last.indices.push(i);
    else groups.push({ exerciseID: s.exercise_id, indices: [i] });
  });


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
    if (next) commit(next);
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

  return (
    <View style={styles.container} testID="session-screen">
      <Stack.Screen
        options={{
          title: session.name || 'Session',
          headerRight: () =>
            saving ? <ActivityIndicator accessibilityLabel="Saving" /> : null,
        }}
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {/* Three numbers while you train — time, sets, reps — and volume
            on top once you finish.
            "Top RPE" is gone entirely: mid-session it only repeated the
            effort typed thirty seconds earlier. Both are still computed by
            the API; they're real data for the trends screen, just not worth
            a permanent slot in a header read between sets. */}
        {volume && (
          <View style={styles.summary}>
            <Stat label="Time" value={formatElapsed(elapsed)} />
            <Stat label="Sets" value={String(volume.working_sets)} />
            <Stat label="Reps" value={String(volume.total_reps)} />
            {/* Volume is a result, not a readout. Mid-session it's a
                number nobody acts on — you don't change the next set
                because the running total crossed 1,500kg — so it appears
                once the session is done and the figure means something. */}
            {finished && (
              <Stat
                label="Volume"
                value={
                  unitsReady && volume.tonnage_kg > 0
                    ? formatVolume(volume.tonnage_kg, units)
                    : '—'
                }
              />
            )}
          </View>
        )}

        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite" testID="session-error">
            {error}
          </Text>
        )}

        {groups.map((g, gi) => {
          const exercise = catalog.get(g.exerciseID);
          return (
            <View key={g.exerciseID + g.indices[0]} style={styles.group}>
              <View style={styles.groupHead}>
                <Text style={styles.groupName}>{exercise?.name ?? g.exerciseID}</Text>
                {/* Order and removal live on the exercise, not on a set:
                    "the rack is taken, do legs first" moves a movement and
                    everything logged under it. Buttons rather than a drag
                    handle — a long-press-and-drag is a poor bet with one hand
                    and a bar to get back to, and it fights the scroll view.
                    Hidden at the ends rather than disabled, so there is no
                    dead target to aim at between sets. */}
                {!finished && (
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
                )}
                {!finished && (
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
                )}
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
                {!finished && (
                  <Pressable
                    onPress={() => toggleUnitFor(g.exerciseID)}
                    hitSlop={10}
                    style={styles.unitChip}
                    accessibilityRole="button"
                    accessibilityLabel={`${exercise?.name ?? 'This exercise'} is in ${
                      unitFor(g.exerciseID) === 'imperial' ? 'pounds' : 'kilograms'
                    }. Switch.`}
                    testID={`unit-${g.exerciseID}`}
                  >
                    <Text style={styles.unitChipText}>{weightUnit(unitFor(g.exerciseID))}</Text>
                  </Pressable>
                )}
                {!finished && (
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
                )}
                {!finished && (
                  <Pressable
                    onPress={() => removeGroup(gi)}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${exercise?.name ?? 'this exercise'} from this session`}
                    testID={`remove-group-${g.exerciseID}`}
                  >
                    <Text style={styles.removeGroupText}>Remove</Text>
                  </Pressable>
                )}
              </View>
              {g.indices.map((i, n) => (
                <SetRow
                  key={i}
                  index={i}
                  ordinal={n + 1}
                  set={sets[i]}
                  exercise={exercise}
                  editable={!finished}
                  onChange={(next) => update(i, next)}
                  onRemove={() => removeSet(i)}
                  onToggleDone={() => toggleDone(i, g.exerciseID)}
                  showEffort={showEffort}
                  units={unitFor(g.exerciseID)}
                />
              ))}
              {(() => {
                const hint = suggestions.get(g.exerciseID);
                if (!hint || hint.code === 'not_applicable') return null;
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
                const pending = g.indices.filter(
                  (i) => !sets[i]?.completed && sets[i]?.set_type !== 'warmup',
                );
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
                      {hint.last_weight_kg != null && (
                        <Text style={styles.hintLast}>
                          Last {hint.last_reps != null ? `${hint.last_reps} × ` : ''}
                          {formatWeight(hint.last_weight_kg, u)}
                          {hint.last_rir != null ? ` · ${hint.last_rir} RIR` : ''}
                          {hint.last_rir == null && hint.last_rpe != null
                            ? ` · RPE ${hint.last_rpe}`
                            : ''}
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
                                    ...(reps != null ? { reps } : {}),
                                  }
                                : st,
                            ),
                          );
                        }}
                        style={styles.hintApply}
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

              {!finished && (
                <Pressable
                  style={styles.addSet}
                  onPress={() => addSet(g.exerciseID, g.indices[g.indices.length - 1])}
                  accessibilityRole="button"
                  accessibilityLabel={`Add another set of ${exercise?.name ?? 'this exercise'}`}
                  testID={`add-set-${g.exerciseID}`}
                >
                  <Text style={styles.addSetText}>+ Set</Text>
                </Pressable>
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

        {!finished ? (
          <Pressable
            style={styles.finish}
            onPress={async () => {
              try {
                await flush(); // the last set typed must land before the session closes
                await finishLocalSession(userId!, id!);
                const s = await readLocalSession(userId!, id!);
                if (s) {
                  setSession(s);
                  setSets(s.sets);
                  setVolume(localVolume(s.sets));
                }
                requestSync('session-finished');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
            accessibilityRole="button"
            testID="session-finish"
          >
            <Text style={styles.finishText}>Finish session</Text>
          </Pressable>
        ) : (
          <Text style={styles.muted}>Finished — this session is read-only.</Text>
        )}

        <Pressable
          onPress={() =>
            Alert.alert('Delete session?', "This can't be undone.", [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  try {
                    // Writes a tombstone (or hard-deletes a session the
                    // server never saw). The delete travels out through the
                    // ordinary push path, so there is no fire-and-forget
                    // DELETE here any more — that one both raced the push and
                    // was silently lost whenever it failed, which offline was
                    // always.
                    await deleteLocalSession(userId!, id!);
                    requestSync('session-deleted');
                    router.back();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                },
              },
            ])
          }
          style={styles.deleteButton}
          accessibilityRole="button"
        >
          <Text style={styles.deleteText}>Delete session</Text>
        </Pressable>
      </ScrollView>

      {timerState.rest && (
        <RestTimerBar
          rest={timerState.rest}
          remaining={timerState.remaining}
          onAdjust={(delta) => {
            timerState.adjust(delta);
            // Adjusting is how you tell the app this exercise needs a
            // different wait — so it sticks, rather than being redone
            // every set.
            const ex = timerState.rest?.exerciseID;
            if (userId && ex) {
              writeRestSeconds(userId, ex, (timerState.rest?.total ?? 90) + delta).catch(() => {});
            }
          }}
          onTogglePause={timerState.togglePause}
          onStop={timerState.stop}
        />
      )}
    </View>
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
  add_load: { label: 'ADD LOAD', color: vola.lime },
  add_reps: { label: 'ADD A REP', color: vola.green },
  deload: { label: 'DELOAD', color: vola.warn },
  hold: { label: 'HOLD', color: vola.textMuted },
  repeat_hard: { label: 'REPEAT', color: vola.warn },
  repeat_stale: { label: 'RESTART', color: vola.textMuted },
  repeat_unknown_effort: { label: 'LOG EFFORT', color: vola.textMuted },
  no_history: { label: 'FIRST TIME', color: vola.textMuted },
  not_applicable: { label: '', color: vola.textMuted },
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

function localVolume(sets: LoggedSet[]): Volume {
  const v: Volume = {
    working_sets: 0,
    total_reps: 0,
    tonnage_kg: 0,
    hardest_rpe: 0,
    exercise_ids: [],
  };
  for (const s of sets) {
    if (!v.exercise_ids.includes(s.exercise_id)) v.exercise_ids.push(s.exercise_id);
    // Must match the server's rule exactly. Missing this on the first pass
    // showed the plan's full volume against a column of unticked sets —
    // precisely the drift this duplicated arithmetic risks.
    if (!s.completed) continue;
    if (s.set_type === 'warmup') continue;
    v.working_sets++;
    if (s.rpe != null && s.rpe > v.hardest_rpe) v.hardest_rpe = s.rpe;
    if (s.reps != null) {
      v.total_reps += s.reps;
      if (s.weight_kg != null) v.tonnage_kg += s.reps * s.weight_kg;
    }
  }
  return v;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      {/* Four-figure volume wrapped onto a second line and shoved its own
          label out of the row; shrink to fit instead. */}
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function SetRow({
  index,
  ordinal,
  set,
  exercise,
  editable,
  onChange,
  onRemove,
  onToggleDone,
  units,
  showEffort,
}: {
  index: number;
  ordinal: number;
  set: LoggedSet;
  exercise: Exercise | undefined;
  editable: boolean;
  onChange: (next: LoggedSet) => void;
  onRemove: () => void;
  onToggleDone: () => void;
  units: UnitSystem;
  showEffort: boolean;
}) {
  const [open, setOpen] = useState(false);
  const measures: Measure[] = exercise ? measuresFor(exercise.load_type) : ['reps'];
  const typeShort = SET_TYPES.find((t) => t.key === set.set_type)?.short ?? '';
  // Named in every field's label, so VoiceOver reads "Reps for set 2 of Back
  // Squat" rather than a column of identical "Reps".
  const exerciseName = exercise?.name ?? set.exercise_id;

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
    <View style={[styles.setRow, set.completed && styles.setRowDone]}>
      <Pressable
        style={styles.setHead}
        onPress={() => editable && setOpen((v) => !v)}
        accessibilityRole={editable ? 'button' : undefined}
        accessibilityLabel={`Set ${ordinal}. ${describeSet(set, units)}`}
        accessibilityState={{ expanded: open }}
        testID={`set-${index}`}
      >
        <Text style={[styles.setOrdinal, set.completed && styles.setOrdinalDone]}>
          {ordinal}
          {typeShort ? <Text style={styles.setBadge}> {typeShort}</Text> : null}
        </Text>
        <Text style={styles.setSummary}>{describeSet(set, units)}</Text>
        {editable && (
          // Records the set; starts rest only if "Auto rest timer" is on.
          <Pressable
            onPress={onToggleDone}
            hitSlop={10}
            style={[styles.tick, set.completed && styles.tickDone]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: set.completed }}
            accessibilityLabel={`Set ${ordinal} done`}
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
                    : MEASURE_LABEL[m];
              // Converted for display, converted back on input — the stored
              // value is always kilograms or metres, whatever is on screen.
              const shown =
                stored == null
                  ? null
                  : m === 'weight'
                    ? toDisplayWeight(stored, units)
                    : m === 'distance'
                      ? toDisplayDistance(stored, units)
                      : stored;
              return (
                <Field
                  key={m}
                  label={label}
                  value={shown}
                  onChangeText={(text) => {
                    const raw = text.trim() === '' ? null : Number(text.replace(',', '.'));
                    if (raw === null || !Number.isFinite(raw)) {
                      onChange({ ...set, [MEASURE_KEY[m]]: null });
                      return;
                    }
                    const canonical =
                      m === 'weight'
                        ? fromDisplayWeight(raw, units)
                        : m === 'distance'
                          ? Math.round(fromDisplayDistance(raw, units))
                          : Math.round(raw);
                    onChange({ ...set, [MEASURE_KEY[m]]: canonical });
                  }}
                  integer={m !== 'weight'}
                  accessibilityLabel={`${label} for set ${ordinal} of ${exerciseName}`}
                  testID={`set-${index}-${m}`}
                />
              );
            })}
          </View>

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
              accessibilityLabel={`Reps in reserve for set ${ordinal} of ${exerciseName}`}
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

          <View style={styles.chips}>
            {SET_TYPES.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => onChange({ ...set, set_type: t.key as SetType })}
                style={[styles.chip, set.set_type === t.key && styles.chipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: set.set_type === t.key }}
                hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
              >
                <Text style={[styles.chipText, set.set_type === t.key && styles.chipTextActive]}>
                  {t.label}
                </Text>
              </Pressable>
            ))}
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

const MEASURE_LABEL: Record<Measure, string> = {
  reps: 'Reps',
  weight: 'Weight kg',
  seconds: 'Seconds',
  distance: 'Metres',
};
const MEASURE_KEY: Record<Measure, keyof LoggedSet> = {
  reps: 'reps',
  weight: 'weight_kg',
  seconds: 'seconds',
  distance: 'distance_m',
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
  summary: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: vola.surface,
    borderRadius: 14,
    padding: 14,
  },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: { fontSize: 11, color: vola.textDim, textAlign: 'center' },
  group: { gap: 8 },
  // Wraps rather than overflows: the header now carries up to six controls
  // (move up/down, rest, unit, swap, remove) beside a name that can be long
  // ("Barbell Bulgarian Split Squat"). On a narrow phone they drop to a
  // second line instead of squeezing the name to an ellipsis or pushing the
  // last control off-screen. `groupName` keeps flex:1 so it still takes the
  // slack on a wide screen.
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    rowGap: 8,
    columnGap: 10,
  },
  groupName: { flex: 1, minWidth: 140, fontSize: 16, fontWeight: '700' },
  swapText: { color: vola.lime, fontWeight: '600', fontSize: 14 },
  restChip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: 'center',
  },
  restChipText: { fontSize: 12, fontWeight: '700', color: vola.textMuted },
  unitChip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    minHeight: 32,
    justifyContent: 'center',
  },
  unitChipText: { fontSize: 12, fontWeight: '700', color: vola.textMuted },
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
  moveChipText: { fontSize: 15, fontWeight: '700', color: vola.textMuted },
  // `danger`, not `textDim`: textDim measured 3.96:1 on the screen background
  // at 13px (needs 4.5), and this control is destructive, so the colour should
  // say so. Padded to a 44pt target rather than relying on hitSlop alone.
  removeGroupText: {
    fontSize: 13,
    fontWeight: '600',
    color: vola.danger,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  setRow: { backgroundColor: vola.surface, borderRadius: 12 },
  // The whole row, not just the tick: a column of rows is scanned by shape
  // and colour, and a 20px checkmark is not what the eye lands on.
  setRowDone: { backgroundColor: vola.setDone },
  // textDim measures 2.51:1 on the done tint; textMuted is 4.67:1. See the
  // setDone note in constants/Colors.ts.
  setOrdinalDone: { color: vola.textMuted },
  // Same 2.51:1 on the done tint that moved the ordinal.
  disclosureDone: { color: vola.textMuted },
  setHead: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  setOrdinal: { width: 34, fontWeight: '700', color: vola.textDim },
  setBadge: { color: vola.lime, fontSize: 11, fontWeight: '700' },
  setSummary: { flex: 1, fontSize: 15 },
  tick: {
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickDone: { backgroundColor: vola.lime, borderColor: vola.lime },
  tickMark: { color: vola.textDim, fontWeight: '800', fontSize: 15 },
  tickMarkDone: { color: vola.navy },
  disclosure: { color: vola.textDim, width: 16, textAlign: 'center' },
  setEditor: { padding: 12, paddingTop: 0, gap: 12 },
  fieldRow: { flexDirection: 'row', gap: 10 },
  field: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 12, color: vola.textMuted },
  fieldHint: { color: vola.textDim, fontSize: 11 },
  fieldInput: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 17,
    color: vola.text,
    backgroundColor: vola.bg,
    textAlign: 'center',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingVertical: 11,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: vola.lime, borderColor: vola.lime },
  chipText: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
  chipTextActive: { color: vola.navy },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  hintBody: { flex: 1, gap: 2 },
  hintPhaseRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hintDot: { width: 7, height: 7, borderRadius: 999 },
  hintPhase: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: vola.text },
  hintPips: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 2 },
  hintPip: { width: 6, height: 6, borderRadius: 999 },
  hintRangeText: { fontSize: 10, color: vola.textMuted, fontVariant: ['tabular-nums'] },
  hintTarget: {
    fontSize: 20,
    fontWeight: '800',
    color: vola.text,
    fontVariant: ['tabular-nums'],
  },
  hintLast: { fontSize: 12, color: vola.textMuted, fontVariant: ['tabular-nums'] },
  hintReason: { fontSize: 12, color: vola.textMuted },
  hintApply: {
    backgroundColor: vola.lime,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  hintApplyText: { color: vola.navy, fontWeight: '700', fontSize: 14 },
  addSet: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.line,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  addSetText: { fontWeight: '700', color: vola.lime },
  primary: {
    backgroundColor: vola.surfaceRaised,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  finish: {
    backgroundColor: vola.lime,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  finishText: { color: vola.navy, fontWeight: '700', fontSize: 16 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 24 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  error: { color: vola.danger, fontSize: 14 },
  deleteButton: { alignItems: 'center', paddingVertical: 16, marginTop: 8 },
  deleteText: { color: vola.danger, fontWeight: '600' },
  removeButton: { alignSelf: 'flex-start', paddingVertical: 12, minHeight: 44, justifyContent: 'center' },
  removeText: { color: vola.danger, fontWeight: '600', fontSize: 13 },
});
