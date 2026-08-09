import { useCallback, useState } from 'react';
import type { TokenGetter } from '@/lib/useAuthToken';
import { ActivityIndicator, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { Medal } from '@/components/ui/Medal';
import { StatValue } from '@/components/ui/Stat';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { cachedExercises } from '@/lib/sessionStore';
import {
  basisFor,
  describeEvidence,
  fetchRecords,
  formatRecord,
  RECORD_LABEL,
  type ExerciseRecords,
} from '@/lib/records';
import type { UnitSystem } from '@/lib/units';

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
  const accent = useAccent();
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
          <Text style={[styles.action, { color: accent.ink }]}>Choose</Text>
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
        <View style={styles.list}>
          {records.map((er, i) => {
            // The headline record is the first the API returns; the rest ride
            // along on one line beneath. Two records per lift answer different
            // questions (see the file header), so neither is dropped — but one
            // of them is what you would say out loud, and that is the one that
            // gets the size.
            const [primary, ...rest] = er.records;
            // The API only groups an exercise that has at least one record, so
            // this is unreachable today — but the code it replaced was total
            // (a `.map`), TypeScript will not flag the destructure, and there
            // is no error boundary above this: a loosened contract would take
            // the whole You tab down rather than drop one row.
            if (!primary) return null;
            const fresh = er.records.some((r) => r.is_recent);
            const name = names.get(er.exercise_id) ?? er.exercise_id;
            const evidence = describeEvidence(primary, units);
            // "Est." rather than a longer word, and only on the modelled kind.
            // The row is one line on a phone; the point is that the number
            // beside it was computed, not that the reader learns a taxonomy.
            const modelled = basisFor(primary.kind) === 'modelled';

            return (
              <Pressable
                key={er.exercise_id}
                onPress={() => router.push(`/exercise/${er.exercise_id}`)}
                accessibilityRole="button"
                accessibilityLabel={[
                  name,
                  `${RECORD_LABEL[primary.kind]} ${formatRecord(primary, units)}`,
                  // Said in words for a screen reader, because the visual cue
                  // for this is a style and a style announces nothing.
                  modelled ? 'an estimate' : null,
                  evidence.measured,
                  // "reported" out loud, so the rating is not heard as another
                  // measurement in the same list.
                  evidence.reported ? `reported ${evidence.reported}` : null,
                  ...rest.map(
                    (r) => `${RECORD_LABEL[r.kind]} ${formatRecord(r, units)}`,
                  ),
                  fresh ? 'set in the last 30 days' : null,
                ]
                  .filter(Boolean)
                  .join('. ')}
                testID={`record-${er.exercise_id}`}
                style={({ pressed }) => [
                  styles.row,
                  // One card of rows rather than a card per lift: five records
                  // used to be five bordered boxes down the screen, which is a
                  // lot of chrome for five numbers.
                  i > 0 && styles.rowDivided,
                  pressed && styles.rowPressed,
                ]}
              >
                <Medal tier={fresh ? 'gold' : 'silver'} />

                <RNView style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text style={styles.evidence} numberOfLines={1}>
                    {/* The word, not just the medal. A gold-versus-silver disc
                        is a convention someone has to learn, and this row used
                        to say "NEW" outright — the badge is the decoration and
                        this is the fact. */}
                    {fresh && <Text style={styles.fresh}>New · </Text>}
                    {[
                      evidence.measured || null,
                      ...rest.map(
                        (r) =>
                          `${RECORD_LABEL[r.kind]} ${formatRecord(r, units)}`,
                      ),
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                    {/* The rating, set apart rather than joined with the same
                        middle dot as the measurements. It is the athlete's
                        account of the set, not another column of it. */}
                    {evidence.reported ? (
                      <Text style={styles.reported}> · {evidence.reported}</Text>
                    ) : null}
                  </Text>
                </RNView>

                <RNView style={styles.value}>
                  <StatValue value={formatRecord(primary, units)} size={19} />
                  <Text style={styles.valueLabel}>
                    {RECORD_LABEL[primary.kind].toUpperCase()}
                    {/* A modelled number gets a mark a measured one does not.
                        `RECORD_LABEL` already reads "Est. 1RM", but that is the
                        name of the record — this says what sort of number it
                        is, and it stays right if the label is ever reworded. */}
                    {modelled ? <Text style={styles.modelled}> ~</Text> : null}
                  </Text>
                </RNView>
              </Pressable>
            );
          })}
        </View>
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
  // Colour set inline, from the accent.
  action: { fontWeight: '700', fontSize: 14 },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 10,
    marginTop: 4,
  },
  list: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    marginTop: 4,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  rowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: vola.line },
  rowPressed: { backgroundColor: vola.surfaceHover },
  main: { flex: 1, gap: 1 },
  name: { fontSize: 15, fontWeight: '700' },
  evidence: { fontSize: 12, color: vola.textMuted },
  fresh: { color: vola.lime, fontWeight: '700' },
  // Dimmer than the measurements it sits beside, and italic. The rating is
  // real information and is not the record — it should read as an aside, not
  // as another number in the row.
  reported: { color: vola.textDim, fontStyle: 'italic' },
  // The modelled mark. Same size as the label it trails so it reads as part of
  // it rather than as a stray character.
  modelled: { color: vola.textDim },
  value: { alignItems: 'flex-end', gap: 1 },
  valueLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8, color: vola.textDim },
  muted: { color: vola.textMuted, fontSize: 13 },
});
