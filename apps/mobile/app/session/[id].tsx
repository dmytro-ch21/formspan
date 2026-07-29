import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { RestTimerBar, useRestTimer } from '@/components/RestTimer';
import { Text, View } from '@/components/Themed';
import { useAuthToken } from '@/lib/useAuthToken';
import { vola } from '@/constants/Colors';
import { restSecondsFor } from '@/lib/rest';
import { fetchExercises, type Exercise } from '@/lib/exercises';
import {
  deleteSession,
  describeSet,
  emptySet,
  fetchSuggestions,
  finishSession,
  getSession,
  isValidationError,
  measuresFor,
  replaceSets,
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
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Declared above persist, which clears it when a save fails for a reason
  // that means the screen is out of date rather than the input was bad.
  const pending = useRef<LoggedSet[] | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const { session: s, volume: v } = await getSession(getToken, id);
      const list = await fetchExercises(getToken, { sport: s.sport });
      setSession(s);
      setSets(s.sets);
      setVolume(v);
      setCatalog(new Map(list.map((e) => [e.id, e])));
      setEverLoaded(true);
      setError(null);
      // Separate and non-blocking: the session must render even if the
      // history lookup fails, since it's advice rather than content.
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
  }, [getToken, id]);

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

  const persist = useCallback(
    (next: LoggedSet[]) => {
      if (!id) return Promise.resolve();
      const run = inFlight.current.then(async () => {
        setSaving(true);
        try {
          const { volume: v } = await replaceSets(getToken, id, next);
          setVolume(v);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          // Bad input is the caller's to correct — reloading would throw away
          // every other edit made since the last good save. Only re-read when
          // the server and the screen genuinely disagree about what exists.
          if (!isValidationError(err)) {
            pending.current = null;
            load();
          }
        } finally {
          setSaving(false);
        }
      });
      inFlight.current = run.catch(() => {});
      return run;
    },
    [getToken, id, load],
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
    const queued = pending.current;
    pending.current = null;
    if (queued) await persist(queued);
    // Awaited even with nothing queued: a save may already be flying, and
    // callers flush precisely because they're about to read the session back.
    await inFlight.current;
  }, [persist]);

  const persistSoon = useCallback(
    (next: LoggedSet[]) => {
      pending.current = next;
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
    pending.current = updated;
    void flush();
  }

  function addSet(exerciseID: string, afterIndex: number) {
    // Adding the next set is the gesture that means "I just finished one",
    // so rest starts here rather than behind a second, separate tap.
    startRest(exerciseID);
    commit(
      [
        ...sets.slice(0, afterIndex + 1),
        emptySet(exerciseID, afterIndex + 1, sets[afterIndex]),
        ...sets.slice(afterIndex + 1),
      ].map((s, i) => ({ ...s, position: i })),
    );
  }

  function startRest(exerciseID: string) {
    const ex = catalog.get(exerciseID);
    timerState.start(restSecondsFor(ex), ex?.name ?? 'Rest');
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
        {volume && (
          <View style={styles.summary}>
            <Stat label="Working sets" value={String(volume.working_sets)} />
            <Stat label="Reps" value={String(volume.total_reps)} />
            <Stat
              label="Tonnage"
              value={volume.tonnage_kg > 0 ? `${Math.round(volume.tonnage_kg)}kg` : '—'}
            />
            <Stat label="Top RPE" value={volume.hardest_rpe > 0 ? String(volume.hardest_rpe) : '—'} />
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
                  onRest={() => startRest(g.exerciseID)}
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
                        {hint.last_weight_kg}kg
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
                        accessibilityLabel={`Use ${target} kilograms for every set of ${
                          exercise?.name ?? 'this exercise'
                        }`}
                        testID={`apply-suggestion-${g.exerciseID}`}
                      >
                        <Text style={styles.hintApplyText}>{target}kg</Text>
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
                const { session: s, volume: v } = await finishSession(getToken, id!);
                setSession(s);
                setSets(s.sets);
                setVolume(v);
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
                    await deleteSession(getToken, id!);
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
          onAdjust={timerState.adjust}
          onTogglePause={timerState.togglePause}
          onStop={timerState.stop}
        />
      )}
    </View>
  );
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
  onRest,
}: {
  index: number;
  ordinal: number;
  set: LoggedSet;
  exercise: Exercise | undefined;
  editable: boolean;
  onChange: (next: LoggedSet) => void;
  onRemove: () => void;
  onRest: () => void;
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
        accessibilityLabel={`Set ${ordinal}. ${describeSet(set)}`}
        accessibilityState={{ expanded: open }}
        testID={`set-${index}`}
      >
        <Text style={styles.setOrdinal}>
          {ordinal}
          {typeShort ? <Text style={styles.setBadge}> {typeShort}</Text> : null}
        </Text>
        <Text style={styles.setSummary}>{describeSet(set)}</Text>
        {editable && (
          // Sits on the collapsed row, because that's where your thumb
          // already is when you rack the bar — not behind a disclosure.
          <Pressable
            onPress={onRest}
            hitSlop={10}
            style={styles.restChip}
            accessibilityRole="button"
            accessibilityLabel={`Done — start resting after set ${ordinal}`}
            testID={`rest-${index}`}
          >
            <Text style={styles.restChipText}>Rest</Text>
          </Pressable>
        )}
        {editable && <Text style={styles.disclosure}>{open ? '⌃' : '⌄'}</Text>}
      </Pressable>

      {open && editable && (
        <View style={styles.setEditor}>
          <View style={styles.fieldRow}>
            {measures.map((m) => (
              <Field
                key={m}
                label={MEASURE_LABEL[m]}
                value={set[MEASURE_KEY[m]] as number | null}
                onChangeText={num(MEASURE_KEY[m], m !== 'weight')}
                integer={m !== 'weight'}
                accessibilityLabel={`${MEASURE_LABEL[m]} for set ${ordinal} of ${exerciseName}`}
                testID={`set-${index}-${m}`}
              />
            ))}
          </View>

          {/* Effort, side by side. Two views of the same thing — record
              whichever you think in rather than converting mid-session. */}
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
  setRow: { backgroundColor: vola.surface, borderRadius: 12 },
  setHead: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  setOrdinal: { width: 34, fontWeight: '700', color: vola.textDim },
  setBadge: { color: vola.lime, fontSize: 11, fontWeight: '700' },
  setSummary: { flex: 1, fontSize: 15 },
  restChip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 34,
    justifyContent: 'center',
  },
  restChipText: { fontSize: 12, fontWeight: '700', color: vola.lime },
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
