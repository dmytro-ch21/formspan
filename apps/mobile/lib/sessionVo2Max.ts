import type { BiometricSample } from './biometric';

/**
 * N547/#990 part two — VO₂max beside a session, without claiming the session
 * produced it.
 *
 * The athlete asked for avg HR and VO₂max "in summaries". Part one put avg
 * heart rate on the summary surfaces (`lib/sessionHR.ts`). This is the other
 * half, and it could not follow the same shape, because the two numbers are
 * not the same KIND of number.
 *
 * ## Why VO₂max is not a session statistic
 *
 * `avg_hr_bpm` is measured during the session and belongs to it. VO₂max is
 * not on `SessionMetrics` at all: it is a separate `vo2_max` biometric SERIES
 * with its own cadence, written by HealthKit/Health Connect syncs days apart
 * and moving slowly over weeks. Nothing about a Tuesday roll produces a
 * VO₂max reading.
 *
 * So the two placements this deliberately refuses:
 *
 * - **In the session's stat row**, beside average and max heart rate. Sitting
 *   there it reads as "your VO₂max for this session", which is the exact
 *   sentence the ticket's second criterion forbids.
 * - **On a session LIST row.** The same estimate would repeat down a week of
 *   sessions as though each one had earned it — a number that does not vary
 *   per row, rendered per row.
 *
 * ## The shape chosen: a dated estimate, as of that session's day
 *
 * One line, under the stats, naming the reading's own date: the latest
 * reading taken ON OR BEFORE the session's day. Two properties matter and
 * both are about not overstating:
 *
 * - **On or before.** A session from three weeks ago is shown the estimate
 *   that stood THEN, not today's. Showing the current figure next to an old
 *   session would be an anachronism the athlete cannot see — the number would
 *   silently change every time a new reading arrived.
 * - **Its own date, always.** The line says when the estimate was taken, so it
 *   can never be read as a per-session measurement, even when the reading
 *   happens to fall on the session's own day.
 *
 * Absent reads as absent — `null`, no zero, no placeholder — per the
 * `hr_source: 'none'` discipline the rest of this feature already follows.
 * VO₂max has no local cache (unlike part one's heart rate), so offline this
 * is simply not shown rather than shown stale.
 */

export type Vo2MaxReading = {
  value: number;
  /** The day the reading was taken, `YYYY-MM-DD`. */
  measuredOn: string;
};

/** The day part of an RFC3339 instant, without constructing a Date. */
function dayOf(measuredAt: string): string {
  return measuredAt.slice(0, 10);
}

/**
 * The latest VO₂max reading taken on or before `sessionDay`.
 *
 * `null` when the athlete has no reading that old — a session predating their
 * first sync has no honest number to show, and inventing one from a later
 * reading is precisely the overstatement this module exists to avoid.
 */
export function vo2MaxAsOf(
  samples: readonly BiometricSample[],
  sessionDay: string,
): Vo2MaxReading | null {
  let best: BiometricSample | null = null;
  for (const s of samples) {
    if (dayOf(s.measured_at) > sessionDay) continue;
    // Ties on the same instant keep the first seen; the server orders by
    // `measured_at`, but this must not depend on that.
    if (best === null || s.measured_at > best.measured_at) best = s;
  }
  return best === null ? null : { value: best.value, measuredOn: dayOf(best.measured_at) };
}

/**
 * The line to render, or `null` when there is nothing to say.
 *
 * `formatDay` is passed in rather than chosen here: this module stays pure and
 * locale-free, the same reason `vo2MaxSource.ts` takes `Platform.OS` as a
 * parameter instead of reading it.
 */
export function vo2MaxAsOfLine(
  reading: Vo2MaxReading | null,
  formatDay: (day: string) => string,
): string | null {
  if (reading === null) return null;
  // One decimal: VO₂max moves slowly and the server stores more precision than
  // is meaningful to show. "estimate from" is doing the honesty work — it is
  // what stops the number reading as this session's own.
  return `VO₂max ${reading.value.toFixed(1)} · estimate from ${formatDay(reading.measuredOn)}`;
}
