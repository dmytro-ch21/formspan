import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { RestTimerBar, useRestTimer } from '@/components/RestTimer';
import { Text, View } from '@/components/Themed';
import { useAuthToken } from '@/lib/useAuthToken';
import { vola } from '@/constants/Colors';
import { formatElapsed, readRestSeconds, writeRestSeconds } from '@/lib/rest';
import {
  distanceInputUnit,
  formatWeight,
  fromDisplayDistance,
  fromDisplayWeight,
  toDisplayDistance,
  toDisplayWeight,
  weightUnit,
  type UnitSystem,
} from '@/lib/units';
import { useUnits } from '@/lib/useUnits';
import { getExerciseUnits, getProfile, setExerciseUnit } from '@/lib/profile';
import { fetchExercises, type Exercise } from '@/lib/exercises';
import {
  cacheExercises,
  cachedExercises,
  countPendingSessions,
  deleteLocalSession,
  finishLocalSession,
  hydrateSession,
  readLocalSession,
  saveLocalSets,
  syncSessions,
} from '@/lib/sessionStore';
import { deleteSession } from '@/lib/sessions';
import {
  describeSet,
  emptySet,
  fetchSuggestions,
  measuresFor,
  SET_TYPES,
  type LoggedSet,
  type Measure,
  type Session,
  type SetType,
  type Suggestion,
  type Volume,
} from '@/lib/sessions';

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
  const timerState = useRestTimer();

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
  const { units } = useUnits();
  // Per-exercise overrides: a lifter who thinks in kilograms still faces a
  // leg press marked in pounds, and converting in your head at the moment
  // you're trying to record a number is exactly what this avoids.
  const [exerciseUnits, setExerciseUnits] = useState<Record<string, UnitSystem>>({});
  // Defaults to showing effort: the progression rule is built on it, and a
  // failed profile fetch shouldn't quietly disable the app's only input.
  const [showEffort, setShowEffort] = useState(true);
  useEffect(() => {
    getProfile(getToken)
      .then((p) => setShowEffort(p.track_effort))
      .catch(() => {});
  }, [getToken]);
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
  // How many sessions the server still owes — the honest replacement for a
  // "saving…" spinner once saving no longer depends on the network.
  const [pending, setPending] = useState(0);

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
      setPending(await countPendingSessions(userId));

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
      fetchSuggestions(
        getToken,
        s.sets.map((x) => x.exercise_id),
      )
        .then(setSuggestions)
        .catch(() => {});
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
          await saveLocalSets(userId, id, next);
          setVolume(localVolume(next));
          setError(null);
          const result = await syncSessions(userId, getToken);
          setPending(await countPendingSessions(userId));
          // Only a rejection says the *data* is wrong; anything else is the
          // network, which the outbox already handles.
          if (result.error && /invalid|400/i.test(result.error)) setError(result.error);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
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
   * It used to start the rest timer too, on the theory that finishing a set
   * and beginning to rest are the same moment. They often aren't: you tick
   * late, you tick a set you did earlier, you're already walking to the next
   * rack. A countdown that starts itself is a countdown you spend attention
   * cancelling, so rest is now only ever started by the Rest button.
   *
   * Un-ticking stays possible: mis-taps happen mid-set, and an un-undoable
   * checkbox is worse than none.
   */
  function toggleDone(index: number) {
    const now = !sets[index].completed;
    commit(sets.map((s, i) => (i === index ? { ...s, completed: now } : s)));
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
        {/* Three numbers while you train — time, sets, reps — and tonnage
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
            {/* Tonnage is a result, not a readout. Mid-session it's a
                number nobody acts on — you don't change the next set
                because the running total crossed 1,500kg — so it appears
                once the session is done and the figure means something. */}
            {finished && (
              <Stat
                label="Tonnage"
                value={volume.tonnage_kg > 0 ? formatWeight(volume.tonnage_kg, units) : '—'}
              />
            )}
          </View>
        )}

        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite" testID="session-error">
            {error}
          </Text>
        )}

        {groups.map((g) => {
          const exercise = catalog.get(g.exerciseID);
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
                    onPress={async () => {
                      // Awaited: the swap screen reads the session back, so an
                      // unsaved edit still in flight would be overwritten.
                      await flush();
                      router.push(`/session/${id}/add?swap=${encodeURIComponent(g.exerciseID)}`);
                    }}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={`Swap ${exercise?.name ?? 'this exercise'} for another`}
                    testID={`swap-${g.exerciseID}`}
                  >
                    <Text style={styles.swapText}>Swap</Text>
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
                  onToggleDone={() => toggleDone(i)}
                  showEffort={showEffort}
                  units={unitFor(g.exerciseID)}
                />
              ))}
              {(() => {
                const hint = suggestions.get(g.exerciseID);
                if (!hint || hint.last_weight_kg == null) return null;
                const target = hint.suggested_weight_kg;
                const canApply =
                  !finished && target != null && sets[g.indices[0]]?.weight_kg !== target;
                return (
                  <View style={styles.hintRow}>
                    <View style={styles.hintBody}>
                      <Text style={styles.hintLast}>
                        Last time: {hint.last_reps != null ? `${hint.last_reps} × ` : ''}
                        {formatWeight(hint.last_weight_kg, unitFor(g.exerciseID))}
                        {hint.last_rir != null ? ` · ${hint.last_rir} RIR` : ''}
                        {hint.last_rir == null && hint.last_rpe != null ? ` · RPE ${hint.last_rpe}` : ''}
                      </Text>
                      {/* The reason, verbatim from the API. It's the whole
                          point: a number you can argue with. */}
                      <Text style={styles.hintReason}>{hint.reason}</Text>
                    </View>
                    {canApply && (
                      <Pressable
                        onPress={() => {
                          commit(
                            sets.map((st, i) =>
                              g.indices.includes(i) ? { ...st, weight_kg: target } : st,
                            ),
                          );
                        }}
                        style={styles.hintApply}
                        accessibilityRole="button"
                        accessibilityLabel={`Use ${formatWeight(target, unitFor(g.exerciseID))} for every set of ${
                          exercise?.name ?? 'this exercise'
                        }`}
                        testID={`apply-suggestion-${g.exerciseID}`}
                      >
                        <Text style={styles.hintApplyText}>
                          {formatWeight(target, unitFor(g.exerciseID))}
                        </Text>
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
            onPress={async () => {
              // Awaited: the picker reads the session back from the server,
              // so an unsaved edit still in flight would be overwritten.
              await flush();
              router.push(`/session/${id}/add`);
            }}
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
                syncSessions(userId!, getToken)
                  .then(() => countPendingSessions(userId!))
                  .then(setPending)
                  .catch(() => {});
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
                    await deleteLocalSession(userId!, id!);
                    // Best-effort: gone locally either way, and a delete
                    // that only lands when signal returns is still a delete.
                    deleteSession(getToken, id!).catch(() => {});
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
    // showed the plan's full tonnage against a column of unticked sets —
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
      {/* Four-figure tonnage wrapped onto a second line and shoved its own
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
    <View style={styles.setRow}>
      <Pressable
        style={styles.setHead}
        onPress={() => editable && setOpen((v) => !v)}
        accessibilityRole={editable ? 'button' : undefined}
        accessibilityLabel={`Set ${ordinal}. ${describeSet(set, units)}`}
        accessibilityState={{ expanded: open }}
        testID={`set-${index}`}
      >
        <Text style={styles.setOrdinal}>
          {ordinal}
          {typeShort ? <Text style={styles.setBadge}> {typeShort}</Text> : null}
        </Text>
        <Text style={styles.setSummary}>{describeSet(set, units)}</Text>
        {editable && (
          // Records the set only. Rest is the Rest button's job — see
          // toggleDone for why the two were separated.
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
        {editable && <Text style={styles.disclosure}>{open ? '⌃' : '⌄'}</Text>}
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
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  groupName: { flex: 1, fontSize: 16, fontWeight: '700' },
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
  setRow: { backgroundColor: vola.surface, borderRadius: 12 },
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
    alignItems: 'center',
    gap: 10,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  hintBody: { flex: 1, gap: 2 },
  hintLast: { fontSize: 13, fontWeight: '600' },
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
