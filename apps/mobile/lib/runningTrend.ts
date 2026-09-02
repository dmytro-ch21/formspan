import { dayString } from './calendar';
import { RUN_EXERCISE_ID } from './running';
import type { Session } from './sessions';
import { buildTrend, type Reading, type TrendRangeKey, type TrendSeries } from './trendSeries';

/**
 * Running's mobile trend — distance over time, N463.
 *
 * ## Why this passes the carve-out
 *
 * The at-the-run decision — pace, splits, whether to push the last kilometre
 * — is already answered live by `app/running/[id].tsx`'s stat row and split
 * list while the run is happening. What is left is "is my distance climbing
 * over the last few weeks", which is asked while planning next week's
 * mileage, away from a laptop — the same shape N57's amendment already
 * blessed for per-exercise load (`lib/loadTrend.ts`). One metric only
 * (distance), preset windows that all end today, no start+end picker. The
 * comparable, exportable, correlate-with-training-load version is N464
 * (#775), on web, and this module is not a step toward moving it: it reads
 * only what the phone already fetches, nothing web-shaped like a metric
 * picker or a bespoke date range.
 *
 * ## Why the data comes from `/sessions`, not `/records/{id}/history`
 *
 * A run is an ordinary session (`sport: 'running'`) plus a `session_sets`
 * row against the seeded `run` exercise (`RUN_EXERCISE_ID`) — the same
 * pipeline `app/running/[id].tsx`'s `finish()` writes and the generic
 * personal-record pipeline already reads for `furthest_distance`. But
 * `session.LoadHistory` (the endpoint `lib/loadTrend.ts` and
 * `lib/records.ts#fetchLoadHistory` read) only ever carries WEIGHT fields —
 * `top_weight_kg`, the 1RM estimate — because it was built for lifts. It
 * has no distance column, and giving it one is a backend change this ticket
 * does not need: the generic `GET /v1/sessions?sport=running` listing
 * (`lib/sessions.ts#listSessionsPage`) already returns each session's `sets`
 * in full, `distance_m` included, so a distance-over-time series is a pure
 * client-side reduction over data the app already fetches elsewhere.
 *
 * ## Why there is no connecting line
 *
 * Matches `buildLoadTrend`'s reasoning exactly: runs are not logged daily,
 * so a gap between two of them carries no meaning of its own — nothing was
 * skipped, the same way a rest day between lifting sessions is not a missed
 * weigh-in. No `smooth` is passed to {@link buildTrend}, so it draws dots —
 * every real run gets one — never a line inventing a rate of change between
 * training days that were never meant to be continuous.
 *
 * ## Why there is no goal line
 *
 * A run has no prescribed weekly-mileage target on this athlete's profile
 * the way a weight-loss phase has a target weight, so `goal` is simply never
 * passed to `TrendChart` here — the same absence `lib/loadTrend.ts` documents
 * for per-exercise load, for the same reason.
 */

/** One session that recorded a run — a session id, when it happened, and how far. */
export type RunSessionPoint = {
  session_id: string;
  started_at: string;
  /** Metres. Summed across every completed `run`-exercise set in the
   *  session — normally exactly one, the single set `finish()` writes. */
  distance_m: number;
};

/**
 * Extracts one point per session that actually covered ground.
 *
 * Reads the SETS, not a `sport` field on the session — the same contract
 * `internal/modules/running/running.go`'s package doc and `RUN_EXERCISE_ID`
 * describe: a run is a session plus a `run`-exercise set, and asking the
 * sets directly keeps this correct even if a caller ever hands it an
 * unfiltered list rather than one already scoped to `sport=running`.
 *
 * A session with more than one `run` set (unusual today, but nothing
 * enforces one-per-session) sums them — the total ground covered that
 * session, matching how `tonnage_kg` sums a session's sets for load rather
 * than keeping only the heaviest.
 *
 * Sessions that never recorded a distance — abandoned before Finish, or any
 * non-running session that slipped through an unfiltered list — are dropped
 * rather than kept as a zero: a zero-distance dot would read as a real run
 * that covered no ground, which is not a fact this data can support.
 */
export function runPointsFromSessions(sessions: Session[]): RunSessionPoint[] {
  return sessions
    .map((s) => {
      const distance_m = s.sets
        .filter(
          (set) => set.exercise_id === RUN_EXERCISE_ID && set.completed && set.distance_m != null,
        )
        .reduce((sum, set) => sum + (set.distance_m as number), 0);
      return { session_id: s.id, started_at: s.started_at, distance_m };
    })
    .filter((p) => p.distance_m > 0);
}

/**
 * Build the distance-over-time series for one preset window.
 *
 * `points === null` means "we could not load them" — kept distinct from an
 * empty array, matching {@link buildTrend}'s own `unavailable` vs. `none`
 * split, so a failed fetch never renders as "you haven't run yet".
 */
export function buildDistanceTrend(
  points: RunSessionPoint[] | null,
  range: TrendRangeKey,
  today: string = dayString(new Date()),
): TrendSeries {
  const readings: Reading[] | null =
    points == null
      ? null
      : points.map((p) => ({ on: dayString(new Date(p.started_at)), value: p.distance_m }));
  return buildTrend({ readings, today, range });
}
