import { HR_FIT_MAX_BACKEND_DRIFT_MS } from './hrWindowFit';

/**
 * W19/#985 — which window a session's heart rate should actually be read
 * from, when the health store knows about the workout itself.
 *
 * ## The bug this exists to fix
 *
 * Both orchestrators asked their health store for exactly
 * `[session.started_at, session.ended_at]`. For the incident in
 * `lib/biometric.ts`'s `hrSampleCoverage` doc comment, those were 18:41:48
 * → 20:11:48 — the athlete's own typed 90 minutes, ending
 * `started_at + 90m` **to the millisecond**, because that is what a
 * post-hoc log produces. The class itself ran 19:19 → 20:47. So the query
 * averaged in 38 minutes of standing around before the class and dropped
 * its last 36 minutes, which is precisely where the max lives.
 *
 * The athlete's own suggested fix was to widen the window by ±20 minutes.
 * **That instinct is right about the fallback and wrong on its own**, and
 * the incident says why: padding the START pulls in *more* rest, dragging
 * the average further down. Padding has to be paired with fitting, never
 * with averaging — hence `paddedHRSearchWindow` here being a SEARCH window
 * handed to `lib/hrWindowFit.ts`'s `fitHRWindow`, and never a window whose
 * samples are averaged directly.
 *
 * ## Why the watch's own workout comes first
 *
 * When the store holds a workout overlapping the session, that workout's
 * start and end are a *measurement* of when training happened, against a
 * pair of typed times that are at best an estimate of it. There is nothing
 * to infer and nothing to score: use it. `HKWorkoutTypeIdentifier` is
 * already in `lib/healthkit.ts`'s `READ_TYPES` and Health Connect's
 * `ExerciseSession` is already in `lib/healthConnect.ts`'s
 * `READ_RECORD_TYPES` (N479/#824), so this asks for no new permission and
 * shows no new consent screen on either platform.
 *
 * Everything here is pure over plain data — no HealthKit import, no Health
 * Connect import, no network — so the whole selection decision is unit
 * tested without a device, in `lib/__tests__/hrWorkoutWindow.test.ts`, and
 * both platforms' orchestrators share one answer rather than deriving two.
 *
 * **The session's own `started_at`/`ended_at` are never rewritten by any of
 * this.** A chosen window travels as `computeSessionMetrics`'s
 * `windowOverride`, which changes only which samples the server reads —
 * "heart rate corroborates a session, it never replaces what the athlete
 * logged", the same line `lib/hrWindowFit.ts` is built on.
 */

/** One workout the health store knows about, reduced to the only two facts
 *  this decision needs. Platform-neutral on purpose: `HealthKitOtherWorkout`
 *  and `HealthConnectOtherWorkout` both carry type, id and duration that
 *  nothing here reads. */
export type WorkoutWindow = {
  /** RFC3339 */
  start: string;
  /** RFC3339 */
  end: string;
};

/**
 * How far either side of the logged window to look — 20 minutes, **the
 * athlete's own suggested number**, taken as the starting point the ticket
 * names rather than invented here.
 *
 * It bounds two different searches, for the same reason in both: how wrong
 * a typed start or end plausibly is. A live-tracked session's times are
 * real clock readings and this padding is harmlessly unused; a post-hoc log
 * is the case that needs it, and the incident's own error (38 minutes) sits
 * beyond it — which is exactly why the padded search is a fallback with a
 * FIT inside it and `lib/hrWindowFit.ts`'s much wider dated-day search still
 * sits behind that for the badly-mistyped case.
 */
export const HR_SEARCH_PADDING_MINUTES = 20;

/**
 * The minimum share of a candidate workout's OWN length that must fall
 * inside the logged session window — 0.5.
 *
 * This is the "is this the same event" bar. A workout mostly outside the
 * logged window is a different activity that happens to graze it (the walk
 * to the gym, the drive home), and reading the session's heart rate from it
 * would be worse than reading the wrong window this ticket exists to fix.
 * The incident's own class scored 0.59 against it (52 of its 88 minutes
 * fell inside the logged window) — clear, but not by so much that a
 * stricter bar would have been safe.
 */
export const WORKOUT_MIN_OVERLAP_FRACTION = 0.5;

/**
 * How similar a candidate workout's length must be to the session's own —
 * 0.5, measured as the shorter over the longer, so it bounds BOTH
 * directions with one number.
 *
 * The two failures it closes are opposite and both real: a five-minute walk
 * sitting entirely inside a logged 90-minute class passes the overlap bar
 * at a perfect 1.0 and must not be mistaken for the class (0.06 here); an
 * all-day "workout" some apps write engulfs the session and passes the
 * overlap bar too (0.19 here). The incident's class scored 0.98.
 */
export const WORKOUT_MIN_DURATION_SIMILARITY = 0.5;

/**
 * How close a second candidate's score has to be to the best one's before
 * the two count as genuinely ambiguous — 0.1, mirroring
 * `lib/hrWindowFit.ts`'s `HR_FIT_AMBIGUITY_MARGIN` deliberately: this is
 * the same question that file already answers, asked about workouts rather
 * than about sample placements, and it deserves the same answer rather than
 * a second independently-tuned one.
 *
 * Candidates that OVERLAP the winner never trigger it — a watch that
 * recorded one class as two adjacent halves, or a phone and a strap that
 * both logged it, are one event described twice, not two possibilities.
 */
export const WORKOUT_AMBIGUITY_MARGIN = 0.1;

type Scored = { window: WorkoutWindow; startMs: number; endMs: number; score: number };

function msOf(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * `[start − padding, end + padding]` — the search window for a fallback
 * fit, and the basis of the workout query below. Never a window whose
 * samples are averaged directly; see this file's own doc comment on why
 * padding without fitting makes the incident worse rather than better.
 */
export function paddedHRSearchWindow(
  start: string | Date,
  end: string | Date,
  paddingMinutes: number = HR_SEARCH_PADDING_MINUTES,
): { start: Date; end: Date } {
  const paddingMs = paddingMinutes * 60_000;
  return {
    start: new Date(new Date(start).getTime() - paddingMs),
    end: new Date(new Date(end).getTime() + paddingMs),
  };
}

/**
 * The window to ASK a health store for workouts in — deliberately wider at
 * the start than `paddedHRSearchWindow`, and by an amount this function
 * derives rather than declares.
 *
 * Both stores filter workouts by when they STARTED, so a workout that began
 * before the search window and is still running inside it would never be
 * returned. The earliest such workout that could survive
 * `selectWorkoutWindow` is bounded by the rules themselves: a candidate must
 * be at least `WORKOUT_MIN_DURATION_SIMILARITY` as long as the session, so
 * it can be at most `sessionDuration / WORKOUT_MIN_DURATION_SIMILARITY`
 * long, and it must still overlap the logged window. Looking back by that
 * much therefore cannot miss an admissible candidate, and cannot be made
 * stale by retuning either constant — which is the point of deriving it
 * instead of adding a fourth number here that would silently stop agreeing
 * with the other three.
 *
 * Over-fetching is free: `selectWorkoutWindow` filters purely, so anything
 * extra this returns is discarded without a second query.
 */
export function workoutSearchWindow(
  sessionStart: string | Date,
  sessionEnd: string | Date,
): { start: Date; end: Date } {
  const padded = paddedHRSearchWindow(sessionStart, sessionEnd);
  const sessionMs = Math.max(0, new Date(sessionEnd).getTime() - new Date(sessionStart).getTime());
  const longestAdmissibleMs = sessionMs / WORKOUT_MIN_DURATION_SIMILARITY;
  return { start: new Date(padded.start.getTime() - longestAdmissibleMs), end: padded.end };
}

/**
 * The health store's own workout window to read this session's heart rate
 * from, or `null` when none is worth trusting.
 *
 * Admission (both bars, independently — see each constant's own doc
 * comment): the candidate must be mostly inside the logged window
 * (`WORKOUT_MIN_OVERLAP_FRACTION`) and comparable in length to it
 * (`WORKOUT_MIN_DURATION_SIMILARITY`). It must additionally sit within
 * `HR_FIT_MAX_BACKEND_DRIFT_MS` of the session's own `started_at` on both
 * boundaries — the backend's `ValidateHRWindowOverride` rejects anything
 * further, permanently, and a deterministic 400 is worse here than never
 * having found the workout at all (see that constant's own doc comment in
 * `lib/hrWindowFit.ts` for the full account of why the client has to carry
 * this check itself).
 *
 * ## What happens with several
 *
 * Survivors are ranked by how much of the two windows' UNION their overlap
 * accounts for — one number that prefers a workout matching the session
 * closely over one that merely contains it, which neither admission bar
 * does on its own. The best wins.
 *
 * If a second survivor scores within `WORKOUT_AMBIGUITY_MARGIN` of the best
 * AND does not overlap it, this returns `null` rather than guessing: two
 * genuinely separate, comparably-good candidates is exactly the state where
 * picking one is a coin flip presented as a measurement. A survivor that
 * overlaps the winner is the same event described twice and never triggers
 * this. Same posture, same margin, as `fitHRWindow`'s own ambiguity check.
 */
export function selectWorkoutWindow(
  sessionStart: string | Date,
  sessionEnd: string | Date,
  workouts: readonly WorkoutWindow[],
): WorkoutWindow | null {
  const sessionStartMs = new Date(sessionStart).getTime();
  const sessionEndMs = new Date(sessionEnd).getTime();
  if (!Number.isFinite(sessionStartMs) || !Number.isFinite(sessionEndMs)) return null;
  const sessionMs = sessionEndMs - sessionStartMs;
  if (sessionMs <= 0) return null;

  const survivors: Scored[] = [];
  for (const w of workouts) {
    const startMs = msOf(w.start);
    const endMs = msOf(w.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const workoutMs = endMs - startMs;
    if (workoutMs <= 0) continue;

    const overlapMs = Math.min(sessionEndMs, endMs) - Math.max(sessionStartMs, startMs);
    if (overlapMs <= 0) continue;
    if (overlapMs / workoutMs < WORKOUT_MIN_OVERLAP_FRACTION) continue;

    const similarity = Math.min(workoutMs, sessionMs) / Math.max(workoutMs, sessionMs);
    if (similarity < WORKOUT_MIN_DURATION_SIMILARITY) continue;

    if (
      Math.abs(startMs - sessionStartMs) > HR_FIT_MAX_BACKEND_DRIFT_MS ||
      Math.abs(endMs - sessionStartMs) > HR_FIT_MAX_BACKEND_DRIFT_MS
    ) {
      continue;
    }

    const unionMs = Math.max(sessionEndMs, endMs) - Math.min(sessionStartMs, startMs);
    survivors.push({ window: { start: w.start, end: w.end }, startMs, endMs, score: overlapMs / unionMs });
  }
  if (survivors.length === 0) return null;

  // Stable, deterministic order before any comparison: best score first,
  // earliest start as the tie-break, so two candidates that genuinely score
  // identically (a class recorded twice at the same times by two apps)
  // resolve the same way on every pass rather than following array order.
  survivors.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const best = survivors[0];

  const ambiguous = survivors
    .slice(1)
    .some(
      (c) =>
        c.score >= best.score - WORKOUT_AMBIGUITY_MARGIN &&
        (c.endMs <= best.startMs || c.startMs >= best.endMs),
    );
  if (ambiguous) return null;

  return best.window;
}
