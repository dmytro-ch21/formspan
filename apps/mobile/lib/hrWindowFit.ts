import type { HRWindow } from './biometric';

/**
 * N522/#934 — the wide-window HR-signal fit, for a post-hoc-logged session
 * whose `started_at`/`ended_at` don't reflect when the athlete actually
 * trained.
 *
 * ## The bug this exists to fix
 *
 * `lib/biometricSync.ts`'s `syncSessionWindows` queries HealthKit for
 * exactly `[session.started_at, session.ended_at]` (`sessionHRWindow` in
 * `./biometric`). For a LIVE-TRACKED session those are real wall-clock
 * times, and the exact window is the right thing to ask for. For a
 * POST-HOC-LOGGED one (`app/bjj/log.tsx`), `started_at` is computed as
 * `(the moment "Log it" was tapped) − (the duration the athlete typed)` —
 * neither end is a real clock reading of when training happened, so the
 * exact window can land hours away from the real activity, and a query
 * against it finds nothing even though the watch has real data nearby in
 * the same HealthKit store. The session screen then shows an honest but
 * wrong "no heart-rate data" (`HRSessionReport`'s `unavailable` state) —
 * and N511's retry ladder (`biometric.ts`'s `needsEnrichmentAttempt`)
 * cannot fix this, because it re-queries the IDENTICAL wrong window on
 * every retry.
 *
 * ## The fix, in two pieces
 *
 * `wideHRQueryWindow` widens the query to the athlete's own DATED day
 * (the day they said this session happened, not merely the exact logged
 * clock time) with a small buffer either side, on the same "same-day is
 * the common case" assumption `app/bjj/log.tsx`'s own
 * `backdatedTimestamp`/N492 same-day-remap logic already makes for
 * post-hoc logging.
 *
 * `fitHRWindow` then slides a window the length of the athlete's OWN
 * logged duration across whatever the wide query returns, scores every
 * placement by how much it looks like real sustained training (not a
 * single peak, and not merely "elevated above resting"), and returns the
 * best-scoring placement — but ONLY when it clears a confidence bar and
 * is not genuinely ambiguous with a comparably-good placement somewhere
 * else in the window. **A wrong guess that looks confident is worse than
 * an honest "not found" — this declines rather than forces a fit whenever
 * that's a live possibility.**
 *
 * Both are pure functions over plain data — no HealthKit import, no
 * network — so the whole fitting decision is unit-testable without a
 * device, and validated in `lib/__tests__/hrWindowFit.test.ts` against
 * synthetic fixtures modeled directly on this ticket's own real incident
 * data (a genuine ~82-minute elevated block with real oscillation, a
 * resting baseline around 60-77 bpm, and a peak of 190 — the real incident's
 * own reported average was 151, but the fixture's own average, built from
 * alternating per-segment low/high samples rather than real per-second data,
 * comes out lower at ~134; frontend-reviewer caught this file previously
 * claiming the fixture itself averaged 151, which it never did — see that
 * file's own doc comment for the full shape and the reasoning behind every
 * constant below).
 *
 * `biometricSync.ts`'s `syncSessionWindows` wires this in as a fallback
 * that runs ONLY when the exact-window query already returned zero
 * samples — a session with real evidence in its own window never touches
 * any of this.
 */

// --- the wide query window -------------------------------------------------

/**
 * Padding either side of the athlete's dated calendar day (LOCAL to this
 * device, matching how `app/bjj/log.tsx` already dates a post-hoc session)
 * — 2 hours. Bounding to the calendar day, rather than to a fixed number of
 * hours around the (wrong) exact window, is deliberate: the dated day is
 * the one piece of the athlete's own input that post-hoc logging does NOT
 * get wrong (the date picker, not the clock) — see `app/bjj/log.tsx`'s
 * `backdatedTimestamp`. The 2-hour buffer on each side covers a class that
 * started before local midnight and ran past it, or one dated to a day but
 * logged in the small hours of the next one, without reaching far enough to
 * risk pulling in an unrelated session from the day before or after.
 */
export const WIDE_WINDOW_PADDING_HOURS = 2;

/**
 * The wide fallback query window for `startedAt`'s dated day — LOCAL
 * calendar day (this device's own timezone, the same frame `Date`'s
 * getters/constructor already use elsewhere in this app), padded by
 * `WIDE_WINDOW_PADDING_HOURS` on each side.
 */
export function wideHRQueryWindow(startedAt: string, paddingHours: number = WIDE_WINDOW_PADDING_HOURS): HRWindow {
  const d = new Date(startedAt);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  const paddingMs = paddingHours * 60 * 60 * 1000;
  return {
    start: new Date(dayStart.getTime() - paddingMs),
    end: new Date(dayEnd.getTime() + paddingMs),
  };
}

/**
 * Mirrors `backend/internal/modules/biometric/biometric.go`'s
 * `MaxHRWindowOverrideDrift` EXACTLY — 24 hours — because this is not a
 * design choice this file gets to make independently, it is a validation
 * this client must never disagree with the server about.
 *
 * The two constants used to be justified by two SEPARATE pieces of math that
 * were assumed to agree and did not (backend-reviewer, N522 PR review): the
 * backend's own doc comment claimed a "~14h" worst case for this file's
 * padding, but `wideHRQueryWindow`'s real shape is a calendar day PLUS
 * `WIDE_WINDOW_PADDING_HOURS` on each side, so a session started near local
 * midnight puts the wide window's far edge up to `24h + WIDE_WINDOW_PADDING_HOURS`
 * (~25.9h for the padding above) from `started_at` — ABOVE the backend's
 * fixed 24h bound, for ANY positive padding. No amount of retuning
 * `WIDE_WINDOW_PADDING_HOURS` closes that gap: the gap IS the padding.
 *
 * So this is not "pick a client padding that happens to fit under the
 * backend's bound" — that's structurally impossible while the padding stays
 * positive. It's "the client must know its own fit can still land outside
 * what the backend will ever accept, and decline the fit rather than hand
 * `biometricSync.ts` a candidate that would be sent as an override and
 * permanently rejected." A permanent 400 here is worse than never having
 * found the block at all: N511's retry ladder (`biometric.ts`'s
 * `needsEnrichmentAttempt`) cannot tell a deterministic rejection apart from
 * a transient network failure, and would retry the identical doomed request
 * forever — reproducing, one layer downstream, the exact "retry can't fix a
 * wrong window" failure this ticket exists to close.
 */
export const HR_FIT_MAX_BACKEND_DRIFT_MS = 24 * 60 * 60 * 1000;

// --- the fit ----------------------------------------------------------------

/** One heart-rate reading, reduced to plain data — platform-neutral on
 *  purpose (unlike `RawQuantitySample`/`RawHeartRateSample` in `./biometric`,
 *  neither of which this needs), since the scoring below cares about
 *  nothing but time and bpm. */
export type HRFitPoint = { measuredAt: string; bpm: number };

export type HRWindowFit = {
  /** RFC3339 */
  start: string;
  /** RFC3339 */
  end: string;
  /** The elevated-time fraction that won — see `scoreCandidate` below. Not
   *  surfaced to the athlete anywhere today; kept on the result because a
   *  caller choosing to log/report confidence later shouldn't need to
   *  recompute it. */
  confidence: number;
};

/** Below this many samples in the WHOLE wide window, there isn't enough
 *  evidence to compute a reliable baseline at all — decline outright rather
 *  than let one or two stray readings drive a percentile. */
export const HR_FIT_MIN_TOTAL_SAMPLES = 10;

/** Below this many samples inside one CANDIDATE window, that placement is
 *  never trusted even if the few points it has happen to score high — a
 *  99% "elevated" reading from 2 samples is not evidence, it's noise. */
export const HR_FIT_MIN_SAMPLES_IN_CANDIDATE = 5;

/**
 * The percentile used to derive a resting baseline from the wide window's
 * OWN samples — deliberately not a fixed absolute bpm, and deliberately not
 * a separate `HKQuantityTypeIdentifierRestingHeartRate` read (a new
 * HealthKit permission this fix does not need to justify): a low percentile
 * of whatever this device already queried is a reasonable stand-in for
 * "how this athlete's heart rate looks when they are not training", robust
 * to the wide window ALSO containing genuine training (the true elevated
 * block is a minority of a ~1-day window in the common case, so a 20th
 * percentile lands on resting/light-activity readings even when some of the
 * window is real training).
 */
export const HR_FIT_BASELINE_PERCENTILE = 0.2;

/**
 * How far above the baseline a reading has to sit to count as "elevated" —
 * 20 bpm. Sized against this ticket's own incident data: a resting baseline
 * in the 60-77 bpm range (the Apple Health screenshots' 11:00 AM reading)
 * puts the elevated threshold around 85-90 bpm, comfortably below even the
 * LOW points of the real training block (92-125 bpm during drilling/
 * instruction lulls) and far below its peaks (190 bpm) and average (151
 * bpm) — so the real block scores high — while staying high enough that
 * ordinary daily-life HR variance (walking, mild anxiety, a warm room)
 * rarely crosses it for long, which is what keeps a genuinely-resting wide
 * window from scoring a false fit (see the "empty" fixture in this file's
 * test).
 */
export const HR_FIT_ELEVATION_MARGIN_BPM = 20;

/**
 * How long a gap between two samples may be and still count as "covered"
 * time for scoring — 6 minutes, matching
 * `backend/internal/modules/biometric/trimp.go`'s own
 * `maxSampleGapForZoneAttribution` exactly (not a new number: this is the
 * same "how long can two readings be apart and still describe one
 * continuous stretch" question the backend already answers for zone
 * attribution, reused here for the identical reason).
 */
export const HR_FIT_MAX_GAP_MS = 6 * 60_000;

/**
 * The minimum elevated-time fraction a candidate window must clear to be
 * trusted at all — 0.4. The real incident's own block — sustained rolling
 * and drilling for ~82 minutes with real oscillation, never dropping to a
 * genuinely resting heart rate — comfortably clears this (its low points,
 * 92-125 bpm, sit well above the ~85-90 bpm threshold the whole time), while
 * a window over resting HR, or over merely being awake and active without
 * training, should not: ordinary daily variance crossing threshold+20bpm
 * more than 40% of a many-minutes-long candidate window at a stretch is
 * itself evidence something real was happening. Tuned conservatively (not
 * 0.5+) because the real block's own low stretches (drilling/instruction
 * lulls) are real training at lower intensity, not noise to average away.
 */
export const HR_FIT_MIN_CONFIDENCE = 0.4;

/**
 * A second, STRICTER threshold above `HR_FIT_ELEVATION_MARGIN_BPM` — 45 bpm
 * over baseline. Added directly from a frontend-reviewer finding (N522 PR
 * review), reproduced with a synthetic fixture: a candidate scored purely on
 * `HR_FIT_ELEVATION_MARGIN_BPM`/`HR_FIT_MIN_CONFIDENCE` cannot tell real
 * training apart from any other sustained, moderately-raised activity — a
 * brisk walk held at 100-114 bpm against a 60-77 bpm baseline (threshold
 * ~85-90) clears `threshold` for its ENTIRE length and scores an identical
 * 1.0 to genuine training, which has real low stretches (drilling/
 * instruction lulls) pulling its own score down from 1.0. BJJ training
 * reliably produces near-maximal surges — live rolling, a hard round — that
 * a walk or errand essentially never reaches; this doesn't replace
 * `HR_FIT_ELEVATION_MARGIN_BPM`, it's a second, independent bar a candidate
 * also has to clear (see `HR_FIT_MIN_HIGH_INTENSITY_FRACTION` below for how).
 */
export const HR_FIT_HIGH_INTENSITY_MARGIN_BPM = 45;

/**
 * The minimum fraction of a candidate's COVERED time that must clear
 * `HR_FIT_HIGH_INTENSITY_MARGIN_BPM` for that candidate to be trusted at all
 * — 0.05. Deliberately small: real training's genuinely high-intensity
 * stretches (a hard live round) are usually a MINORITY of a full class, not
 * a majority — most of a BJJ session is instruction, drilling and rest
 * between rounds. This asks only for SOME real high-intensity presence, not
 * for it to dominate. A candidate that never clears
 * `HR_FIT_HIGH_INTENSITY_MARGIN_BPM` at all scores 0 outright (see
 * `scoreCandidate`), regardless of how well it otherwise clears
 * `HR_FIT_ELEVATION_MARGIN_BPM` — a walk that never produces a genuine spike
 * fails here even if it is elevated for its entire length.
 */
export const HR_FIT_MIN_HIGH_INTENSITY_FRACTION = 0.05;

/**
 * How close two candidates' scores have to be to count as "comparably
 * good" for the ambiguity check — 0.1 (10 percentage points of elevated-time
 * fraction). Candidates within this margin of the best score are treated as
 * describing the same underlying event if their windows overlap, and as a
 * genuine ambiguity — decline rather than guess — if they don't.
 */
export const HR_FIT_AMBIGUITY_MARGIN = 0.1;

/** Candidate start times are stepped by this much while scanning the wide
 *  window — 2 minutes. Fine enough that the true block's real boundary is
 *  never missed by more than a couple of minutes; coarse enough that
 *  scanning a ~28-hour wide window (worst case: a full dated day plus
 *  padding) stays cheap. This is a background, best-effort pass with no
 *  latency budget (see `biometricSync.ts`'s own doc comment) — there is no
 *  reason to scan any finer than this. */
export const HR_FIT_CANDIDATE_STEP_MS = 2 * 60_000;

type Candidate = { startMs: number; endMs: number; score: number; count: number };

function toMs(point: HRFitPoint): number {
  return new Date(point.measuredAt).getTime();
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(p * (sortedValues.length - 1))));
  return sortedValues[idx];
}

/**
 * How much a `[startMs, startMs + durationMs)` placement looks like real
 * sustained training, on the SAME "attribute a gap to the sample that opens
 * it, cap it at a maximum, sum the covered time" method
 * `backend/internal/modules/biometric/trimp.go`'s `ZoneBreakdown` already
 * uses — see `HR_FIT_MAX_GAP_MS`'s doc comment. `score` is the fraction of
 * COVERED time (not wall-clock duration) spent above `threshold` — a single
 * spike surrounded by long gaps scores low even if its one reading is high,
 * because the covered time it contributes is small; a sustained stretch of
 * genuinely elevated readings, even with real dips (drilling lulls), scores
 * high because most of its covered time clears the threshold.
 *
 * `score` is forced to 0 whenever the candidate never clears
 * `highIntensityThreshold` for at least `HR_FIT_MIN_HIGH_INTENSITY_FRACTION`
 * of its own covered time — see that constant's doc comment: a high
 * elevated-fraction alone (this function's original, sole signal) cannot
 * tell real training apart from any other sustained moderately-raised
 * activity, and this is the independent second bar that closes that gap.
 */
function scoreCandidate(
  sortedSamples: readonly HRFitPoint[],
  startMs: number,
  endMs: number,
  threshold: number,
  highIntensityThreshold: number,
): { score: number; count: number } {
  const inWindow = sortedSamples.filter((s) => {
    const t = toMs(s);
    return t >= startMs && t <= endMs;
  });
  if (inWindow.length < HR_FIT_MIN_SAMPLES_IN_CANDIDATE) return { score: 0, count: inWindow.length };

  let covered = 0;
  let elevated = 0;
  let highIntensity = 0;
  for (let i = 0; i + 1 < inWindow.length; i++) {
    const t0 = toMs(inWindow[i]);
    const t1 = toMs(inWindow[i + 1]);
    const gap = t1 - t0;
    if (gap <= 0) continue;
    const capped = Math.min(gap, HR_FIT_MAX_GAP_MS);
    covered += capped;
    if (inWindow[i].bpm >= threshold) elevated += capped;
    if (inWindow[i].bpm >= highIntensityThreshold) highIntensity += capped;
  }
  if (covered === 0) return { score: 0, count: inWindow.length };
  if (highIntensity / covered < HR_FIT_MIN_HIGH_INTENSITY_FRACTION) return { score: 0, count: inWindow.length };
  return { score: elevated / covered, count: inWindow.length };
}

/**
 * Fits a `durationMs`-long window against `samples` — the pure core of
 * N522/#934's fix. See this file's own doc comment for the full design;
 * this function's job is narrow: given a wide set of real readings, the
 * session's own logged duration, and its (wrong) original anchor, either
 * find ONE placement worth trusting or say so honestly by returning `null`.
 *
 * `anchor` is used only as a PROXIMITY tie-break among candidates that are
 * already comparably good and describing the same event (their windows
 * overlap) — never to prefer a worse-scoring candidate, and never to break
 * a tie between two candidates that are genuinely far apart (see the
 * ambiguity check below, which declines outright rather than let proximity
 * decide between two real possibilities).
 *
 * Returns `null` when: there are too few samples overall to trust a
 * baseline; no candidate placement fits inside the sample range at all
 * (the wide window is narrower than `durationMs`); the best score never
 * clears `HR_FIT_MIN_CONFIDENCE`; or the best score is genuinely AMBIGUOUS
 * with a comparably-good candidate whose window does not overlap it (two
 * real possibilities, no way to tell which is right).
 */
export function fitHRWindow(
  samples: readonly HRFitPoint[],
  durationMs: number,
  anchor: { start: string; end: string },
): HRWindowFit | null {
  if (samples.length < HR_FIT_MIN_TOTAL_SAMPLES || durationMs <= 0) return null;

  const sorted = [...samples].sort((a, b) => toMs(a) - toMs(b));
  const minMs = toMs(sorted[0]);
  const maxMs = toMs(sorted[sorted.length - 1]);
  if (maxMs - minMs < durationMs) return null;

  const sortedBPM = sorted.map((s) => s.bpm).sort((a, b) => a - b);
  const baseline = percentile(sortedBPM, HR_FIT_BASELINE_PERCENTILE);
  const threshold = baseline + HR_FIT_ELEVATION_MARGIN_BPM;
  const highIntensityThreshold = baseline + HR_FIT_HIGH_INTENSITY_MARGIN_BPM;

  const candidates: Candidate[] = [];
  for (let s = minMs; s <= maxMs - durationMs; s += HR_FIT_CANDIDATE_STEP_MS) {
    const e = s + durationMs;
    const { score, count } = scoreCandidate(sorted, s, e, threshold, highIntensityThreshold);
    candidates.push({ startMs: s, endMs: e, score, count });
  }
  // The last possible placement (ending exactly at maxMs) is never missed
  // to a step-size rounding error.
  const lastStart = maxMs - durationMs;
  if (candidates.length === 0 || candidates[candidates.length - 1].startMs !== lastStart) {
    const { score, count } = scoreCandidate(sorted, lastStart, maxMs, threshold, highIntensityThreshold);
    candidates.push({ startMs: lastStart, endMs: maxMs, score, count });
  }

  const scored = candidates.filter((c) => c.count >= HR_FIT_MIN_SAMPLES_IN_CANDIDATE);
  if (scored.length === 0) return null;

  const maxScore = Math.max(...scored.map((c) => c.score));
  if (maxScore < HR_FIT_MIN_CONFIDENCE) return null;

  const nearBest = scored
    .filter((c) => c.score >= maxScore - HR_FIT_AMBIGUITY_MARGIN)
    .sort((a, b) => a.startMs - b.startMs);

  // Cluster near-best candidates by window overlap — candidates describing
  // the SAME real event naturally overlap (their windows are all
  // `durationMs` long and centred near the true block), so more than one
  // cluster means at least two genuinely separate, comparably-good
  // placements: a real ambiguity, not a discretization artifact.
  const clusters: Candidate[][] = [];
  for (const c of nearBest) {
    const cluster = clusters[clusters.length - 1];
    const clusterEnd = cluster?.[cluster.length - 1]?.endMs;
    if (cluster && clusterEnd !== undefined && c.startMs <= clusterEnd) {
      cluster.push(c);
    } else {
      clusters.push([c]);
    }
  }
  if (clusters.length > 1) return null;

  const winners = clusters[0];
  const top = Math.max(...winners.map((c) => c.score));
  const finalists = winners.filter((c) => c.score === top);
  const anchorStartMs = new Date(anchor.start).getTime();
  finalists.sort((a, b) => Math.abs(a.startMs - anchorStartMs) - Math.abs(b.startMs - anchorStartMs));
  const chosen = finalists[0];

  // N522/#934 backend-reviewer + frontend-reviewer: a fit this file is
  // otherwise happy with can still sit further from the session's own
  // started_at than the backend's `ValidateHRWindowOverride` will ever
  // accept (see `HR_FIT_MAX_BACKEND_DRIFT_MS`'s doc comment for why — it's
  // structural, not a tuning gap). Measured against `sessionStartedAt` the
  // same way the backend measures it: both boundaries, independently.
  if (
    Math.abs(chosen.startMs - anchorStartMs) > HR_FIT_MAX_BACKEND_DRIFT_MS ||
    Math.abs(chosen.endMs - anchorStartMs) > HR_FIT_MAX_BACKEND_DRIFT_MS
  ) {
    return null;
  }

  return {
    start: new Date(chosen.startMs).toISOString(),
    end: new Date(chosen.endMs).toISOString(),
    confidence: chosen.score,
  };
}
