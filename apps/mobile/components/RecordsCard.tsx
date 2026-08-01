import { useCallback, useState } from 'react';
import type { TokenGetter } from '@/lib/useAuthToken';
import { ActivityIndicator, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { cachedExercises } from '@/lib/sessionStore';
import {
  describeEvidence,
  fetchRecords,
  formatRecord,
  RECORD_LABEL,
  type ExerciseRecords,
} from '@/lib/records';
import { formatDistance, formatWeight, type UnitSystem } from '@/lib/units';

/**
 * Personal records, on the profile.
 *
 * Every number here is derived from the log rather than stored, which is what
 * makes it safe to show: correct a set or delete a session and the record
 * corrects itself. A stored PR would need retracting, and a stale one is the
 * single worst thing this feature could do — nobody wants to be congratulated
 * for a lift they didn't make.
 *
 * Two records per lift where both apply, because they answer different
 * questions: the heaviest is what you'd tell someone in a gym, the estimated
 * 1RM is what actually moves when you get stronger at any rep range.
 */
export function RecordsCard({
  getToken,
  units,
}: {
  getToken: TokenGetter;
  units: UnitSystem;
}) {
  const router = useRouter();
  const [records, setRecords] = useState<ExerciseRecords[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [failed, setFailed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      const c = new AbortController();
      fetchRecords(getToken, undefined, c.signal)
        .then((r) => {
          if (c.signal.aborted) return;
          setRecords(r);
          setFailed(false);
          // Names come from the cached catalog — the same one that makes a
          // session readable offline — so a record never renders as its slug.
          cachedExercises()
            .then((list) => setNames(new Map(list.map((e) => [e.id, e.name]))))
            .catch(() => {});
        })
        .catch(() => {
          if (!c.signal.aborted) setFailed(true);
        });
      return () => c.abort();
    }, [getToken]),
  );

  const fmtWeight = (kg: number) => formatWeight(kg, units);
  const fmtDistance = (m: number) => formatDistance(m, units);

  return (
    <>
      <RNView style={styles.head}>
        <Text style={styles.sectionLabel}>Records</Text>
        <Pressable
          onPress={() => router.push('/records/pinned')}
          hitSlop={10}
          accessibilityRole="button"
          testID="records-manage"
        >
          <Text style={styles.action}>Choose</Text>
        </Pressable>
      </RNView>

      {records === null ? (
        <View style={styles.card}>
          {failed ? (
            <Text style={styles.muted}>Couldn&apos;t load your records just now.</Text>
          ) : (
            <ActivityIndicator accessibilityLabel="Loading your records" />
          )}
        </View>
      ) : records.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.muted}>
            Log a few sets and your bests show up here — no setup needed.
          </Text>
        </View>
      ) : (
        records.map((er) => (
          <Pressable
            key={er.exercise_id}
            onPress={() => router.push(`/exercise/${er.exercise_id}`)}
            accessibilityRole="button"
            accessibilityLabel={`${names.get(er.exercise_id) ?? er.exercise_id} records`}
            testID={`record-${er.exercise_id}`}
          >
            <View style={styles.card}>
              <RNView style={styles.cardHead}>
                <Text style={styles.name}>{names.get(er.exercise_id) ?? er.exercise_id}</Text>
                {er.records.some((r) => r.is_recent) && (
                  // The one thing worth interrupting a scan for: this is new.
                  <Text style={styles.badge}>NEW</Text>
                )}
              </RNView>
              <RNView style={styles.values}>
                {er.records.map((r) => (
                  <RNView key={r.kind} style={styles.value}>
                    <Text style={styles.valueLabel}>{RECORD_LABEL[r.kind]}</Text>
                    <Text style={styles.valueNumber}>
                      {formatRecord(r, fmtWeight, fmtDistance)}
                    </Text>
                    {/* The set behind it. A number you can check beats one you
                        have to trust — same rule as the suggestions. */}
                    <Text style={styles.evidence}>
                      {describeEvidence(r, fmtWeight) || '—'}
                    </Text>
                  </RNView>
                ))}
              </RNView>
            </View>
          </Pressable>
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  action: { color: vola.lime, fontWeight: '700', fontSize: 14 },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 10,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  badge: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: vola.bg,
    backgroundColor: vola.lime,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  values: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  value: { gap: 1, minWidth: 96 },
  valueLabel: {
    fontSize: 10,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  valueNumber: { fontSize: 20, fontWeight: '800' },
  evidence: { fontSize: 11, color: vola.textMuted },
  muted: { color: vola.textMuted, fontSize: 13 },
});
