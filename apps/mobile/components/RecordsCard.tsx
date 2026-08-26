import { Pressable, StyleSheet, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';

import { ReadingState, StaleNote } from '@/components/progress/Reading';
import { Text, View } from '@/components/Themed';
import { Medal } from '@/components/ui/Medal';
import { StatValue } from '@/components/ui/Stat';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import type { Reading } from '@/lib/progress';
import {
  basisFor,
  describeEvidence,
  formatRecord,
  RECORD_LABEL,
  type ExerciseRecords,
} from '@/lib/records';
import type { UnitSystem } from '@/lib/units';

/**
 * Personal records, on the Progress tab.
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
 *
 * ## Why it no longer fetches
 *
 * It lived on the You tab and owned its own `fetchRecords`, which was right
 * while it was the only thing on the phone that wanted records. N178 moved it
 * to Progress, where the "What changed" block reads the SAME list to say
 * whether anything is newly a best — and two components fetching `/v1/records`
 * on one screen focus is both a wasted request and two answers that can
 * disagree with each other a few hundred points apart.
 *
 * So the screen owns the read and this renders it. The four states it used to
 * juggle by hand — null-and-loading, null-and-failed, empty, populated — are
 * now the {@link Reading} union, which is the same distinction spelled out in
 * a type rather than in a nested ternary. Nothing about the rendering changed.
 */
export function RecordsCard({
  records,
  names,
  units,
}: {
  records: Reading<ExerciseRecords[]>;
  /** Exercise id → human name, from the cached catalog. */
  names: Map<string, string>;
  units: UnitSystem;
}) {
  const accent = useAccent();
  const router = useRouter();

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

      {/*
        No `offLabel`: the records reading is built with a `failed` and an
        `isEmpty` but no `enabled`, so `off` is unconstructible for it and a
        label naming Strength would be dead configuration that also implies
        records are module-gated when they are not. Same reasoning as the
        `empty={null}` on the week — see `ReadingState`'s note. Add one here if
        records ever do become gated.
      */}
      <ReadingState
        reading={records}
        subject="your records"
        empty="Log a few sets and your bests show up here — no setup needed."
        testID="records-state"
      />
      <StaleNote reading={records} testID="records-stale" />

      {records.state === 'ready' && (
        <View style={styles.list}>
          {records.value.map((er, i) => {
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
            // Feeds the accessibility string only — see the note at the value
            // label for why this row carries no separate visual marker.
            const modelled = basisFor(primary.kind) === 'modelled';
            // Joined ahead of the JSX so the rating's "· " below can key off
            // whether anything actually precedes it — a timed record whose set
            // carried only an RPE would otherwise open with a separator
            // separating nothing.
            const measuredLine = [
              evidence.measured || null,
              ...rest.map(
                (r) => `${RECORD_LABEL[r.kind]} ${formatRecord(r, units)}`,
              ),
            ]
              .filter(Boolean)
              .join(' · ');

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
                    {/* The em dash means "no set detail to show". It is only
                        right when there is nothing else on the line — beside a
                        rating it reads as a rendering fault rather than as an
                        absence, which is the case for a timed or distance
                        record that carries an RPE. */}
                    {measuredLine || (evidence.reported ? '' : '—')}
                    {/* The rating, set apart rather than joined with the same
                        middle dot as the measurements. It is the athlete's
                        account of the set, not another column of it. The
                        separator only appears when a measurement stands before
                        it — a rating alone opens the line. */}
                    {evidence.reported ? (
                      <Text style={styles.reported}>
                        {measuredLine ? ' · ' : ''}
                        {evidence.reported}
                      </Text>
                    ) : null}
                  </Text>
                </RNView>

                <RNView style={styles.value}>
                  <StatValue value={formatRecord(primary, units)} size={19} />
                  {/* No visual basis marker here, deliberately. A trailing "~"
                      was tried and dropped: at 9pt in `textDim` it was close to
                      invisible, a tilde after an uppercase label means nothing
                      to anyone, and it was redundant with the label already
                      reading "EST. 1RM". The distinction is carried by the
                      label the athlete can read and by "an estimate" in the
                      accessibility string. Web has the room to spell it out and
                      does; a phone row does not. */}
                  <Text style={styles.valueLabel}>
                    {RECORD_LABEL[primary.kind].toUpperCase()}
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
  // `textMuted`, NOT `textDim`. This file's own comment calls the rating "real
  // information", and `constants/Colors.ts` measures `textDim` at 2.51:1 and
  // says outright it is therefore not used to carry information. Italic alone
  // still sets it apart from the upright measurements beside it.
  reported: { color: vola.textMuted, fontStyle: 'italic' },
  value: { alignItems: 'flex-end', gap: 1 },
  valueLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8, color: vola.textDim },
});
