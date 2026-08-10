import { StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { Stat, StatRow } from '@/components/ui/Stat';
import { sportColor, sportIcon } from '@/components/ui/sport';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { formatDuration } from '@/lib/history';
import { labelFor, type Module } from '@/lib/modules';
import { formatVolume, type UnitSystem } from '@/lib/units';
import { deltaPct, leadMeasure, weekVerdict, type WeekReview as Review } from '@/lib/weekReview';

/**
 * The week, summed up.
 *
 * The calendar directly below this answers *which days*. This answers **how the
 * week went**, which is a different question and the one nothing on Today
 * answered before: a count of sessions says nothing without a comparison, and a
 * single tonnage figure hides whether the week was three lifts or three classes.
 *
 * ## Why every number here can be absent
 *
 * Three of them genuinely can be, and each renders as its own honest thing
 * rather than a zero:
 *
 * - **The comparison.** The local session list is bounded by count, so last
 *   week may be only partly on the device — `reviewWeek` returns `previous:
 *   null` rather than a total that is quietly too small. No delta is drawn.
 * - **A sport's tonnage.** BJJ cannot hold a set, so its volume is structurally
 *   zero; `leadMeasure` picks time for it instead. "0 kg" beside three hard
 *   classes is the fabricated-zero trap `describeSession` documents.
 * - **The plan.** A week nobody planned is not a week with 0% adherence.
 *
 * ## No score, no grade, no streak
 *
 * `weekVerdict` names what happened and stops. The one comparison it makes is
 * against the athlete's *own* plan, which is not the app having an opinion. A
 * number attached to a week invites shame-based framing, which this project
 * rules out by design.
 */
export function WeekReview({
  review,
  modules,
  units,
  unitsReady,
  testID,
}: {
  review: Review;
  modules: Module[];
  units: UnitSystem;
  /** Dash the volume until the unit is known — see Today's own note. */
  unitsReady: boolean;
  testID?: string;
}) {
  const accent = useAccent();
  const { totals, previous, bySport } = review;
  const trained = totals.sessions > 0;

  return (
    <View style={styles.card} testID={testID ?? 'week-review'}>
      <RNView style={styles.head}>
        <Text style={styles.label}>THIS WEEK</Text>
        {review.planned > 0 && (
          <Text style={[styles.plan, { color: review.met >= review.planned ? accent.ink : vola.textDim }]}>
            {review.met}/{review.planned} planned
          </Text>
        )}
      </RNView>

      <Text style={styles.verdict}>{weekVerdict(review)}</Text>

      {trained && (
        /*
          The Today screen's own stat row, kept — three discs in three hues
          because they are three unrelated measures rather than a ramp, and
          `heart` for sessions rather than a barbell because a week's count
          spans every discipline. What is new is `change`: the same tiles, now
          saying which way each moved. `Stat` renders nothing when the delta is
          null, so a device that cannot prove last week simply shows figures.
        */
        <StatRow testID="week-review-stats">
          <Stat
            label="Sessions"
            value={String(totals.sessions)}
            change={deltaPct(totals.sessions, previous?.sessions)}
            size={22}
            fit
            icon="heart"
            tone={accent.accent}
          />
          <Stat
            label="Days"
            value={String(totals.days)}
            change={deltaPct(totals.days, previous?.days)}
            size={22}
            fit
            icon="calendar"
            tone={vola.warn}
          />
          {/* Whichever measure the week actually produced — volume when there
              was lifting in it, time otherwise. A flat "0kg" on a pure mat week
              is the fabricated zero `describeSession` documents. */}
          {totals.volumeKg > 0 ? (
            <Stat
              label="Volume"
              value={unitsReady ? formatVolume(totals.volumeKg, units) : '—'}
              change={deltaPct(totals.volumeKg, previous?.volumeKg)}
              size={22}
              fit
              icon="barbell"
              tone={vola.info}
            />
          ) : (
            <Stat
              label="Time"
              value={totals.seconds > 0 ? formatDuration(totals.seconds) : '—'}
              change={deltaPct(totals.seconds, previous?.seconds)}
              size={22}
              fit
              icon="timer"
              tone={vola.info}
            />
          )}
        </StatRow>
      )}

      {bySport.length > 0 && (
        <RNView style={styles.sports}>
          {bySport.map((s) => {
            const tone = sportColor(s.sport) ?? accent.ink;
            const icon = sportIcon(s.sport);
            // `unitsReady` here too, not just on the tile above. Without it
            // this row renders kilograms for a moment to an athlete set to
            // pounds — the exact bug the old stat row fixed in place, and its
            // note says that moment is precisely when the screen is read. The
            // dash also has to reach the accessibility label, or the two
            // disagree about whether the number is known.
            // The time branch is guarded the same way the totals tile above
            // is, and for the same reason: `formatDuration(0)` returns "0m",
            // so a sport whose only session this week is still UNFINISHED
            // rendered "1× · 0m" — a fabricated zero, on a row whose own
            // comments condemn exactly that. It reaches the spoken label too,
            // which is why the dash is computed here rather than at render.
            const measure =
              leadMeasure(s) === 'volume'
                ? unitsReady
                  ? formatVolume(s.volumeKg, units)
                  : '—'
                : s.seconds > 0
                  ? formatDuration(s.seconds)
                  : '—';
            return (
              <RNView
                key={s.sport}
                style={styles.sportRow}
                accessible
                // One stop rather than four. Read piecemeal, VoiceOver gives
                // "BJJ", "3", "sessions", "4h 30m" as unrelated fragments.
                accessibilityLabel={`${labelFor(modules, s.sport)}, ${s.sessions} ${
                  s.sessions === 1 ? 'session' : 'sessions'
                }, ${measure}`}
              >
                {icon ? (
                  <RNView style={[styles.dot, { backgroundColor: `${tone}22` }]}>
                    <Icon name={icon} size={13} color={tone} />
                  </RNView>
                ) : (
                  <RNView style={[styles.plainDot, { backgroundColor: tone }]} />
                )}
                <Text style={styles.sportName}>{labelFor(modules, s.sport)}</Text>
                <Text style={styles.sportCount}>
                  {s.sessions}× · {measure}
                </Text>
              </RNView>
            );
          })}
        </RNView>
      )}

      {trained && previous === null && (
        // Says why there is no comparison rather than silently omitting it —
        // otherwise the deltas look like they vanished at random.
        <Text style={styles.footnote}>Not enough history on this device to compare weeks yet.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Deliberately not a card. `StatRow` brings its own surface and border, and
  // nesting that inside a second one gives the double frame that reads as a
  // rendering mistake. This is a labelled group, like Today's other sections.
  card: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 11, color: vola.textDim, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '600' },
  plan: { fontSize: 12, fontWeight: '700' },
  verdict: { fontSize: 15, fontWeight: '600', lineHeight: 21 },


  sports: {
    gap: 8,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sportRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  dot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  plainDot: { width: 8, height: 8, borderRadius: 4, marginHorizontal: 8 },
  sportName: { flex: 1, fontSize: 14, fontWeight: '600' },
  sportCount: { fontSize: 13, color: vola.textMuted, fontVariant: ['tabular-nums'] },

  footnote: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
});
