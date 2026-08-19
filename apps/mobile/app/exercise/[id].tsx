import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fetchExercises, pickImage, type Exercise } from '@/lib/exercises';
import { fetchSuggestions, type Suggestion } from '@/lib/sessions';
import { cachedExercises } from '@/lib/sessionStore';
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
  const accent = useAccent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();
  const { units } = useUnits();

  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [stats, setStats] = useState<Suggestion | null>(null);
  const [loading, setLoading] = useState(true);
  // `stats === null` after a *successful* fetch means "never logged". This
  // means the question was never answered. Conflating them is how the screen
  // came to tell people they'd never done an exercise they do every week.
  const [statsUnavailable, setStatsUnavailable] = useState(false);
  const [detailsUnavailable, setDetailsUnavailable] = useState(false);
  // A cache hit may or may not be complete, and the screen cannot tell which.
  //
  // Rows written since v10 store the WHOLE API payload (`payload_json`), so
  // they carry equipment, muscles, instructions and the note. Older rows have
  // no payload and are reconstructed from the typed columns with those fields
  // fabricated EMPTY — which is what this banner was written for, since
  // rendering that as complete asserts a barbell lift needs no equipment.
  //
  // `cachedExercises` returns both shapes indistinguishably, so the copy says
  // "may be missing" rather than naming fields. It used to name equipment and
  // technique notes specifically, which N39 turned into a visible contradiction:
  // a cached note renders directly above it. Naming a field this cannot check
  // is what made it wrong; telling the truth about the uncertainty is not.
  const [detailsFromCache, setDetailsFromCache] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const list = await fetchExercises(getToken, {});
        setExercise(list.find((e) => e.id === id) ?? null);
      } catch {
        // Offline: the catalog cache still holds this exercise's name and how
        // it's measured. Without consulting it the screen rendered the raw
        // UUID as its heading, which told the athlete nothing at all.
        const cached = await cachedExercises().catch(() => [] as Exercise[]);
        const hit = cached.find((e) => e.id === id) ?? null;
        setExercise(hit);
        if (hit) setDetailsFromCache(true);
        else setDetailsUnavailable(true);
      } finally {
        setLoading(false);
      }
      // History is a bonus, never a blocker — the catalog entry renders
      // whether or not this succeeds. But a failure has to be *said*, not
      // rendered as an absence of history.
      fetchSuggestions(getToken, [id])
        .then((m) => setStats(m.get(id) ?? null))
        .catch(() => setStatsUnavailable(true));
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

      {/* Never the bare id: a UUID as a heading is not a name, it's a leaked
          implementation detail standing where the answer should be. */}
      <Text style={styles.name}>{exercise?.name ?? 'Exercise'}</Text>
      {detailsUnavailable ? (
        <Text style={styles.meta}>Couldn&apos;t load this exercise&apos;s details right now.</Text>
      ) : (
        <Text style={styles.meta}>
          {exercise?.movement_pattern.replace(/_/g, ' ')}
          {/* Equipment is omitted for a cached entry rather than shown as
              absent: the cache never stored it, so "no suffix" would read as
              "needs no equipment" instead of "not known on this device". */}
          {!detailsFromCache && exercise?.equipment?.length
            ? ` · ${exercise.equipment[0].replace(/-/g, ' ')}`
            : ''}
        </Text>
      )}
      {detailsFromCache && (
        <Text style={styles.muted} testID="exercise-details-partial">
          Showing what&apos;s saved on this phone. Some details may be missing or out of date until
          you&apos;re back online.
        </Text>
      )}

      {/* Why the numbers are what they are, placed BEFORE the logging history
          rather than down with the instructions.

          This is read at the moment the athlete is deciding what to type into
          the weight field, so it has to sit above that decision — a counting
          rule explained underneath "How to do it", at the bottom of the screen,
          is one nobody reaches in the twenty seconds between sets.

          Deliberately not a labelled section: absent is the normal case (5 of
          762 catalog rows), and a heading that vanishes for the other 757 is
          exactly the empty affordance this field exists not to leave behind. */}
      {!!exercise?.note && (
        <View style={styles.note} testID="exercise-note">
          <Text style={styles.noteText}>{exercise.note}</Text>
        </View>
      )}

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
              <Text style={[styles.oneRmValue, { color: accent.ink }]}>
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
      ) : statsUnavailable ? (
        <View style={styles.card} testID="exercise-stats-unavailable">
          <Text style={styles.muted}>
            Couldn&apos;t load your history for this exercise. Anything you&apos;ve logged is still
            there — this screen just can&apos;t reach it right now.
          </Text>
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
  oneRmValue: { fontSize: 20, fontWeight: '800' },
  oneRmBest: { fontSize: 12, color: vola.textMuted },
  when: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  reason: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },
  muted: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  instructions: { color: vola.text, fontSize: 14, lineHeight: 21 },
  note: {
    marginTop: 12,
    paddingLeft: 12,
    // A left rule rather than a filled card: this is an aside about the exercise
    // above it, and a card would give it the same weight as "Your last session",
    // which is the screen's actual subject.
    borderLeftWidth: 2,
    borderLeftColor: vola.line,
  },
  noteText: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
});
