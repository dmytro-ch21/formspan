import { ZONE_LABELS, zoneColor } from './hrZones';
import { HR_LIMITED_SAMPLE_THRESHOLD } from './bjjSession';
import { sessionEffectivenessSummary, type SessionEffectivenessSummary } from './sessionEffectiveness';
import type { ExerciseHR, SessionMetrics } from './biometric';

/**
 * The per-session heart-rate report's view-model — N488/#849, the cross-sport
 * "wiring" ticket. `backend/internal/modules/biometric` already computes
 * everything this reads (`SessionMetrics`: avg/max HR, TRIMP, `time_in_zones`,
 * `hr_source`, `sample_count` — N476/N477), and `sessionEffectiveness.ts`
 * already computes the RPE-calibration verdict (N481/#826) — this file is the
 * first thing to actually SHAPE that data for a screen, for all three sports
 * that get a correctly-windowed read: BJJ, strength, running.
 *
 * Pure and side-effect-free on purpose, matching this codebase's own house
 * style for anything that decides what a screen shows from data it did not
 * compute itself (`lib/trendSeries.ts`'s `buildTrend`, `bjjSession.ts`'s
 * `hrCorroboration`) — the screen owns fetching; this owns shaping the
 * answer, so the honesty rules below have exactly one place they can drift.
 *
 * ## The three states, and why 'limited' exists
 *
 * A session with real HR evidence can still not support a trustworthy
 * TRIMP/zone breakdown, for two different reasons this file tells apart
 * rather than collapsing into one grey area:
 *
 * - **`sparse_samples`** — below `HR_LIMITED_SAMPLE_THRESHOLD` readings (the
 *   same cutoff `hrCorroboration` already uses for BJJ, reused rather than
 *   invented a second time). The backend's own `ZoneBreakdown` (`trimp.go`)
 *   attributes each inter-sample gap to the FIRST sample's zone and skips
 *   gaps over six minutes entirely — so two samples an hour apart on an
 *   hour-long session produce `time_in_zones` that sums to a few minutes out
 *   of sixty. That is real arithmetic, not a bug, and rendering it as a bar
 *   chart of "how this session went" would silently assert the six covered
 *   minutes represent the other fifty-four. `sessionRPE` this ticket wants:
 *   don't fabricate a reading confidence does not support.
 * - **`no_hrmax`** — `SessionMetrics.trimp` is `null` even with real samples
 *   present, because `Compute` (`biometric.go`) leaves TRIMP and
 *   `time_in_zones` unset whenever there was no HRmax to classify a zone
 *   against (`hrMaxFromDateOfBirth` in `lib/biometric.ts` returning `null` —
 *   no date of birth on the profile, most commonly). Avg/max HR need no
 *   ceiling and are still real; TRIMP and zones are not computable at all,
 *   which is a different honest answer from "not enough of them."
 *
 * Both `limited` reasons still show whatever IS real (avg/max HR, sample
 * count) — the ticket's "no misleading zeroed report" cuts against a blank
 * screen just as much as against a fabricated one. Only avg/max survive;
 * TRIMP, zones and the effectiveness verdict do not render at all in this
 * state, rather than rendering as zero.
 *
 * `unavailable` covers `hr_source: 'none'` (design doc §5.1's "no wearable is
 * not misconfiguration") and `metrics === null` (not computed yet — a normal
 * state per §6.4, not an error) alike: nothing to report, said plainly.
 *
 * ## The effectiveness verdict is optional evidence, not optional plumbing
 *
 * `sessionRPE` is `null` for strength and running today — neither sport
 * captures a single session-level RPE (strength has per-SET RPE, running has
 * none at all; see `lib/sessions.ts`'s `rpe`/`hardest_rpe`, which is a
 * different question: the hardest set, not how the whole session felt). This
 * file does not invent one from `hardest_rpe` — averaging or maxing per-set
 * RPE into a session figure is a real design decision belonging to whichever
 * ticket adds strength/running session-level reflection, not a side effect of
 * wiring up an HR report. `sessionEffectivenessSummary` already returns `null`
 * for a `null` RPE, so the effectiveness card simply does not render for
 * those two sports today — the same "real evidence or nothing" rule as
 * everywhere else in this file, not a special case.
 */

export const HR_REPORT_MIN_SAMPLES = HR_LIMITED_SAMPLE_THRESHOLD;

/**
 * How far apart the queried HR window and the session's own logged
 * started_at/ended_at have to be, on EITHER boundary, before it is worth
 * showing the two side by side — N522/#934, the decision behind the
 * session-detail screen's diagnostic line. 10 minutes: comfortably above
 * ordinary clock noise (a session finished a minute or two after the timer
 * reads, say — not worth a line every time), while far below what a
 * wide-window fit actually correcting a wrong anchor produces (this
 * ticket's own incident was off by roughly two HOURS). Below this, the
 * queried window is shown but nothing calls out a difference; at or above
 * it, this is exactly the mismatch that made the original bug invisible —
 * surfacing it is the point.
 */
export const HR_WINDOW_MISMATCH_THRESHOLD_MINUTES = 10;

/**
 * Whether `hrWindow` differs meaningfully from the session's own logged
 * started_at/ended_at — pure, so the "is this worth a diagnostic line"
 * decision is unit-testable without rendering anything.
 */
export function hrWindowDiffersFromSession(
  hrWindow: HRQueriedWindow,
  sessionStartedAt: string,
  sessionEndedAt: string,
  thresholdMinutes: number = HR_WINDOW_MISMATCH_THRESHOLD_MINUTES,
): boolean {
  const thresholdMs = thresholdMinutes * 60_000;
  const startDiffMs = Math.abs(new Date(hrWindow.start).getTime() - new Date(sessionStartedAt).getTime());
  const endDiffMs = Math.abs(new Date(hrWindow.end).getTime() - new Date(sessionEndedAt).getTime());
  return startDiffMs > thresholdMs || endDiffMs > thresholdMs;
}

export type HRZoneRow = {
  zone: number;
  label: string;
  minutes: number;
  /** Share of the session's ZONE-ATTRIBUTED minutes (not wall-clock duration
   *  — see the gap-skipping note above), rounded to a whole percent. 0 when
   *  no minutes were attributed to any zone at all. */
  pct: number;
  color: string;
};

export type HRSessionReportLimitedReason = 'sparse_samples' | 'no_hrmax';

/**
 * One exercise's row in the per-exercise breakdown — N490/#851. Shaped from
 * `ExerciseHR` (the wire type) plus a resolved display name, the same split
 * `withExerciseNames` already makes elsewhere in the app: this file stays
 * sport/screen-agnostic and takes the name lookup as an input rather than
 * importing the exercise catalog itself.
 */
export type HRExerciseRow = {
  exerciseId: string;
  exerciseName: string;
  avgHR: number;
  maxHR: number;
  sampleCount: number;
};

/** The ACTUAL window a report's evidence was queried from — N522/#934.
 *  Ordinarily equals the owning session's own started_at/ended_at; differs
 *  only when enrichment used a wide-window fit instead (see
 *  `lib/hrWindowFit.ts`). Carried on every non-`unavailable` state, since
 *  `SessionMetrics.hr_window_start/end` are themselves always present once
 *  a metrics row exists at all. */
export type HRQueriedWindow = { start: string; end: string };

export type HRSessionReportView =
  | { state: 'unavailable' }
  | {
      state: 'limited';
      reason: HRSessionReportLimitedReason;
      avgHR: number | null;
      maxHR: number | null;
      sampleCount: number;
      hrWindow: HRQueriedWindow;
    }
  | {
      state: 'full';
      avgHR: number | null;
      maxHR: number | null;
      sampleCount: number;
      trimp: number;
      zones: HRZoneRow[];
      totalZoneMinutes: number;
      effectiveness: SessionEffectivenessSummary | null;
      hrWindow: HRQueriedWindow;
      /**
       * The per-exercise breakdown — N490/#851. Empty when the caller passed
       * no `exerciseHR` (BJJ/running today, which have no per-exercise
       * concept — see `HRSessionReport`'s own doc comment) or when the
       * session genuinely has no exercise with an honest window/evidence of
       * its own. Only ever populated alongside the 'full' state: see
       * `buildHRSessionReport`'s doc comment for why a per-exercise
       * breakdown built from an even SPARSER slice of the same evidence
       * must not appear when the whole-session numbers themselves did not
       * clear the sample/HRmax bar.
       */
      perExercise: HRExerciseRow[];
    };

/**
 * Zone labels and the zone colour ramp moved to `lib/hrZones.ts` in N534, so
 * the run library, the zone derivation and the live trainer can import the
 * same vocabulary instead of each spelling "zone 4" their own way. The
 * reasoning for both — including why the RPE ramp was reused rather than a new
 * palette invented — moved with them.
 */

function buildZoneRows(timeInZones: Record<string, number>): HRZoneRow[] {
  const minutesByZone = [1, 2, 3, 4, 5].map((zone) => ({
    zone,
    minutes: timeInZones[String(zone)] ?? 0,
  }));
  const total = minutesByZone.reduce((sum, z) => sum + z.minutes, 0);
  return minutesByZone.map(({ zone, minutes }) => ({
    zone,
    label: ZONE_LABELS[zone],
    minutes,
    pct: total > 0 ? Math.round((minutes / total) * 100) : 0,
    color: zoneColor(zone),
  }));
}

/**
 * Shapes one session's HR report. Same evidence-first posture as
 * `hrCorroboration`/`sessionEffectivenessSummary`: this never fabricates a
 * figure the inputs do not support, and a caller must only invoke it once its
 * own read of `metrics` has settled to a real answer (a fetch still in flight
 * is not the same as "no data" — the caller's problem to keep apart, per
 * `sessionEffectivenessSummary`'s own doc comment on this exact contract).
 *
 * `exerciseHR`/`exerciseNames` (N490/#851) are optional and additive: `null`
 * or omitted (BJJ, running — neither has a per-exercise concept the way
 * strength does) simply yields an empty `perExercise` in the 'full' state.
 * **Deliberately gated on the whole-session state being 'full'**, checked
 * before `perExercise` is ever built: an exercise's own window is a strict
 * SUBSET of the evidence backing the session-level numbers (fewer minutes,
 * fewer samples), so if the session itself does not clear the sample/HRmax
 * bar, no per-exercise slice of it could either — computing one anyway would
 * be re-deriving a "full" answer for individual exercises underneath a
 * report that has already said the session-level one is not trustworthy.
 * `exercise_id` is defensively filtered to `sample_count > 0` even though
 * the backend never returns a zero-sample row — the same belt-and-braces
 * stance this file already takes on `hr_source === 'none'` above.
 */
export function buildHRSessionReport(
  metrics: Pick<
    SessionMetrics,
    | 'avg_hr_bpm'
    | 'max_hr_bpm'
    | 'trimp'
    | 'time_in_zones'
    | 'hr_source'
    | 'sample_count'
    | 'hr_window_start'
    | 'hr_window_end'
  > | null,
  sessionRPE: number | null,
  exerciseHR: Pick<ExerciseHR, 'exercise_id' | 'avg_hr_bpm' | 'max_hr_bpm' | 'sample_count'>[] | null = null,
  exerciseNames: Record<string, string> = {},
): HRSessionReportView {
  if (!metrics || metrics.hr_source === 'none') return { state: 'unavailable' };
  // Defence in depth, matching `hrCorroboration`'s own stance: `Compute`
  // always forces `hr_source` to `'none'` whenever there are zero samples, so
  // this should never fire in practice, but a row with a non-none source and
  // no figures should still say nothing rather than fabricate one.
  if (metrics.avg_hr_bpm == null && metrics.max_hr_bpm == null) return { state: 'unavailable' };

  const hrWindow: HRQueriedWindow = { start: metrics.hr_window_start, end: metrics.hr_window_end };

  if (metrics.sample_count < HR_REPORT_MIN_SAMPLES) {
    return {
      state: 'limited',
      reason: 'sparse_samples',
      avgHR: metrics.avg_hr_bpm,
      maxHR: metrics.max_hr_bpm,
      sampleCount: metrics.sample_count,
      hrWindow,
    };
  }

  if (metrics.trimp === null) {
    return {
      state: 'limited',
      reason: 'no_hrmax',
      avgHR: metrics.avg_hr_bpm,
      maxHR: metrics.max_hr_bpm,
      sampleCount: metrics.sample_count,
      hrWindow,
    };
  }

  const zones = buildZoneRows(metrics.time_in_zones);
  const totalZoneMinutes = zones.reduce((sum, z) => sum + z.minutes, 0);
  const effectiveness = sessionEffectivenessSummary(
    { trimp: metrics.trimp, time_in_zones: metrics.time_in_zones, hr_source: metrics.hr_source },
    sessionRPE,
  );

  const perExercise: HRExerciseRow[] = (exerciseHR ?? [])
    .filter((e) => e.sample_count > 0)
    .map((e) => ({
      exerciseId: e.exercise_id,
      exerciseName: exerciseNames[e.exercise_id] ?? e.exercise_id,
      avgHR: e.avg_hr_bpm,
      maxHR: e.max_hr_bpm,
      sampleCount: e.sample_count,
    }));

  return {
    state: 'full',
    avgHR: metrics.avg_hr_bpm,
    maxHR: metrics.max_hr_bpm,
    sampleCount: metrics.sample_count,
    trimp: metrics.trimp,
    zones,
    totalZoneMinutes,
    effectiveness,
    hrWindow,
    perExercise,
  };
}
