import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAuth } from '@clerk/clerk-expo';

import { useAuthToken } from '@/lib/useAuthToken';
import { applySuggestions, fetchSuggestions, setsFromWorkout } from '@/lib/sessions';
import { cachedWorkouts, cacheWorkouts, startLocalSession, syncSessions } from '@/lib/sessionStore';
import { listWorkouts, SPORTS, summariseTargets, type Sport, type Workout } from '@/lib/workouts';

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
 */
export default function StartSessionScreen() {
  const { sport } = useLocalSearchParams<{ sport: Sport }>();
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const router = useRouter();

  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const label = SPORTS.find((s) => s.key === sport)?.label ?? 'Session';

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
          const suggestions = await fetchSuggestions(getToken, sets.map((x) => x.exercise_id));
          sets = applySuggestions(sets, suggestions);
        } catch {
          // A failed lookup must not stop the session starting — an empty
          // weight is an inconvenience, a blocked workout is a lost one.
        }
      }
      // Created locally, so a session starts with no signal at all. The push
      // is opportunistic — the ID is already fixed, so it can land later
      // without duplicating anything.
      const session = await startLocalSession(userId, {
        sport,
        name: workout ? workout.name : `${label} session`,
        workout_id: workout ? workout.id : null,
        sets,
      });
      syncSessions(userId, getToken).catch(() => {});
      // replace, not push: finishing a session and pressing back should not
      // land on the chooser that created it.
      router.replace(`/session/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  return (
    <View style={styles.container} testID="session-start-screen">
      <Stack.Screen options={{ title: `Start ${label}` }} />

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
                <View style={styles.cardBody}>
                  <Text style={styles.cardTitle}>{w.name}</Text>
                  <Text style={styles.muted}>
                    {w.items.length} {w.items.length === 1 ? 'exercise' : 'exercises'}
                    {w.items[0] ? ` · ${summariseTargets(w.items[0])}` : ''}
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
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
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 16,
  },
  cardBody: { flex: 1, gap: 3 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  chevron: { color: vola.textDim, fontSize: 22 },
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
