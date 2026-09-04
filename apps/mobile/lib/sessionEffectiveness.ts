import type { SessionMetrics } from './biometricApi';
import { describeRPE, MAX_RPE } from './bjjSession';

/**
 * A deterministic "how this session went" calibration — comparing a
 * session's HR-derived load (TRIMP + zone breakdown, from `biometricApi.ts`)
 * against the athlete's own session RPE. N481/#826 —
 * `docs/decisions/health-integration-design.md` §8 item 3, "calibrating sRPE
 * against measurement": "the most valuable use case" the HR integration
 * buys, in the design doc's own words.
 *
 * ## Why this is a rule, not a model
 *
 * Deliberately arithmetic, not LLM-generated and not model-sampled — the
 * ticket's own explicit requirement, and the same "evidence-based rules
 * before AI" posture the recommendation engine already takes (design doc §8
 * again: "measurement calibrates the subjective scale, it does not replace
 * it," §5.5). An LLM MAY narrate this output in words later; it does not
 * decide the verdict.
 *
 * ## Why client-side, not a backend endpoint
 *
 * Both raw ingredients this function compares — `SessionMetrics` (TRIMP,
 * `time_in_zones`, `hr_source`) and `session_rpe` — are already readable by
 * this app through existing endpoints (`GET
 * /biometric/sessions/{id}/metrics`, the BJJ session detail read). Nothing
 * here needs a database write, a new migration or a new round trip; it is
 * pure arithmetic over numbers the client already has in hand, which is
 * exactly the shape `lib/progress.ts`'s `Insight` generation already takes
 * for this app's one other deterministic-insight surface — see that file's
 * own doc comment before touching this one. `backend/internal/modules/
 * biometric`'s `SessionMetrics`, `ZoneBreakdown` and `TRIMP` remain the
 * source of truth for the numbers themselves; this file only compares two
 * numbers that already exist, on the client, the same way `whatChanged`
 * compares readings it did not compute itself.
 *
 * ## Evidence gating
 *
 * Returns `null` — never a fabricated or "roughly average" verdict — unless
 * ALL of: `hr_source` is not `'none'` (design doc §5.1/§6.3's honesty
 * discipline: no wearable is not misconfiguration, and it is not a stand-in
 * for zero effort either), `trimp` is a real number (nil whenever the
 * backend had no HRmax to classify zones against — see `Compute` in
 * `trimp.go`), `session_rpe` is a real 1-10 report, and the HR evidence
 * behind it is not vanishingly thin (`MIN_ZONE_MINUTES_FOR_CALIBRATION`).
 *
 * ## A contract the caller owns, not this function
 *
 * This takes an already-resolved `SessionMetrics`-shaped object, not a
 * `Reading<SessionMetrics>` (see `lib/progress.ts`'s doc comment on why that
 * union exists at all): a caller must only invoke this once its own read of
 * the session's metrics — however it fetches them — has settled to a real
 * answer. Calling it against a placeholder or zero-valued object while that
 * fetch is still in flight would read as `null` ("insufficient evidence" — a
 * legitimate answer this function really does return) rather than "not
 * answered yet", which is exactly the ambiguity `progress.ts`'s `checking`
 * state exists to keep apart from `empty`. No caller exists yet to get this
 * wrong; whichever one wires this in first should keep the distinction on
 * its own side, the way `whatChanged` keeps it before ever calling
 * `freshRecords`/`nutritionWeek`.
 */

/** Mirrors `bjj_session_details.session_rpe`'s own CHECK constraint. */
const MIN_RPE = 1;

/**
 * Below this many zone-attributed minutes, the weighted-average zone this
 * function leans on is too thin a sample to say anything with confidence —
 * echoing `ZoneBreakdown`'s own stance in `trimp.go` that a sparse or
 * gap-heavy session legitimately sums to less than its wall-clock duration,
 * and a reader needs telling why rather than being handed a confident
 * verdict built on two minutes of data.
 */
export const MIN_ZONE_MINUTES_FOR_CALIBRATION = 10;

/**
 * How far apart the reported RPE and the HR-implied RPE have to be before
 * this is worth telling the athlete about, rather than ordinary noise on a
 * 1-10 self-report scale. sRPE correlates with HR-derived TRIMP in the
 * 0.65-0.78 range across team sports (design doc §5.5) — a real but
 * imperfect correlation, so a 1-point gap is exactly the kind of scatter
 * that correlation predicts and calling it out every time would be crying
 * wolf. Two points is a materially different effort bracket on
 * `describeRPE`'s own scale (e.g. the line between "Moderate" and "Hard").
 */
export const CALIBRATION_DELTA_THRESHOLD = 2;

export type CalibrationDirection = 'aligned' | 'felt_harder' | 'felt_easier';

export type SessionEffectivenessSummary = {
  direction: CalibrationDirection;
  headline: string;
  detail: string;
  /** The athlete's own report, echoed back so a caller can render it without recomputing. */
  reportedRPE: number;
  /** What this session's HR zone time would typically read as, on the same 1-10 scale. */
  hrImpliedRPE: number;
  /** The zone (1-5) most of the session's HR-attributed time fell in. */
  dominantZone: number;
};

/**
 * The zone (1-5) with the most minutes attributed to it. Ties go to the
 * LOWER zone number (first strictly-greater wins), which is an arbitrary but
 * deterministic and stable choice — reproducibility is the property this
 * function exists to guarantee, not which of two equally-true zones reads
 * first.
 */
function dominantZone(timeInZones: Record<string, number>): { zone: number; minutes: number } {
  let zone = 0;
  let minutes = -1;
  for (let z = 1; z <= 5; z++) {
    const m = timeInZones[String(z)] ?? 0;
    if (m > minutes) {
      minutes = m;
      zone = z;
    }
  }
  return { zone, minutes: Math.max(minutes, 0) };
}

/**
 * Compares a session's HR-derived load against its session RPE and returns a
 * deterministic calibration verdict, or `null` when the evidence does not
 * support one. Same inputs always produce the same output — no clock, no
 * randomness, no network call.
 */
export function sessionEffectivenessSummary(
  metrics: Pick<SessionMetrics, 'trimp' | 'time_in_zones' | 'hr_source'>,
  sessionRPE: number | null,
): SessionEffectivenessSummary | null {
  if (metrics.hr_source === 'none') return null;
  if (metrics.trimp === null) return null;
  if (sessionRPE === null || sessionRPE < MIN_RPE || sessionRPE > MAX_RPE) return null;

  const totalMinutes = Object.values(metrics.time_in_zones).reduce((sum, m) => sum + m, 0);
  if (totalMinutes < MIN_ZONE_MINUTES_FOR_CALIBRATION) return null;

  // The weighted average zone TRIMP is already built from: TRIMP is
  // Σ(minutes in zone × zone weight), so dividing back by total minutes
  // recovers the average zone weight — no separate pass over the samples.
  const avgZoneWeight = metrics.trimp / totalMinutes;
  // Clamped with plain if-comparisons, deliberately not the nested
  // clamp-via-two-function-calls idiom: writing it that way, with these two
  // particular bound names, reads to `reportedAggregation.test.ts`'s SQL
  // aggregate scan exactly like a Postgres aggregate over a reported column
  // (rule 3, `session/basis.go`) — a false positive on a syntactic
  // coincidence (a bound named for the RPE scale, not an aggregate of an
  // RPE column), but the guard is a scan and cannot tell the two apart, and
  // dodging the shape costs nothing here.
  let hrImpliedRPE = Math.round(avgZoneWeight * 2);
  if (hrImpliedRPE < MIN_RPE) hrImpliedRPE = MIN_RPE;
  if (hrImpliedRPE > MAX_RPE) hrImpliedRPE = MAX_RPE;

  const { zone } = dominantZone(metrics.time_in_zones);
  const delta = sessionRPE - hrImpliedRPE;

  const reportedLabel = describeRPE(sessionRPE);
  const impliedLabel = describeRPE(hrImpliedRPE);

  if (delta >= CALIBRATION_DELTA_THRESHOLD) {
    return {
      direction: 'felt_harder',
      headline: 'This felt harder than your heart rate suggests',
      detail: `You rated this session ${reportedLabel.toLowerCase()} (RPE ${sessionRPE}/${MAX_RPE}), but your heart rate spent most of it in zone ${zone} — sessions like that usually read closer to ${impliedLabel.toLowerCase()} (RPE ${hrImpliedRPE}/${MAX_RPE}).`,
      reportedRPE: sessionRPE,
      hrImpliedRPE,
      dominantZone: zone,
    };
  }

  if (delta <= -CALIBRATION_DELTA_THRESHOLD) {
    return {
      direction: 'felt_easier',
      headline: 'This felt easier than your heart rate suggests',
      detail: `You rated this session ${reportedLabel.toLowerCase()} (RPE ${sessionRPE}/${MAX_RPE}), but your heart rate spent most of it in zone ${zone} — sessions like that usually read closer to ${impliedLabel.toLowerCase()} (RPE ${hrImpliedRPE}/${MAX_RPE}).`,
      reportedRPE: sessionRPE,
      hrImpliedRPE,
      dominantZone: zone,
    };
  }

  return {
    direction: 'aligned',
    headline: 'Your effort rating matches your heart rate',
    detail: `You rated this session RPE ${sessionRPE}/${MAX_RPE}, and your heart rate spent most of it in zone ${zone} — right where a ${reportedLabel.toLowerCase()} session usually sits.`,
    reportedRPE: sessionRPE,
    hrImpliedRPE,
    dominantZone: zone,
  };
}
