import { StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { InfoMark } from '@/components/ui/InfoSheet';
import { HRTimelineChart } from '@/components/ui/HRTimelineChart';
import { SectionHeader } from '@/components/ui/Section';
import { Stat, StatRow } from '@/components/ui/Stat';
import { vola } from '@/constants/Colors';
import { buildHRSessionReport, type HRExerciseRow, type HRZoneRow } from '@/lib/hrSessionReport';
import type { HRTimelinePoint } from '@/lib/hrTimeline';
import type { ExerciseHR, SessionMetrics } from '@/lib/biometric';

/**
 * The per-session heart-rate report — N488/#849. One component, reused
 * unchanged on the BJJ, strength and running session-detail screens (the
 * ticket's own explicit requirement: "same report component, reused across
 * all three — don't build three different HR widgets").
 *
 * All the "is this honest" decisions live in `lib/hrSessionReport.ts`'s
 * `buildHRSessionReport` — this component only renders whichever of its three
 * states comes back. Read that file's doc comment before changing what
 * appears here; the state machine is the part that took the design thought.
 *
 * `metrics` is `null` while a caller's own fetch has not settled — pass it
 * only once that fetch has resolved to a real answer (`SessionMetrics | null`
 * from `getSessionMetrics`), never mid-flight; see `hrSessionReport.ts`'s doc
 * comment on why that distinction is the caller's to keep, not this
 * component's to guess at.
 *
 * `hrTimeline` is N491/#852's addition — an optional, already-computed
 * `HRTimelinePoint[]` (`lib/hrTimeline.ts`'s `buildHRTimeline`, over the raw
 * samples `GET /v1/biometric/samples` returns for the session's own window).
 * Undefined/empty on every caller that hasn't wired it (strength, running,
 * and BJJ before this ticket) — this component draws nothing for it in that
 * case, so it is additive exactly the way `sessionRPE` was. See
 * `lib/hrTimeline.ts`'s doc comment for why this renders the raw shape
 * rather than a classified drill/roll boundary.
 *
 * `exerciseHR`/`exerciseNames` (N490/#851) are optional, strength-only
 * additions: BJJ and running have no per-exercise concept, so their call
 * sites simply omit both and get no breakdown section, rather than this
 * component branching on sport itself. Independent of `hrTimeline` above —
 * one caller (BJJ) can pass a timeline with no exercise breakdown, another
 * (strength) the reverse, and both can pass neither.
 */
export function HRSessionReport({
  metrics,
  sessionRPE = null,
  hrTimeline,
  exerciseHR = null,
  exerciseNames = {},
  testID = 'hr-session-report',
}: {
  metrics: SessionMetrics | null;
  /** The session's own 1-10 self-report, for the effectiveness calibration —
   *  `null` for sports with no single session-level RPE today (strength,
   *  running; see `hrSessionReport.ts`'s doc comment). */
  sessionRPE?: number | null;
  /** N491/#852: real HR readings across the session, already computed by the
   *  caller (`buildHRTimeline`). Omit, or pass `[]`, to render no timeline —
   *  the ordinary case for every screen except BJJ's today. */
  hrTimeline?: HRTimelinePoint[];
  /** The per-exercise breakdown (N490/#851) — `null` for sports with no
   *  per-exercise concept (BJJ, running). */
  exerciseHR?: Pick<ExerciseHR, 'exercise_id' | 'avg_hr_bpm' | 'max_hr_bpm' | 'sample_count'>[] | null;
  /** exercise_id -> display name, for labelling `exerciseHR` rows. Falls
   *  back to the raw id for an exercise the caller's own catalog read
   *  hasn't resolved yet — the same raw-id fallback this app's
   *  `exerciseName = exercise?.name ?? set.exercise_id` idiom already uses
   *  elsewhere for the identical reason (NOT `withExerciseNames`, which
   *  falls back to `null` instead). */
  exerciseNames?: Record<string, string>;
  testID?: string;
}) {
  const report = buildHRSessionReport(metrics, sessionRPE, exerciseHR, exerciseNames);

  if (report.state === 'unavailable') {
    return (
      <RNView style={styles.wrap} testID={testID}>
        <SectionHeader label="Heart rate" />
        <RNView style={styles.emptyCard} testID={`${testID}-unavailable`}>
          <Icon name="heart" size={18} color={vola.textDim} />
          <Text style={styles.emptyText}>
            No heart-rate data for this session — turn on Health sync in Settings, or it may not
            have synced yet.
          </Text>
        </RNView>
      </RNView>
    );
  }

  const hrStats: React.ReactNode[] = [];
  if (report.avgHR != null) {
    hrStats.push(<Stat key="avg" label="Avg HR" value={`${report.avgHR} bpm`} fit />);
  }
  if (report.maxHR != null) {
    hrStats.push(<Stat key="max" label="Max HR" value={`${report.maxHR} bpm`} fit />);
  }

  if (report.state === 'limited') {
    return (
      <RNView style={styles.wrap} testID={testID}>
        <SectionHeader label="Heart rate" />
        {hrStats.length > 0 && <StatRow testID={`${testID}-stats`}>{hrStats}</StatRow>}
        <RNView style={styles.limitedCard} testID={`${testID}-limited`}>
          <Text style={styles.limitedText}>
            {report.reason === 'sparse_samples'
              ? `Only ${report.sampleCount} reading${report.sampleCount === 1 ? '' : 's'} — not enough to show training load or heart-rate zones.`
              : 'Add your date of birth in your profile to unlock training load and zone breakdown.'}
          </Text>
        </RNView>
      </RNView>
    );
  }

  return (
    <RNView style={styles.wrap} testID={testID}>
      <SectionHeader
        label="Heart rate"
        info={
          <InfoMark
            about="Training load and heart-rate zones"
            title="Training load and heart-rate zones"
            body={[
              'TRIMP (training impulse) weighs every minute of this session by how hard your heart rate says it was — more minutes, or a higher zone, both push it up. It is a load number, not a grade: there is no target to hit.',
              'The five zones are bands of your estimated max heart rate — zone 1 (very light) through zone 5 (max effort). The breakdown below is minutes spent in each, only counting stretches with a real reading close enough together to trust.',
              ...(report.perExercise.length > 0
                ? [
                    "By exercise, further down, is a rougher read on the same evidence — each exercise's window is a few minutes at most, so its reading count is often low. Read it as a direction (this movement ran hotter than that one), not a precise figure.",
                  ]
                : []),
            ]}
            testID={`${testID}-info`}
          />
        }
      />

      <StatRow testID={`${testID}-stats`}>
        {hrStats}
        <Stat label="Training load" value={String(Math.round(report.trimp))} fit />
      </StatRow>

      {hrTimeline != null && hrTimeline.length >= 2 && (
        // N491/#852. Real readings, in order — no boundary drawn or claimed;
        // see lib/hrTimeline.ts's doc comment for why. `styles.zones`'s card
        // treatment reused verbatim so this reads as one more piece of real
        // evidence, not a different kind of thing from the zone bars below it.
        <RNView style={styles.zones} testID={`${testID}-timeline`}>
          <Text style={styles.timelineCaption}>Heart rate across the session</Text>
          <HRTimelineChart points={hrTimeline} testID={`${testID}-timeline-chart`} />
        </RNView>
      )}

      {report.totalZoneMinutes > 0 ? (
        <RNView style={styles.zones} testID={`${testID}-zones`}>
          {report.zones.map((z) => (
            <ZoneRow key={z.zone} row={z} testID={`${testID}-zone-${z.zone}`} />
          ))}
        </RNView>
      ) : (
        // TRIMP was computable (a real HRmax exists) but every minute fell
        // through the backend's own gap-skipping rule (`trimp.go`'s
        // `maxSampleGapForZoneAttribution`) — real evidence, attributed to
        // nothing. Rare in practice (it implies TRIMP itself is 0, since
        // TRIMP is built from the same minutes), kept as an honest fallback
        // rather than an empty bar list nobody explained.
        <Text style={styles.limitedText} testID={`${testID}-zones-empty`}>
          Not enough continuous readings to break this down by zone.
        </Text>
      )}

      {report.perExercise.length > 0 && (
        // N490/#851 — the per-exercise breakdown, strength-only today (the
        // caller is what decides that, by whether it passes `exerciseHR`
        // at all — see this component's own doc comment). Its own card,
        // matching the zones section's shape, rather than folded into
        // `hrStats`: this is per-EXERCISE evidence, a different question
        // from the whole-session average/max sitting above it.
        <RNView style={styles.zones} testID={`${testID}-by-exercise`}>
          <Text style={styles.byExerciseLabel}>By exercise</Text>
          {report.perExercise.map((ex) => (
            <ExerciseHRRow key={ex.exerciseId} row={ex} testID={`${testID}-exercise-${ex.exerciseId}`} />
          ))}
        </RNView>
      )}

      {report.effectiveness && (
        <RNView style={styles.effectiveness} testID={`${testID}-effectiveness`}>
          <Text style={styles.effectivenessHeadline}>{report.effectiveness.headline}</Text>
          <Text style={styles.effectivenessDetail}>{report.effectiveness.detail}</Text>
        </RNView>
      )}
    </RNView>
  );
}

function ZoneRow({ row, testID }: { row: HRZoneRow; testID: string }) {
  return (
    <RNView style={styles.zoneRow} testID={testID}>
      <RNView style={[styles.zoneDot, { backgroundColor: row.color }]} />
      <Text style={styles.zoneLabel}>
        Z{row.zone} · {row.label}
      </Text>
      <RNView style={styles.zoneBarTrack}>
        <RNView style={[styles.zoneBarFill, { width: `${row.pct}%`, backgroundColor: row.color }]} />
      </RNView>
      <Text style={styles.zoneMinutes}>{row.minutes >= 1 ? `${Math.round(row.minutes)}m` : '<1m'}</Text>
    </RNView>
  );
}

function ExerciseHRRow({ row, testID }: { row: HRExerciseRow; testID: string }) {
  return (
    <RNView style={styles.exerciseRow} testID={testID}>
      <Text style={styles.exerciseName} numberOfLines={1}>
        {row.exerciseName}
      </Text>
      <Text style={styles.exerciseFigures}>
        {row.avgHR} avg · {row.maxHR} max bpm
      </Text>
      {/* An exercise's own window is short, so its sample count is often
          in the single digits — shown rather than hidden, the same
          honesty role sample_count already plays at the session level. */}
      <Text style={styles.exerciseSampleCount}>
        {row.sampleCount} reading{row.sampleCount === 1 ? '' : 's'}
      </Text>
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, marginTop: 12, marginBottom: 4 },

  emptyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    padding: 14,
  },
  emptyText: { flex: 1, fontSize: 13, color: vola.textMuted, lineHeight: 19 },

  limitedCard: {
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    padding: 14,
  },
  limitedText: { fontSize: 13, color: vola.textMuted, lineHeight: 19, fontStyle: 'italic' },
  timelineCaption: { fontSize: 12, color: vola.textMuted, marginBottom: 2 },

  zones: {
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    padding: 14,
    gap: 10,
  },
  zoneRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  zoneDot: { width: 8, height: 8, borderRadius: 4 },
  zoneLabel: { width: 92, fontSize: 12, color: vola.textMuted },
  zoneBarTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: vola.lineSoft,
    overflow: 'hidden',
  },
  zoneBarFill: { height: '100%', borderRadius: 3 },
  zoneMinutes: {
    width: 36,
    textAlign: 'right',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: vola.textMuted,
  },

  // Deliberately quieter than the zone card, not louder — this is a reading of
  // the numbers above, not a new measurement, matching this repo's own stance
  // on secondary/corroborating information (`bjj/session/[id].tsx`'s
  // `hr`/`hrCaption` styles, which this report replaces there).
  effectiveness: { paddingHorizontal: 2, gap: 2 },
  effectivenessHeadline: { fontSize: 13, fontWeight: '700', color: vola.text },
  effectivenessDetail: { fontSize: 12, color: vola.textMuted, lineHeight: 18 },

  byExerciseLabel: { fontSize: 12, fontWeight: '700', color: vola.textMuted },
  exerciseRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  exerciseName: { flex: 1, fontSize: 13, color: vola.text },
  exerciseFigures: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: vola.textMuted,
  },
  exerciseSampleCount: { width: 62, textAlign: 'right', fontSize: 11, color: vola.textDim },
});
