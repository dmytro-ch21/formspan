import { useAuth } from '@clerk/clerk-expo';
import { request as requestSync } from '@/lib/sync';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';

import { HoldToConfirm } from '@/components/HoldToConfirm';
import {
  KeyboardAwareFlatList,
  KeyboardAwareScrollView,
} from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { useAuthToken } from '@/lib/useAuthToken';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import type { UnitSystem } from '@/lib/units';
import {
  emptyItem,
  getWorkout,
  summariseTargets,
  targetFieldsFor,
  type TargetField,
  type Workout,
  type WorkoutItem,
} from '@/lib/workouts';
import { applySuggestions, fetchSuggestions, setsFromWorkout } from '@/lib/sessions';
import {
  cacheExercises,
  cachedExercises,
  cachedWorkouts,
  deleteLocalWorkout,
  dirtyWorkoutIDs,
  renameLocalWorkout,
  saveLocalWorkoutItems,
  startLocalSession,
} from '@/lib/sessionStore';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fromDisplayWeight, toDisplayWeight, weightUnit } from '@/lib/units';
import { useUnits } from '@/lib/useUnits';

export default function WorkoutDetailScreen() {
  const accent = useAccent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const router = useRouter();

  const [workout, setWorkout] = useState<Workout | null>(null);
  const [items, setItems] = useState<WorkoutItem[]>([]);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const { units } = useUnits();

  // Compared against the loaded state so Save only appears when something
  // actually changed — a Save button that's always live trains people to
  // ignore it.
  const dirty = useMemo(
    () => workout !== null && JSON.stringify(items) !== JSON.stringify(workout.items),
    [items, workout],
  );

  const canEdit = workout !== null && workout.owner_user_id !== null && workout.owner_user_id === userId;

  const load = useCallback(async () => {
    if (!id || !userId) return;

    // LOCAL FIRST. Until now this screen only ever called the network, so
    // offline it rendered an error where the plan should be — and with
    // writing now local-first, an editable plan you cannot open is no use.
    let sport: string | null = null;
    try {
      const local = (await cachedWorkouts(userId)).find((w) => w.id === id);
      if (local) {
        setWorkout(local);
        setItems(local.items);
        sport = local.sport;
        setError(null);
        setLoading(false);
      }
    } catch {
      // The network read below is still the real attempt.
    }

    try {
      const w = await getWorkout(getToken, id);
      // The server's copy is only newer if ours isn't waiting to be pushed.
      //
      // Unconditionally adopting it undid the offline edit ON SCREEN while
      // SQLite still held it: reopen an edited plan online before its push
      // lands and the change visibly vanished, Save went inactive (it
      // compares against this same copy), and editing on from what was shown
      // then overwrote the local row with server-derived stale items — the
      // athlete's own work, lost with their unwitting help.
      const dirtyLocal = await dirtyWorkoutIDs(userId).catch(() => new Set<string>());
      sport = w.sport;
      setError(null);
      if (!dirtyLocal.has(id)) {
        setWorkout(w);
        setItems(w.items);
      }
    } catch (err) {
      // Only an error if we have nothing to show. With a cached copy on
      // screen, failing to refresh is an ordinary offline state.
      if (!sport) setError(err instanceof Error ? err.message : String(err));
    }

    try {
      // The cache renders the rows; the fetch refreshes it for next time.
      // One catalog read for the sport, so every row can show a name and a
      // thumbnail without an N+1 of per-exercise requests.
      if (sport) {
        const cached = await cachedExercises(sport);
        if (cached.length > 0) setCatalog(new Map(cached.map((e) => [e.id, e])));
        const list = await fetchExercises(getToken, { sport });
        setCatalog(new Map(list.map((e) => [e.id, e])));
        await cacheExercises(list);
      }
    } catch {
      // Offline: the cached catalog stands.
    }
    setLoading(false);
  }, [getToken, id, userId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Commit the name, or quietly abandon a blank one.
   *
   * Not folded into `save()`, which is item-shaped and only appears when the
   * item list differs — a rename left the Save button inactive, so a combined
   * flow would have needed the button live for one of two reasons and dirty
   * for the other. The API keeps them apart for the same reason.
   */
  async function commitRename() {
    // Re-entrancy guard: `onBlur` and the Done button both land here when Done
    // is pressed while the field has focus, and without this the rename is
    // written twice — the second one re-dirtying a row the first just queued.
    if (!renaming || !id || !userId) return;
    const next = draftName.trim();
    setRenaming(false);
    if (next === '' || next === workout?.name) return;
    try {
      // The boolean is OBSERVED, not discarded. The blank check above makes
      // `false` unreachable today, but the optimistic `setWorkout` below runs
      // regardless — so if that check were ever relaxed the screen would show
      // a name the store refused to write. The BJJ rename this is modelled on
      // branches on it for the same reason.
      if (!(await renameLocalWorkout(userId, id, next))) return;
      setError(null);
      // The local write is the rename; the push is an attempt. Same rule the
      // items follow, so a plan renamed in a basement is renamed.
      setWorkout((w) => (w ? { ...w, name: next } : w));
      requestSync('workout-renamed');
    } catch (err) {
      setError(
        `Couldn't rename on this device: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function save() {
    if (saving || !id) return;
    setSaving(true);
    setError(null);
    try {
      // The LOCAL write is the save; the push is an attempt. Same rule the
      // session screen already follows — a plan edited in a basement is saved,
      // and the server hears about it when it can.
      await saveLocalWorkoutItems(userId!, id, items);
      setWorkout((w) => (w ? { ...w, items } : w));
      requestSync('workout-edited');
    } catch (err) {
      // A LOCAL failure is never quiet: the screen is showing these items, so
      // if SQLite did not take them the athlete is looking at work that
      // exists nowhere.
      setError(
        `Couldn't save on this device: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  /*
    The `Alert` this replaces named the workout — which the screen already
    does, since the button sits on that workout's own page — and otherwise
    said "this can't be undone", which a hold says better and without a
    dialog. The deletes that KEPT their alert are the ones stating a fact the
    button cannot carry: how many logged sets go with it, or that it is
    removed everywhere rather than just here.
  */
  async function deleteNow() {
    try {
      await deleteLocalWorkout(userId!, id!);
      requestSync('workout-deleted');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // A template is only worth writing if performing it is one tap away. The
  // session opens pre-filled with the prescribed sets, so the plan is what
  // you start from and then change — which is what makes the gap between
  // prescribed and actual measurable at all.
  async function start() {
    if (starting || !workout || !userId) return;
    setStarting(true);
    setError(null);
    try {
      let sets = setsFromWorkout(items);
      try {
        // Where the plan is silent, last time's numbers are the sensible
        // starting point. A failed lookup mustn't block the session.
        //
        // The goal goes with it: it decides the rep range the recommendation
        // is expressed in, so omitting it here would pre-fill a session on the
        // general 5-8 range that the session screen then re-derives on 3-5.
        sets = applySuggestions(
          sets,
          await fetchSuggestions(getToken, sets.map((x) => x.exercise_id), workout.goal),
        );
      } catch {
        /* start anyway */
      }
      // Local first — the plan is on the phone, so starting it shouldn't
      // need the network either.
      const session = await startLocalSession(userId, {
        sport: workout.sport,
        name: workout.name,
        workout_id: workout.id,
        sets,
      });
      requestSync('session-started-from-workout');
      router.push(`/session/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  function move(index: number, by: -1 | 1) {
    const next = [...items];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next.map((it, i) => ({ ...it, position: i })));
  }

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator accessibilityLabel="Loading workout" />
      </View>
    );
  }

  if (!workout) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>{error ?? 'Workout not found.'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="workout-detail">
      <Stack.Screen
        options={{
          title: workout.name,
          headerRight: () =>
            canEdit && dirty ? (
              <Pressable onPress={save} disabled={saving} hitSlop={12} testID="workout-save">
                <Text style={[styles.headerAction, { color: accent.ink }]}>
                  {saving ? 'Saving…' : 'Save'}
                </Text>
              </Pressable>
            ) : null,
        }}
      />

      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        // Without this, RN's default ("never") spends the first tap outside a
        // focused TextInput on dismissing the keyboard and the child never
        // sees it — so the visible "Done" beside the rename field does nothing
        // on first press. Ten other screens in this app already set it. Note
        // it hides on the Simulator: with a hardware keyboard attached the
        // soft keyboard is not up, and the tap works first time.
        keyboardShouldPersistTaps="handled"
      >
        {/*
          The name, and the ability to change it.

          It lives here rather than only in the navigation bar because a native
          header title is not a control — it cannot be tapped, and until now
          that was the whole reason a template named in a hurry on the gym
          floor stayed that way. Rebuilding it was the only correction, and
          that loses every plan pointing at the old id.

          Shown read-only when the workout is not yours, on the same rule as
          the item list: a VOLA template and another athlete's public one are
          both view-only, and the API refuses the write either way.
        */}
        {renaming ? (
          <View style={styles.renameRow}>
            <TextInput
              value={draftName}
              onChangeText={setDraftName}
              autoFocus
              selectTextOnFocus
              style={styles.renameInput}
              placeholder="Workout name"
              placeholderTextColor={vola.textMuted}
              // Matches the server's maxNameLen. A longer name is a permanent
              // 400, and a permanent rejection on the push path strands the
              // row in the outbox with nothing on screen explaining why.
              maxLength={120}
              returnKeyType="done"
              onSubmitEditing={commitRename}
              // Dismissing the keyboard by tapping away used to leave the
              // heading replaced by an unfocused field holding an uncommitted
              // draft, with Done the only exit. Committing on blur matches
              // web; the guard at the top of `commitRename` keeps Done from
              // firing it twice.
              onBlur={commitRename}
              accessibilityLabel="Workout name"
              testID="workout-name-input"
            />
            <Pressable
              onPress={commitRename}
              hitSlop={12}
              accessibilityRole="button"
              testID="workout-name-save"
            >
              <Text style={styles.renameAction}>Done</Text>
            </Pressable>
          </View>
        ) : canEdit ? (
          <Pressable
            onPress={() => {
              setDraftName(workout.name);
              setRenaming(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${workout.name}. Rename this workout`}
            testID="workout-rename"
          >
            <Text style={styles.title}>{workout.name}</Text>
            <Text style={styles.renameHint}>Tap to rename</Text>
          </Pressable>
        ) : (
          <Text style={styles.title}>{workout.name}</Text>
        )}

        <Text style={styles.meta}>
          {workout.sport}
          {workout.goal ? ` · ${workout.goal}` : ''}
          {workout.visibility === 'public' ? ' · shared' : ''}
        </Text>

        <Pressable
          style={[
            styles.startButton,
            { backgroundColor: accent.accent },
            (starting || dirty) && styles.disabled,
          ]}
          onPress={start}
          disabled={starting || dirty}
          accessibilityRole="button"
          accessibilityLabel={`Start a session from ${workout.name}`}
          accessibilityState={{ busy: starting, disabled: starting || dirty }}
          testID="workout-start-session"
        >
          {starting ? (
            <ActivityIndicator color={vola.navy} />
          ) : (
            <Text style={styles.startText}>
              {/* Starting with unsaved edits would log the plan as it is on
                  the server, not as it is on screen — so save first. */}
              {dirty ? 'Save to start a session' : 'Start session'}
            </Text>
          )}
        </Pressable>

        {!canEdit && (
          <Text style={[styles.readonly, { color: accent.ink }]} testID="workout-readonly">
            {workout.owner_user_id === null
              ? 'A VOLA template — view only.'
              : 'Shared by someone else — view only.'}
          </Text>
        )}

        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite" testID="workout-error">
            {error}
          </Text>
        )}

        {items.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No exercises yet</Text>
            <Text style={styles.muted}>
              {canEdit ? 'Add the first one below.' : 'This workout is empty.'}
            </Text>
          </View>
        ) : (
          items.map((item, index) => (
            <ItemRow
              key={`${item.exercise_id}-${index}`}
              item={item}
              index={index}
              total={items.length}
              exercise={catalog.get(item.exercise_id)}
              editable={canEdit}
              units={units}
              onChange={(next) => setItems(items.map((it, i) => (i === index ? next : it)))}
              onMove={(by) => move(index, by)}
              onRemove={() =>
                setItems(items.filter((_, i) => i !== index).map((it, i) => ({ ...it, position: i })))
              }
            />
          ))
        )}

        {canEdit && (
          <>
            <Pressable
              style={styles.addButton}
              onPress={() => setPicking(true)}
              accessibilityRole="button"
              testID="workout-add-exercise"
            >
              <Text style={styles.addButtonText}>+ Add exercise</Text>
            </Pressable>

            <HoldToConfirm
              label="Delete workout"
              holdingLabel="Keep holding to delete…"
              confirmTitle="Delete workout?"
              confirmBody={`"${workout?.name}" will be removed. This can't be undone.`}
              style={styles.deleteButton}
              textStyle={styles.deleteText}
              fillColor={vola.danger}
              destructive
              testID="workout-delete"
              onConfirm={deleteNow}
            />
          </>
        )}
      </KeyboardAwareScrollView>

      <ExercisePicker
        visible={picking}
        sport={workout.sport}
        onClose={() => setPicking(false)}
        onPick={(exercise) => {
          setPicking(false);
          setCatalog((c) => new Map(c).set(exercise.id, exercise));
          setItems((prev) => [...prev, emptyItem(exercise.id, prev.length)]);
        }}
      />
    </View>
  );
}

/** One exercise in the workout, with only the target fields its load type uses. */
function ItemRow({
  item,
  index,
  total,
  exercise,
  editable,
  units,
  onChange,
  onMove,
  onRemove,
}: {
  item: WorkoutItem;
  index: number;
  total: number;
  exercise: Exercise | undefined;
  editable: boolean;
  units: UnitSystem;
  onChange: (next: WorkoutItem) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const uri = exercise ? pickImage(exercise, 'thumbnail') : null;

  // The whole point of carrying load_type in the catalog: the form is
  // data-driven, so a plank asks for a duration and a squat asks for weight
  // without this component knowing anything about either.
  const fields: TargetField[] = exercise ? targetFieldsFor(exercise.load_type) : [];

  return (
    <View style={styles.item}>
      <Pressable
        style={styles.itemHead}
        onPress={() => editable && setOpen((v) => !v)}
        accessibilityRole={editable ? 'button' : undefined}
        accessibilityLabel={
          exercise ? `${exercise.name}. ${summariseTargets(item, units)}` : item.exercise_id
        }
        accessibilityState={{ expanded: open }}
        testID={`workout-item-${index}`}
      >
        <Text style={styles.itemIndex}>{index + 1}</Text>
        {uri ? (
          <Image source={{ uri }} style={styles.thumb} contentFit="cover" cachePolicy="memory-disk" alt="" />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]} />
        )}
        <View style={styles.itemBody}>
          <Text style={styles.itemName}>{exercise?.name ?? item.exercise_id}</Text>
          <Text style={styles.muted}>{summariseTargets(item, units)}</Text>
        </View>
        {editable && <Text style={styles.disclosure}>{open ? '⌃' : '⌄'}</Text>}
      </Pressable>

      {open && editable && (
        <View style={styles.itemEditor}>
          <View style={styles.fieldRow}>
            {fields.map((f) => {
              const label = f === 'weight' ? `Weight (${weightUnit(units)})` : FIELD_LABEL[f];
              const stored = FIELD_VALUE[f](item);
              // Shown in the athlete's units, stored in kilograms — the same
              // rule the session logger follows, so a template written in
              // pounds and performed in kilograms is still the same plan.
              const shown =
                stored == null ? '' : String(f === 'weight' ? toDisplayWeight(stored, units) : stored);
              return (
                <View key={f} style={styles.field}>
                  <Text style={styles.fieldLabel}>{label}</Text>
                  <TextInput
                    style={styles.fieldInput}
                    keyboardType={f === 'weight' ? 'decimal-pad' : 'number-pad'}
                    inputMode={f === 'weight' ? 'decimal' : 'numeric'}
                    accessibilityLabel={`${label} for ${exercise?.name ?? 'this exercise'}`}
                    value={shown}
                    onChangeText={(text) => {
                      const n = text.trim() === '' ? null : Number(text.replace(',', '.'));
                      if (n === null || !Number.isFinite(n)) {
                        onChange({ ...item, [FIELD_KEY[f]]: null });
                        return;
                      }
                      onChange({
                        ...item,
                        [FIELD_KEY[f]]: f === 'weight' ? fromDisplayWeight(n, units) : Math.round(n),
                      });
                    }}
                    placeholder="—"
                    placeholderTextColor="#9aa0a6"
                    testID={`workout-item-${index}-${f}`}
                  />
                </View>
              );
            })}
          </View>
          {exercise?.is_unilateral && (
            <Text style={styles.hint}>Per side — 8 reps here means 8 each side.</Text>
          )}

          <View style={styles.itemActions}>
            <Pressable
              onPress={() => onMove(-1)}
              disabled={index === 0}
              style={[styles.smallButton, index === 0 && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel="Move up"
              testID={`workout-item-${index}-up`}
            >
              <Text style={styles.smallButtonText}>↑</Text>
            </Pressable>
            <Pressable
              onPress={() => onMove(1)}
              disabled={index === total - 1}
              style={[styles.smallButton, index === total - 1 && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel="Move down"
              testID={`workout-item-${index}-down`}
            >
              <Text style={styles.smallButtonText}>↓</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={onRemove}
              style={styles.smallButton}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${exercise?.name ?? 'exercise'}`}
              testID={`workout-item-${index}-remove`}
            >
              <Text style={[styles.smallButtonText, styles.removeText]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const FIELD_LABEL: Record<TargetField, string> = {
  sets: 'Sets',
  reps: 'Reps',
  weight: 'Weight',
  seconds: 'Seconds',
  distance: 'Distance (m)',
};
const FIELD_KEY: Record<TargetField, keyof WorkoutItem> = {
  sets: 'target_sets',
  reps: 'target_reps',
  weight: 'target_weight_kg',
  seconds: 'target_seconds',
  distance: 'target_distance_m',
};
const FIELD_VALUE: Record<TargetField, (i: WorkoutItem) => number | null> = {
  sets: (i) => i.target_sets,
  reps: (i) => i.target_reps,
  weight: (i) => i.target_weight_kg,
  seconds: (i) => i.target_seconds,
  distance: (i) => i.target_distance_m,
};

/**
 * Exercise picker, pre-filtered to the workout's own sport.
 *
 * That filter isn't a nicety — workouts are single-discipline and the API
 * rejects a mismatch, so showing the whole catalog would let someone pick an
 * exercise only to be told no on save. Filtering makes the invalid choice
 * unreachable instead of merely rejected.
 */
function ExercisePicker({
  visible,
  sport,
  onClose,
  onPick,
}: {
  visible: boolean;
  sport: string;
  onClose: () => void;
  onPick: (e: Exercise) => void;
}) {
  const accent = useAccent();
  const getToken = useAuthToken();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(false);
  // Same guard as the Library: without it the picker renders "No matching
  // exercises" for the whole first debounce+fetch, which reads as "this
  // sport has nothing" rather than "still loading".
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const list = await fetchExercises(
          getToken,
          { sport, q: query.trim() || undefined },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setResults(list);
          setEverLoaded(true);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setEverLoaded(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [visible, sport, query, getToken]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={12}>
            <Text style={[styles.headerAction, { color: accent.ink }]}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>Add exercise</Text>
          <View style={{ width: 56 }} />
        </View>

        <TextInput
          style={styles.input}
          placeholder={`Search ${sport} exercises`}
          placeholderTextColor="#767676"
          accessibilityLabel="Search exercises"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={100}
          testID="picker-search"
        />

        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}

        <KeyboardAwareFlatList
          data={results}
          keyExtractor={(e) => e.id}
          contentContainerStyle={styles.pickerList}
          ListEmptyComponent={
            loading || error || !everLoaded ? null : (
              <Text style={styles.muted}>No matching {sport} exercises.</Text>
            )
          }
          renderItem={({ item }) => {
            const uri = pickImage(item, 'thumbnail');
            return (
              <Pressable
                style={styles.pickerRow}
                onPress={() => onPick(item)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${item.name}`}
                testID={`picker-${item.id}`}
              >
                {uri ? (
                  <Image source={{ uri }} style={styles.thumb} contentFit="cover" cachePolicy="memory-disk" alt="" />
                ) : (
                  <View style={[styles.thumb, styles.thumbEmpty]} />
                )}
                <View style={styles.itemBody}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.muted}>
                    {item.movement_pattern.replace(/_/g, ' ')}
                    {item.equipment.length ? ` · ${item.equipment[0].replace(/-/g, ' ')}` : ''}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  scroll: { padding: 16, gap: 12, paddingBottom: 48 },
  title: { fontSize: 24, fontWeight: '800' },
  renameHint: { fontSize: 12, color: vola.textMuted, marginTop: 2 },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  renameInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '800',
    color: vola.text,
    borderBottomWidth: 1,
    borderBottomColor: vola.lineSoft,
    paddingVertical: 4,
  },
  renameAction: { fontSize: 16, fontWeight: '700', color: vola.lime },
  meta: { color: vola.textMuted, fontSize: 13, textTransform: 'capitalize' },
  readonly: {
    fontSize: 13,
    backgroundColor: vola.surfaceRaised,
    padding: 10,
    borderRadius: 10,
    overflow: 'hidden',
  },
  headerAction: { fontSize: 16, fontWeight: '600' },
  item: { borderWidth: 1, borderColor: vola.line, borderRadius: 14, backgroundColor: vola.surface },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  itemIndex: { width: 18, textAlign: 'center', color: vola.textDim, fontWeight: '700' },
  thumb: { width: 52, height: 52, borderRadius: 10, backgroundColor: vola.surfaceRaised },
  thumbEmpty: {},
  itemBody: { flex: 1, gap: 2 },
  itemName: { fontSize: 15, fontWeight: '600' },
  disclosure: { color: vola.textDim, fontSize: 16, width: 18, textAlign: 'center' },
  itemEditor: { padding: 12, paddingTop: 0, gap: 10 },
  fieldRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 84, gap: 4 },
  fieldLabel: { fontSize: 12, color: vola.textMuted },
  fieldInput: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  hint: { fontSize: 12, color: vola.textMuted },
  itemActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  smallButton: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  smallButtonText: { fontWeight: '600', fontSize: 14 },
  removeText: { color: vola.danger },
  disabled: { opacity: 0.35 },
  startButton: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  startText: { color: vola.navy, fontWeight: '700', fontSize: 16 },
  addButton: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.line,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  addButtonText: { fontWeight: '700', fontSize: 15 },
  deleteButton: { alignItems: 'center', paddingVertical: 16, marginTop: 8 },
  deleteText: { color: vola.danger, fontWeight: '600' },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: vola.danger, fontSize: 14 },
  // A Modal renders outside the navigator, so nothing paints behind it —
  // this is the one place a screen-level container has to set its own
  // background. Without it the sheet falls through to iOS's default
  // white and the near-white body text disappears into it.
  sheet: { flex: 1, padding: 20, gap: 12, backgroundColor: vola.bg },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  pickerList: { gap: 12, paddingBottom: 32 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
