import { Link, useFocusEffect } from 'expo-router';
import { useAuth } from '@clerk/clerk-expo';
import { cachedWorkouts, cacheWorkouts, createLocalWorkout } from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { useCallback, useRef, useState, useEffect } from 'react';
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
import { SectionHeader } from '@/components/ui/Section';
import { WeekPlanner } from '@/components/WeekPlanner';
import { enabledSports, labelFor, moduleFor } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';
import {
  listWorkouts,
  GOALS,
  type Goal,
  type Sport,
  type Workout,
} from '@/lib/workouts';
import { vola } from '@/constants/Colors';
import { Icon } from '@/components/ui/Icon';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { useAccent } from '@/lib/AccentProvider';

const SCOPES = [
  { key: 'mine', label: 'My workouts' },
  { key: 'shared', label: 'Shared' },
] as const;

export default function WorkoutsScreen() {
  const accent = useAccent();
  // For the sport label on each card — the registry carries the acronym, so
  // this renders "BJJ" rather than the "Bjj" that capitalising a key gives.
  const { modules } = useModules();
  const getToken = useAuthToken();
  const { userId } = useAuth();

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
    // LOCAL FIRST. The plan is the thing you walk into a gym holding, and
    // until now this screen went straight to the network — so with no signal
    // it showed an error where the workouts should be, even though they were
    // already cached on the device for the offline session-start path.
    //
    // Only for `mine`: the shared tab is a browse surface over other people's
    // templates, and there is no honest local answer for "what has everyone
    // published" — an empty list would read as "nobody has shared anything".
    if (scope === 'mine' && userId) {
      try {
        const cached = await cachedWorkouts(userId);
        if (!controller.signal.aborted && cached.length > 0) {
          setWorkouts(cached);
          setEverLoaded(true);
          setLoading(false);
        }
      } catch {
        // The network read below is still the real attempt.
      }
    }

    try {
      const list = await listWorkouts(getToken, scope, controller.signal);
      if (!controller.signal.aborted) {
        setEverLoaded(true);
        // Cleared on success, not at request start — an error wiped up
        // front leaves the screen looking fine throughout a retry.
        setError(null);
        // Refresh the cache for next time. `mine` only: caching other
        // people's shared templates under this athlete's cache rows would
        // make them reappear as if they were theirs.
        if (scope === 'mine' && userId) {
          await cacheWorkouts(userId, list);
          // Render the RECONCILED cache, not the raw response.
          //
          // `cacheWorkouts` already keeps rows the server hasn't heard of and
          // drops ones it has deleted; rendering `list` threw that away. A
          // workout created offline vanished from the list the moment a stale
          // `listWorkouts` response landed — reliably, not rarely, because
          // creating one fires the sync request and this reload together —
          // and came back on the next focus. Reading back through the cache
          // makes what is on screen the same thing that is on disk.
          setWorkouts(await cachedWorkouts(userId));
        } else {
          setWorkouts(list);
        }
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
  }, [getToken, scope, userId]);

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
      {/* "Plan", not "Workouts": this screen is now the week's plan *and* the
          templates it draws from, and the tab bar has always called it Plan. */}
      <ScreenHeader title="Plan" />
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
              style={[
                styles.scopeTab,
                active && [
                  styles.scopeTabActive,
                  { backgroundColor: accent.accent, borderColor: accent.accent },
                ],
              ]}
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
          // Inside the list rather than pinned above it, so the planner
          // scrolls away and the templates get the full screen when you are
          // browsing them. The Library's permanently-pinned ~300pt header is
          // the counter-example this avoids.
          //
          // `mine` only: the shared tab is a browse surface over other
          // people's templates, and your own week has no business on it.
          ListHeaderComponent={
            scope === 'mine' ? (
              <View style={styles.planHeader}>
                <WeekPlanner userId={userId ?? null} modules={modules} />
                <SectionHeader label="Templates" />
              </View>
            ) : null
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
                {/* The same two marks the Today screen's session rows use — a
                    rule down the edge and a tinted disc — so a template and the
                    session it becomes read as the same discipline. */}
                <View
                  style={[
                    styles.cardRule,
                    { backgroundColor: sportColor(item.sport) ?? accent.accent },
                  ]}
                />
                {sportIcon(item.sport) && (
                  <View
                    style={[
                      styles.cardBadge,
                      { backgroundColor: sportTint(sportColor(item.sport) ?? accent.accent) },
                    ]}
                  >
                    <Icon
                      name={sportIcon(item.sport)!}
                      size={18}
                      color={sportColor(item.sport) ?? accent.accent}
                    />
                  </View>
                )}

                <View style={styles.cardBody}>
                  <View style={styles.cardHead}>
                    <Text style={styles.cardTitle}>{item.name}</Text>
                    {item.visibility === 'public' && (
                      <Text
                        style={[styles.badge, { color: accent.ink }]}
                        testID={`workout-${item.id}-public`}
                      >
                        Shared
                      </Text>
                    )}
                  </View>
                  <Text style={styles.cardMeta}>
                    {labelFor(modules, item.sport)}
                    {item.goal ? ` · ${GOALS.find((g) => g.key === item.goal)?.label}` : ''}
                    {` · ${item.items.length} ${item.items.length === 1 ? 'exercise' : 'exercises'}`}
                  </Text>
                  {item.owner_user_id === null && <Text style={styles.muted}>VOLA template</Text>}
                </View>
              </Pressable>
            </Link>
          )}
        />
      )}

      {scope === 'mine' && (
        <Pressable
          style={[styles.fab, { backgroundColor: accent.accent }]}
          onPress={() => setComposing(true)}
          accessibilityRole="button"
          accessibilityLabel="New workout"
          testID="workouts-new"
        >
          <Text style={[styles.fabText, { color: accent.on }]}>New workout</Text>
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
  const accent = useAccent();
  const [name, setName] = useState('');
  // The first sport this athlete actually trains, not a hardcoded 'strength'.
  // A strength-disabled athlete would otherwise silently create strength
  // workouts every time.
  const { modules } = useModules();
  const { userId } = useAuth();
  const startable = enabledSports(modules);
  const [sport, setSport] = useState<Sport>((startable[0]?.key ?? 'strength') as Sport);
  // Corrects itself when the registry resolves, and again if the selected
  // discipline is ever turned off.
  //
  // There was a `sportTouched` flag here to stop a late registry overwriting a
  // user's choice. It couldn't: a tap can only select a chip that is rendered,
  // and a rendered chip is by definition enabled, so the condition below is
  // already false for anything the user picked. All the flag actually did was
  // PRESERVE the one invalid state — a selection whose discipline was since
  // disabled, showing no active chip while still creating workouts in it.
  useEffect(() => {
    if (startable.length > 0 && !startable.some((m) => m.key === sport)) {
      setSport(startable[0].key as Sport);
    }
  }, [startable, sport]);
  const [goal, setGoal] = useState<Goal>('general');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Created LOCALLY, then pushed. A plan you build with no signal is a
      // plan, not a failed request — and the id is generated here, so the
      // push is idempotent and any session started from it references the
      // same workout the server eventually receives.
      const w = await createLocalWorkout(userId!, {
        name: name.trim(),
        sport,
        // Goal only applies to strength — sending one for a run would be
        // noise, and the API would rightly ignore it.
        // Capability, not a sport name: a future discipline with goals needs
        // no change here.
        goal: moduleFor(modules, sport)?.capabilities.has_goals ? goal : null,
        visibility: isPublic ? 'public' : 'private',
      });
      requestSync('workout-created');
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
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={12}>
            <Text style={[styles.link, { color: accent.ink }]}>Cancel</Text>
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
            <Text
              style={[
                styles.link,
                { color: accent.ink },
                (!name.trim() || busy) && styles.linkDisabled,
              ]}
            >
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
          {startable.length === 0 && (
            <Text style={styles.muted}>
              You haven&apos;t turned on any disciplines yet — choose what you train in your profile
              first.
            </Text>
          )}
          {startable.map((s) => (
            <Chip
              key={s.key}
              label={s.label}
              active={sport === s.key}
              onPress={() => {
                setSport(s.key as Sport);
              }}
              testID={`new-workout-sport-${s.key}`}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          A workout is one discipline — that&apos;s what lets the exercise picker show only what
          fits.
        </Text>

        {moduleFor(modules, sport)?.capabilities.has_goals && (
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
          <View
            style={[styles.switch, isPublic && [styles.switchOn, { backgroundColor: accent.accent }]]}
          >
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
  const accent = useAccent();

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        active && [
          styles.chipActive,
          { backgroundColor: accent.accent, borderColor: accent.accent },
        ],
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={{ top: 8, bottom: 8 }}
      testID={testID}
    >
      <Text style={[styles.chipText, active && [styles.chipTextActive, { color: accent.on }]]}>{label}</Text>
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
  scopeTabActive: {},
  scopeText: { fontWeight: '600' },
  scopeTextActive: { color: vola.navy },
  loader: { marginTop: 32 },
  list: { padding: 16, gap: 12, paddingBottom: TAB_BAR_CLEARANCE },
  // The list's own `gap` doesn't apply between a header and the first row, so
  // the spacing below the planner is the header's to own.
  planHeader: { gap: 18, marginBottom: 4 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    overflow: 'hidden',
  },
  cardRule: { width: 3, alignSelf: 'stretch' },
  cardBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  cardBody: { flex: 1, padding: 14, gap: 4 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 17, fontWeight: '700', flexShrink: 1 },
  cardMeta: { fontSize: 13, color: vola.textMuted, textTransform: 'capitalize' },
  badge: {
    fontSize: 11,
    fontWeight: '700',
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
    bottom: 16,
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
  link: { fontSize: 16, fontWeight: '600' },
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
  chipActive: {},
  chipText: { fontSize: 14, fontWeight: '600' },
  chipTextActive: {},
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
  switchOn: {},
  knob: { width: 24, height: 24, borderRadius: 999, backgroundColor: vola.surface },
  knobOn: { alignSelf: 'flex-end', backgroundColor: vola.navy },
});
