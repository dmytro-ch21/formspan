import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
} from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { Text, View } from '@/components/Themed';
import { useAuthToken } from '@/lib/useAuthToken';
import {
  createWorkout,
  listWorkouts,
  GOALS,
  SPORTS,
  type Goal,
  type Sport,
  type Workout,
} from '@/lib/workouts';
import { vola } from '@/constants/Colors';

const SCOPES = [
  { key: 'mine', label: 'My workouts' },
  { key: 'shared', label: 'Shared' },
] as const;

export default function WorkoutsScreen() {
  const getToken = useAuthToken();

  const [scope, setScope] = useState<'mine' | 'shared'>('mine');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const list = await listWorkouts(getToken, scope, controller.signal);
      if (!controller.signal.aborted) {
        setWorkouts(list);
        setEverLoaded(true);
        // Cleared on success, not at request start — an error wiped up
        // front leaves the screen looking fine throughout a retry.
        setError(null);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      // So the empty state stops claiming the list is genuinely empty.
      setEverLoaded(true);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [getToken, scope]);

  // Refetch on focus, so returning from the editor shows the edit rather
  // than a stale list.
  useFocusEffect(
    useCallback(() => {
      load();
      return () => abortRef.current?.abort();
    }, [load]),
  );

  return (
    <View style={styles.container} testID="workouts-screen">
      <ScreenHeader title="Workouts" />
      <View style={styles.scopeRow}>
        {SCOPES.map((s) => {
          const active = scope === s.key;
          return (
            <Pressable
              key={s.key}
              onPress={() => {
                setScope(s.key);
                setLoading(true);
              }}
              style={[styles.scopeTab, active && styles.scopeTabActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              testID={`workouts-scope-${s.key}`}
            >
              <Text style={[styles.scopeText, active && styles.scopeTextActive]}>{s.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="workouts-error">
          {error}
        </Text>
      )}

      {loading && !everLoaded ? (
        <ActivityIndicator style={styles.loader} accessibilityLabel="Loading workouts" />
      ) : (
        <FlatList
          data={workouts}
          keyExtractor={(w) => w.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
            />
          }
          ListEmptyComponent={
            error || !everLoaded ? null : (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>
                  {scope === 'mine' ? 'No workouts yet' : 'Nothing shared yet'}
                </Text>
                <Text style={styles.muted}>
                  {scope === 'mine'
                    ? 'Build a template once, then reuse it every session.'
                    : 'Workouts other people publish will appear here.'}
                </Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <Link href={`/workout/${item.id}`} asChild>
              <Pressable
                style={styles.card}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${item.sport}, ${item.items.length} exercises`}
                testID={`workout-${item.id}`}
              >
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{item.name}</Text>
                  {item.visibility === 'public' && (
                    <Text style={styles.badge} testID={`workout-${item.id}-public`}>
                      Shared
                    </Text>
                  )}
                </View>
                <Text style={styles.cardMeta}>
                  {SPORTS.find((s) => s.key === item.sport)?.label ?? item.sport}
                  {item.goal ? ` · ${GOALS.find((g) => g.key === item.goal)?.label}` : ''}
                  {` · ${item.items.length} ${item.items.length === 1 ? 'exercise' : 'exercises'}`}
                </Text>
                {item.owner_user_id === null && (
                  <Text style={styles.muted}>VOLA template</Text>
                )}
              </Pressable>
            </Link>
          )}
        />
      )}

      {scope === 'mine' && (
        <Pressable
          style={styles.fab}
          onPress={() => setComposing(true)}
          accessibilityRole="button"
          accessibilityLabel="New workout"
          testID="workouts-new"
        >
          <Text style={styles.fabText}>New workout</Text>
        </Pressable>
      )}

      <NewWorkoutSheet
        visible={composing}
        onClose={() => setComposing(false)}
        onCreated={() => {
          setComposing(false);
          load();
        }}
      />
    </View>
  );
}

function NewWorkoutSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (w: Workout) => void;
}) {
  const getToken = useAuthToken();
  const [name, setName] = useState('');
  const [sport, setSport] = useState<Sport>('strength');
  const [goal, setGoal] = useState<Goal>('general');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const w = await createWorkout(getToken, {
        name: name.trim(),
        sport,
        // Goal only applies to strength — sending one for a run would be
        // noise, and the API would rightly ignore it.
        goal: sport === 'strength' ? goal : null,
        visibility: isPublic ? 'public' : 'private',
      });
      setName('');
      setIsPublic(false);
      onCreated(w);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={12}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>New workout</Text>
          <Pressable
            onPress={submit}
            disabled={busy || !name.trim()}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || !name.trim(), busy }}
            hitSlop={12}
            testID="new-workout-create"
          >
            <Text style={[styles.link, (!name.trim() || busy) && styles.linkDisabled]}>
              {busy ? '…' : 'Create'}
            </Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.input}
          placeholder="Name — e.g. Push Day A"
          placeholderTextColor="#767676"
          accessibilityLabel="Workout name"
          value={name}
          onChangeText={setName}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
          maxLength={80}
          testID="new-workout-name"
        />

        <Text style={styles.label}>Discipline</Text>
        <View style={styles.chips}>
          {SPORTS.map((s) => (
            <Chip
              key={s.key}
              label={s.label}
              active={sport === s.key}
              onPress={() => setSport(s.key)}
              testID={`new-workout-sport-${s.key}`}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          A workout is one discipline — that&apos;s what lets the exercise picker show only
          what fits.
        </Text>

        {sport === 'strength' && (
          <>
            <Text style={styles.label}>Goal</Text>
            <View style={styles.chips}>
              {GOALS.map((g) => (
                <Chip
                  key={g.key}
                  label={g.label}
                  active={goal === g.key}
                  onPress={() => setGoal(g.key)}
                  testID={`new-workout-goal-${g.key}`}
                />
              ))}
            </View>
          </>
        )}

        <Pressable
          style={styles.toggleRow}
          onPress={() => setIsPublic((v) => !v)}
          accessibilityRole="switch"
          accessibilityState={{ checked: isPublic }}
          accessibilityLabel="Share this workout publicly"
          testID="new-workout-public"
        >
          <View style={styles.toggleBody}>
            <Text style={styles.label}>Share publicly</Text>
            <Text style={styles.muted}>Anyone can view it. You stay the only editor.</Text>
          </View>
          <View style={[styles.switch, isPublic && styles.switchOn]}>
            <View style={[styles.knob, isPublic && styles.knobOn]} />
          </View>
        </Pressable>

        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
      </View>
    </Modal>
  );
}

export function Chip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={{ top: 8, bottom: 8 }}
      testID={testID}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scopeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  scopeTab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
  },
  scopeTabActive: { backgroundColor: vola.lime, borderColor: vola.lime },
  scopeText: { fontWeight: '600' },
  scopeTextActive: { color: vola.navy },
  loader: { marginTop: 32 },
  list: { padding: 16, gap: 12, paddingBottom: TAB_BAR_CLEARANCE },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    padding: 14,
    gap: 4,
    backgroundColor: vola.surface,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 17, fontWeight: '700', flexShrink: 1 },
  cardMeta: { fontSize: 13, color: vola.textMuted, textTransform: 'capitalize' },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    color: vola.lime,
    backgroundColor: vola.surfaceRaised,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
  },
  empty: { alignItems: 'center', gap: 6, paddingTop: 48, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  error: { color: vola.danger, fontSize: 14, paddingHorizontal: 16, paddingTop: 10 },
  fab: {
    position: 'absolute',
    left: 16,
    right: 16,
    // Clears the floating tab bar, which now overlays the bottom of the
    // screen rather than reserving space below the content.
    bottom: TAB_BAR_CLEARANCE + 4,
    backgroundColor: vola.lime,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  fabText: { color: vola.navy, fontWeight: '700', fontSize: 16 },

  // A Modal renders outside the navigator, so nothing paints behind it —
  // this is the one place a screen-level container has to set its own
  // background. Without it the sheet falls through to iOS's default
  // white and the near-white body text disappears into it.
  sheet: { flex: 1, padding: 20, gap: 12, backgroundColor: vola.bg },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  link: { fontSize: 16, color: vola.lime, fontWeight: '600' },
  linkDisabled: { opacity: 0.35 },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
    marginTop: 8,
  },
  label: { fontSize: 15, fontWeight: '600', marginTop: 8 },
  hint: { fontSize: 12, color: vola.textMuted },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  chipActive: { backgroundColor: vola.lime, borderColor: vola.lime },
  chipText: { fontSize: 14, fontWeight: '600' },
  chipTextActive: { color: vola.navy },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  toggleBody: { flex: 1 },
  switch: {
    width: 50,
    height: 30,
    borderRadius: 999,
    backgroundColor: vola.line,
    padding: 3,
    justifyContent: 'center',
  },
  switchOn: { backgroundColor: vola.lime },
  knob: { width: 24, height: 24, borderRadius: 999, backgroundColor: vola.surface },
  knobOn: { alignSelf: 'flex-end', backgroundColor: vola.navy },
});
