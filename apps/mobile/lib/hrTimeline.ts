/**
 * The per-session heart-rate TIMELINE — N491/#852.
 *
 * ## What this is, and deliberately is not
 *
 * N491 asked for something that "does not exist in any form today": a way to
 * see WHEN a BJJ session shifted from drilling to rolling, since rolling runs
 * hotter and more erratic. The ticket offered two directions to build that —
 * an explicit live "mark the transition" capture, or an inferred step-change
 * heuristic that CLASSIFIES each stretch as drilling or rolling — and asked
 * that direction be chosen with real reasoning, not a coin flip.
 *
 * **Both were investigated and rejected for this ticket.** See the N491
 * history entry for the full reasoning; in short:
 *
 * - Live capture would add a mid-session tap to a sport whose own design doc
 *   (`bjj-tracking-design.md` §2) and its own logging screen
 *   (`app/bjj/log.tsx`'s doc comment: "sweaty hands, a mouthguard, six-minute
 *   rounds, gis without pockets") have already, deliberately, ruled out ANY
 *   mid-session interaction — not merely discouraged it. Even the
 *   live-tracked path (`app/bjj/session/[id].tsx`'s `!session.ended_at`
 *   branch) offers nothing but a single "Finish" action by design.
 * - An inferred classifier needs to be validated against real recorded HR
 *   data from an actual rolling session before it can be shown to an athlete
 *   as a "detected pattern" (N480/#825's "HR corroborates, never replaces"
 *   stance, which this ticket must honor). No such data exists in this dev
 *   environment — every local Postgres is an ephemeral, worktree-scoped
 *   throwaway seeded by test runs, never a real HealthKit sync — so shipping
 *   a classifier now would mean presenting an unvalidated guess as fact,
 *   which is the one thing N480 forbids.
 *
 * **What this file does instead: show the real numbers, in order, and let
 * the athlete read the shape themselves.** `buildHRTimeline` asserts nothing
 * about which stretch was drilling and which was rolling — it is a straight
 * map from "real HR readings across the session" to "points a line can be
 * drawn through," the same "evidence over self-assessment" posture
 * `bjj_session_tags`' own migration comment already commits this app to. A
 * step change is still visible to the athlete's own eye without VOLA ever
 * asserting where it is — which is a strictly more honest answer than either
 * of the ticket's two proposed directions, and needs no live interaction and
 * no statistical validation to be true.
 *
 * Gated by the caller on the same `HR_LIMITED_SAMPLE_THRESHOLD` the rest of
 * `hrSessionReport.ts` already uses (`report.state === 'full'`) — a
 * two-point line across an hour would visually assert a shape the sparse
 * data does not support, the exact "confident line through a hole"
 * `useVo2MaxTrend.ts`'s own doc comment warns against.
 */

/** One point on the timeline: minutes elapsed since the session started, and
 *  the real reading at that moment. Never a classification. */
export type HRTimelinePoint = {
  minutesElapsed: number;
  bpm: number;
};

/**
 * Caps how many points the chart ever draws. A BJJ class can carry a couple
 * of hundred HR samples; drawing every one of them buys no legibility a
 * phone screen can use and costs real render time, so buckets beyond this
 * are averaged down to it — the same "unbounded body/list" discipline this
 * repo applies on the backend (`bjj.MaxTags`, `postgres.go`'s
 * `maxListRangeDays`), pointed at a client-side render instead of a request
 * body.
 */
export const MAX_TIMELINE_POINTS = 120;

/**
 * One real HR reading, reduced to what this file needs — matches the shape
 * `lib/biometric.ts`'s `BiometricSample` already carries, without forcing a
 * dependency on its other fields (source, unit, id).
 */
export type RawHRReading = {
  measured_at: string;
  value: number;
};

/**
 * Builds the timeline from whatever real HR samples fell in the session's
 * own `[startedAt, endedAt]` window — clipped defensively even though the
 * caller's own fetch is already scoped to that window (`GET
 * /v1/biometric/samples?from=&to=`), mirroring `heartRateSamplesInWindow`'s
 * own belt-and-suspenders stance on a window boundary.
 *
 * Returns `[]` for a malformed window or no samples in it — never throws, so
 * a caller can render "nothing to show" without a try/catch of its own,
 * matching this file's siblings (`hrCorroboration`, `buildHRSessionReport`).
 */
export function buildHRTimeline(
  samples: readonly RawHRReading[],
  sessionStartedAt: string,
  sessionEndedAt: string,
): HRTimelinePoint[] {
  const startMs = new Date(sessionStartedAt).getTime();
  const endMs = new Date(sessionEndedAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];

  const points: HRTimelinePoint[] = [];
  for (const s of samples) {
    const t = new Date(s.measured_at).getTime();
    if (!Number.isFinite(t) || !Number.isFinite(s.value)) continue;
    if (t < startMs || t > endMs) continue;
    points.push({ minutesElapsed: (t - startMs) / 60000, bpm: s.value });
  }
  points.sort((a, b) => a.minutesElapsed - b.minutesElapsed);

  return downsample(points, MAX_TIMELINE_POINTS);
}

/**
 * Averages consecutive runs of points down to at most `maxPoints`, rather
 * than simply dropping every Nth one — a stride-based drop can silently
 * skip past exactly the few-minute spike this chart exists to make visible,
 * where an average of the bucket it falls in still shows it, just smoothed.
 */
function downsample(points: HRTimelinePoint[], maxPoints: number): HRTimelinePoint[] {
  if (points.length <= maxPoints || maxPoints <= 0) return points;

  const bucketSize = points.length / maxPoints;
  const out: HRTimelinePoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * bucketSize);
    const end = i === maxPoints - 1 ? points.length : Math.max(start + 1, Math.floor((i + 1) * bucketSize));
    const bucket = points.slice(start, end);
    if (bucket.length === 0) continue;
    const n = bucket.length;
    let minutesSum = 0;
    let bpmSum = 0;
    for (const p of bucket) {
      minutesSum += p.minutesElapsed;
      bpmSum += p.bpm;
    }
    out.push({ minutesElapsed: minutesSum / n, bpm: bpmSum / n });
  }
  return out;
}
