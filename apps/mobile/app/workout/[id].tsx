import { useAuth } from '@clerk/clerk-expo';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import {
  deleteWorkout,
  emptyItem,
  getWorkout,
  replaceItems,
  summariseTargets,
  targetFieldsFor,
  type TargetField,
  type Workout,
  type WorkoutItem,
} from '@/lib/workouts';
import { vola } from '@/constants/Colors';

export default function WorkoutDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getToken, userId } = useAuth();
  const router = useRouter();

  const [workout, setWorkout] = useState<Workout | null>(null);
  const [items, setItems] = useState<WorkoutItem[]>([]);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);

  // Compared against the loaded state so Save only appears when something
  // actually changed — a Save button that's always live trains people to
  // ignore it.
  const dirty = useMemo(
    () => workout !== null && JSON.stringify(items) !== JSON.stringify(workout.items),
    [items, workout],
  );

  const canEdit = workout !== null && workout.owner_user_id !== null && workout.owner_user_id === userId;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const w = await getWorkout(getToken, id);
      setWorkout(w);
      setItems(w.items);
      // One catalog fetch for the sport, so every row can show a name and a
      // thumbnail without an N+1 of per-exercise requests.
      const list = await fetchExercises(getToken, { sport: w.sport });
      setCatalog(new Map(list.map((e) => [e.id, e])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [getToken, id]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (saving || !id) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await replaceItems(getToken, id, items);
      setWorkout(updated);
      setItems(updated.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    Alert.alert('Delete workout?', `"${workout?.name}" will be removed. This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteWorkout(getToken, id!);
            router.back();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);
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
                <Text style={styles.headerAction}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            ) : null,
        }}
      />

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.meta}>
          {workout.sport}
          {workout.goal ? ` · ${workout.goal}` : ''}
          {workout.visibility === 'public' ? ' · shared' : ''}
        </Text>

        {!canEdit && (
          <Text style={styles.readonly} testID="workout-readonly">
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

            <Pressable
              onPress={confirmDelete}
              style={styles.deleteButton}
              accessibilityRole="button"
              testID="workout-delete"
            >
              <Text style={styles.deleteText}>Delete workout</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

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
  onChange,
  onMove,
  onRemove,
}: {
  item: WorkoutItem;
  index: number;
  total: number;
  exercise: Exercise | undefined;
  editable: boolean;
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

  const set = (key: keyof WorkoutItem) => (text: string) => {
    const n = text.trim() === '' ? null : Number(text.replace(',', '.'));
    onChange({ ...item, [key]: Number.isFinite(n as number) ? n : null });
  };

  return (
    <View style={styles.item}>
      <Pressable
        style={styles.itemHead}
        onPress={() => editable && setOpen((v) => !v)}
        accessibilityRole={editable ? 'button' : undefined}
        accessibilityLabel={
          exercise ? `${exercise.name}. ${summariseTargets(item)}` : item.exercise_id
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
          <Text style={styles.muted}>{summariseTargets(item)}</Text>
        </View>
        {editable && <Text style={styles.disclosure}>{open ? '⌃' : '⌄'}</Text>}
      </Pressable>

      {open && editable && (
        <View style={styles.itemEditor}>
          <View style={styles.fieldRow}>
            {fields.map((f) => (
              <View key={f} style={styles.field}>
                <Text style={styles.fieldLabel}>{FIELD_LABEL[f]}</Text>
                <TextInput
                  style={styles.fieldInput}
                  keyboardType="numeric"
                  inputMode="numeric"
                  accessibilityLabel={`${FIELD_LABEL[f]} for ${exercise?.name ?? 'this exercise'}`}
                  value={FIELD_VALUE[f](item)?.toString() ?? ''}
                  onChangeText={set(FIELD_KEY[f])}
                  placeholder="—"
                  placeholderTextColor="#9aa0a6"
                  testID={`workout-item-${index}-${f}`}
                />
              </View>
            ))}
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
  weight: 'Weight (kg)',
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
  const { getToken } = useAuth();
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
            <Text style={styles.headerAction}>Cancel</Text>
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

        <FlatList
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
  meta: { color: vola.textMuted, fontSize: 13, textTransform: 'capitalize' },
  readonly: {
    fontSize: 13,
    color: vola.lime,
    backgroundColor: vola.surfaceRaised,
    padding: 10,
    borderRadius: 10,
    overflow: 'hidden',
  },
  headerAction: { fontSize: 16, fontWeight: '600', color: vola.lime },
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
  sheet: { flex: 1, padding: 20, gap: 12 },
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
