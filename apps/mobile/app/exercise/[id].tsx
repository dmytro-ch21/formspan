import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import { fetchSuggestions, type Suggestion } from '@/lib/sessions';
import { formatEstimate, formatWeight } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * One exercise, with what you last did on it.
 *
 * The catalog entry alone is reference material anyone could look up. What
 * makes it worth opening is the line underneath: last weight, reps, how hard
 * it felt, and when. That turns "what is a Bulgarian split squat" into "what
 * did *I* do last time", which is the only version of the question anyone
 * asks standing in a gym.
 *
 * The stats come from the same endpoint that drives progressive overload, so
 * what this screen shows and what the session screen recommends cannot drift
 * apart.
 */
export default function ExerciseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();
  const { units } = useUnits();

  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [stats, setStats] = useState<Suggestion | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const list = await fetchExercises(getToken, {});
        setExercise(list.find((e) => e.id === id) ?? null);
      } catch {
        /* the empty state covers it */
      } finally {
        setLoading(false);
      }
      // History is a bonus, never a blocker — the catalog entry renders
      // whether or not this succeeds.
      fetchSuggestions(getToken, [id])
        .then((m) => setStats(m.get(id) ?? null))
        .catch(() => {});
    })();
  }, [getToken, id]);

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator accessibilityLabel="Loading exercise" />
      </View>
    );
  }

  const uri = exercise ? pickImage(exercise, 'demo') : null;
  const done = stats?.last_weight_kg != null || stats?.last_reps != null;

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="exercise-detail">
      <Stack.Screen options={{ title: exercise?.name ?? 'Exercise' }} />

      {uri && <Image source={{ uri }} style={styles.hero} contentFit="cover" alt="" />}

      <Text style={styles.name}>{exercise?.name ?? id}</Text>
      <Text style={styles.meta}>
        {exercise?.movement_pattern.replace(/_/g, ' ')}
        {exercise?.equipment?.length ? ` · ${exercise.equipment[0].replace(/-/g, ' ')}` : ''}
      </Text>

      <Text style={styles.sectionLabel}>Your last session</Text>
      {done ? (
        <View style={styles.card}>
          <View style={styles.statRow}>
            <Stat
              label="Weight"
              value={stats?.last_weight_kg != null ? formatWeight(stats.last_weight_kg, units) : '—'}
            />
            <Stat label="Reps" value={stats?.last_reps != null ? String(stats.last_reps) : '—'} />
            <Stat
              label="Effort"
              value={
                stats?.last_rir != null
                  ? `${stats.last_rir} RIR`
                  : stats?.last_rpe != null
                    ? `RPE ${stats.last_rpe}`
                    : '—'
              }
            />
          </View>
          {/* The estimate sits with the set it came from, not in a separate
              "analysis" section — it's a reading of that set, and splitting
              them would invite reading it as a measured number. */}
          {stats?.estimated_1rm_kg != null && (
            <View style={styles.oneRm}>
              <Text style={styles.oneRmLabel}>Estimated 1RM</Text>
              <Text style={styles.oneRmValue}>
                {formatEstimate(stats.estimated_1rm_kg, units)}
              </Text>
              {stats.best_1rm_kg != null && (
                <Text style={styles.oneRmBest}>
                  {/* Compared at display precision, not raw kg: 143.6 and
                      144.0 both render "144kg", and showing the same number
                      twice with "best" beside it reads as a regression. */}
                  {formatEstimate(stats.estimated_1rm_kg, units) ===
                  formatEstimate(stats.best_1rm_kg, units)
                    ? 'your best'
                    : `best ${formatEstimate(stats.best_1rm_kg, units)}`}
                </Text>
              )}
            </View>
          )}
          {stats?.last_performed_at && (
            <Text style={styles.when}>
              {new Date(stats.last_performed_at).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </Text>
          )}
          {/* The recommendation's own words, so this screen and the session
              screen never disagree about what to do next. */}
          {stats?.reason && <Text style={styles.reason}>{stats.reason}</Text>}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>
            You haven&apos;t logged this yet. Once you do, your last weight, reps and effort show
            up here.
          </Text>
        </View>
      )}

      {!!exercise?.instructions && (
        <>
          <Text style={styles.sectionLabel}>How to do it</Text>
          <Text style={styles.instructions}>{exercise.instructions}</Text>
        </>
      )}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 20, gap: 8, paddingBottom: 48 },
  hero: { width: '100%', height: 200, borderRadius: 16, backgroundColor: vola.surfaceRaised },
  name: { fontSize: 24, fontWeight: '800', marginTop: 8 },
  meta: { color: vola.textMuted, fontSize: 13, textTransform: 'capitalize' },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 20,
  },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 16,
    gap: 10,
  },
  statRow: { flexDirection: 'row', gap: 10 },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontSize: 20, fontWeight: '800' },
  statLabel: { fontSize: 11, color: vola.textDim },
  oneRm: {
    flexDirection: 'row',
    alignItems: 'baseline',
    // Text scales with the OS setting; without wrap the three children get
    // squeezed and break mid-word at large Dynamic Type.
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: vola.lineSoft,
  },
  oneRmLabel: { fontSize: 12, color: vola.textDim, textTransform: 'uppercase', letterSpacing: 0.8 },
  oneRmValue: { fontSize: 20, fontWeight: '800', color: vola.lime },
  oneRmBest: { fontSize: 12, color: vola.textMuted },
  when: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  reason: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },
  muted: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  instructions: { color: vola.text, fontSize: 14, lineHeight: 21 },
});
