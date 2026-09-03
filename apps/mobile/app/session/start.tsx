import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { request as requestSync } from '@/lib/sync';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { Icon } from '@/components/ui/Icon';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { useAccent } from '@/lib/AccentProvider';
import { useAuth } from '@clerk/clerk-expo';

import { backdatedTimestamp } from '@/lib/calendar';
import { labelFor } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';
import { applySuggestions, fetchSuggestions, setsFromWorkout } from '@/lib/sessions';
import { cachedExercises, cachedWorkouts, cacheWorkouts, startLocalSession } from '@/lib/sessionStore';
import { sessionHref } from '@/lib/startSession';
import { listWorkouts, summariseTargets, type Sport, type Workout } from '@/lib/workouts';

/**
 * Choosing what to train, before anything is created.
 *
 * The first version jumped straight from a sport to an empty session, which
 * got the common case backwards: someone who has written a plan wants to
 * *perform the plan*, and building it again exercise by exercise at the rack
 * is the thing the plan existed to avoid. So the templates come first and the
 * empty session is the fallback — and when there are none for this sport, the
 * screen says so and offers the one thing that fixes it rather than leaving a
 * blank list.
 *
 * **N434/#721 — a `?date=` reaches here for a missed strength session.**
 * Reused, deliberately, rather than a separate "backfill a summary" screen:
 * the live set logger this leads into already supports entering a session
 * after the fact with no signal, and a second flow doing the same job with a
 * narrower feature set is the divergence this module pattern exists to avoid.
 * The one thing a backdated session does NOT get for free is a correctly
 * backdated `ended_at` if the athlete resumes it days later — `Finish` always
 * writes the moment it is pressed, same as any other unfinished session; see
 * the history entry for why that is scoped out rather than silently wrong.
 */
export default function StartSessionScreen() {
  const accent = useAccent();
  const { modules } = useModules();
  // `workout` arrives only from a planned day on the Today screen: the plan
  // already names the template, so re-asking which one would make "start
  // today's session" a two-step chooser again.
  //
  // `date` is N434/#721: a day key, present only when this is backfilling a
  // missed session for a past day rather than starting today's — carried
  // through by `startSessionHref`'s `?date=`. Absent on the ordinary path.
  const { sport, workout: plannedWorkoutId, date } = useLocalSearchParams<{
    sport: Sport;
    workout?: string;
    date?: string;
  }>();
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const { units } = useUnits();
  const router = useRouter();

  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const label = labelFor(modules, sport) || 'Session';

  const load = useCallback(async () => {
    if (!sport || !userId) return;
    // Cache first so the list renders with no signal, then refresh it.
    try {
      const cached = await cachedWorkouts(userId, sport);
      if (cached.length > 0) setWorkouts(cached);
    } catch {
      /* an empty cache is just an empty list */
    }
    try {
      const list = await listWorkouts(getToken, 'mine');
      setWorkouts(list.filter((w) => w.sport === sport));
      await cacheWorkouts(userId, list);
      setError(null);
    } catch {
      // Offline is not an error here — whatever the cache had is on screen,
      // and an empty session is always available below.
    } finally {
      setLoading(false);
    }
  }, [getToken, sport, userId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Auto-start the planned template, once the list it lives in has loaded.
   *
   * `autoStarted` is a ref rather than state deliberately: `begin` sets
   * `starting`, which re-renders, and a state guard read in the same effect
   * would be stale on that pass — the session would be created twice, with
   * two different client ids, and both would sync.
   *
   * Falls through to the normal chooser when the id matches nothing. That is
   * a reachable state, not a defensive flourish: a plan can outlive the
   * template it points at (there is no foreign key, by design), and silently
   * starting *something else* would be worse than asking.
   */
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || loading || !plannedWorkoutId) return;
    const planned = workouts.find((w) => w.id === plannedWorkoutId);
    if (!planned) return;
    autoStarted.current = true;
    begin(planned);
    // `begin` is redeclared every render and is not a dependency worth
    // stabilising here — the ref is what makes this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, plannedWorkoutId, workouts]);

  async function begin(workout: Workout | null) {
    if (starting || !sport || !userId) return;
    setStarting(true);
    setError(null);
    try {
      let sets = workout ? setsFromWorkout(workout.items) : [];
      if (sets.length > 0) {
        // Opening a planned session at an empty weight makes you remember
        // last week's numbers yourself, which is the job the app exists to
        // do. Where the plan doesn't prescribe a weight, history fills it.
        try {
          const suggestions = await fetchSuggestions(
            getToken,
            sets.map((x) => x.exercise_id),
            workout?.goal ?? null,
            undefined,
            undefined,
            // N473/#812 item 8 — see fetchSuggestions's own doc comment.
            units,
          );
          // The catalog goes with it, so a dual-mode set already prescribed in
          // seconds does not also acquire a rep target — a row holding both is
          // a row two readers describe differently. See lib/setMode.ts.
          //
          // From the local cache rather than the network: this whole path has
          // to work with no signal, and a lookup that failed would silently
          // reintroduce the thing the argument exists to prevent.
          const loadTypes = new Map(
            (await cachedExercises(sport).catch(() => [])).map((e) => [e.id, e.load_type]),
          );
          sets = applySuggestions(sets, suggestions, (id) => loadTypes.get(id));
        } catch {
          // A failed lookup must not stop the session starting — an empty
          // weight is an inconvenience, a blocked workout is a lost one.
        }
      }
      // Created locally, so a session starts with no signal at all. The push
      // is opportunistic — the ID is already fixed, so it can land later
      // without duplicating anything.
      //
      // N434/#721: `date` absent means no `started_at` override at all, so
      // `startLocalSession` defaults to `new Date()` exactly as before this
      // ticket touched the file — the live, current-day flow is unaffected.
      // Present, it backdates the CALENDAR DAY only, keeping the time of day
      // the athlete is actually starting this at.
      const session = await startLocalSession(userId, {
        sport,
        name: workout ? workout.name : `${label} session`,
        workout_id: workout ? workout.id : null,
        sets,
        ...(date ? { started_at: backdatedTimestamp(date, new Date()).toISOString() } : {}),
      });
      requestSync('session-started');
      // replace, not push: finishing a session and pressing back should not
      // land on the chooser that created it.
      //
      // `sessionHref`, not a hardcoded `/session/${id}` — that hardcoding is
      // exactly the N460 bug: it sent every sport, running included, to the
      // strength-shaped live set logger, which has no notion of a GPS track.
      // `sessionHref` is the one place this branch is decided, so a running
      // session and a strength session diverge here and only here.
      router.replace(sessionHref({ id: session.id, sport }, modules));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  // N434/#721: names the day in the header rather than only in the title —
  // the header survives scrolling and every branch below it (loading, the
  // empty state, the workout list), so this is cheaper than repeating a
  // banner in each.
  const title = date
    ? `Log ${label} — ${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      })}`
    : `Start ${label}`;

  return (
    <View style={styles.container} testID="session-start-screen">
      <Stack.Screen options={{ title }} />

      <ScrollView contentContainerStyle={styles.scroll}>
        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}

        {loading ? (
          <ActivityIndicator accessibilityLabel="Loading your workouts" style={styles.loading} />
        ) : workouts.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No {label} workouts yet</Text>
            <Text style={styles.muted}>
              Build one once and every session after this starts from it, already filled in.
            </Text>
            <Pressable
              style={styles.secondary}
              onPress={() => router.replace('/(tabs)/workouts')}
              accessibilityRole="button"
              testID="start-create-workout"
            >
              <Text style={styles.secondaryText}>Create a workout</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.sectionLabel}>From a workout</Text>
            {workouts.map((w) => (
              <Pressable
                key={w.id}
                style={[styles.card, starting && styles.disabled]}
                onPress={() => begin(w)}
                disabled={starting}
                accessibilityRole="button"
                accessibilityLabel={`Start ${w.name}`}
                accessibilityState={{ disabled: starting }}
                testID={`start-workout-${w.id}`}
              >
                {/* The same two marks a template carries on the Plan tab: a
                    rule in the discipline's colour and a tinted disc. This is
                    the same object in a different place, so it should not be a
                    different shape. */}
                <View
                  style={[
                    styles.cardRule,
                    { backgroundColor: sportColor(w.sport) ?? accent.accent },
                  ]}
                />
                {sportIcon(w.sport) && (
                  <View
                    style={[
                      styles.cardBadge,
                      { backgroundColor: sportTint(sportColor(w.sport) ?? accent.accent) },
                    ]}
                  >
                    <Icon
                      name={sportIcon(w.sport)!}
                      size={18}
                      color={sportColor(w.sport) ?? accent.accent}
                    />
                  </View>
                )}
                <View style={styles.cardBody}>
                  <Text style={styles.cardTitle}>{w.name}</Text>
                  <Text style={styles.muted}>
                    {w.items.length} {w.items.length === 1 ? 'exercise' : 'exercises'}
                    {w.items[0] ? ` · ${summariseTargets(w.items[0], units)}` : ''}
                  </Text>
                </View>
                <Icon name="chevron" size={15} color={vola.textDim} />
              </Pressable>
            ))}
          </>
        )}

        {!loading && (
          <>
            <Text style={styles.sectionLabel}>Or</Text>
            <Pressable
              style={[styles.secondary, starting && styles.disabled]}
              onPress={() => begin(null)}
              disabled={starting}
              accessibilityRole="button"
              accessibilityLabel={`Start an empty ${label} session`}
              accessibilityState={{ busy: starting, disabled: starting }}
              testID="start-empty"
            >
              {starting ? (
                <ActivityIndicator />
              ) : (
                <Text style={styles.secondaryText}>Start an empty session</Text>
              )}
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 10, paddingBottom: 48 },
  loading: { marginTop: 32 },
  sectionLabel: { fontSize: 12, color: vola.textDim, textTransform: 'uppercase', marginTop: 8 },
  // Geometry copied from the Plan tab's template card rather than approximated:
  // no `gap` on the row, the disc's own `marginLeft` doing the spacing, and the
  // body carrying its own padding. Keeping `gap: 12` as well put the disc 24pt
  // from the rule instead of 12 — the same card, visibly not the same shape.
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    overflow: 'hidden',
    paddingRight: 16,
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
  // `paddingLeft` matches Plan's 14 and also covers the case `sport.ts` says is
  // legitimate — an unknown discipline draws no disc, and the title would
  // otherwise sit hard against the rule.
  cardBody: { flex: 1, gap: 3, paddingVertical: 16, paddingLeft: 14 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  secondary: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  secondaryText: { fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.5 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emptyTitle: { fontSize: 17, fontWeight: '700' },
  muted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  error: { color: vola.danger, fontSize: 14 },
});
