import { apiRequest } from './apiRequest';
import { shortDate } from './calendar';
import type { Exercise } from './exercises';
import { localZone } from './history';
import type { LoggedSet } from './sessions';
import { formatWeight, type UnitSystem } from './units';
import type { TokenGetter } from './useAuthToken';

/**
 * The bodyweight a finished session was performed at, N453 (#756).
 *
 * "10 pull-ups" means something different at 68 kg than at 136 kg, and a
 * reps-only set has no weight to say which. The server answers with the
 * athlete's most recent weigh-in ON OR BEFORE the day the session started, and
 * derives it when the session is read. Nothing is stored, on the server or
 * here.
 *
 * ## Display only
 *
 * This never becomes a set's `weight_kg`. Tonnage, estimated 1RM and records
 * all read that field, and filling it would change every figure an athlete has
 * been comparing. Whether bodyweight should feed those is an open decision
 * (docs/decisions/history.md, N453).
 *
 * ## Online only, and silence is the fallback
 *
 * A finished session is read from the phone's own store, and that store does
 * not carry this value. It is decoration on a review, like the session card's
 * calorie figure. With no signal, or a server too old to send it, the screen
 * shows what it showed before N453: the reps, and no load figure. It never
 * shows a number the server did not give, and never says "no check-in" when it
 * merely could not ask.
 */
export type SessionBodyweight = {
  kg: number;
  /** The check-in's own day, YYYY-MM-DD, shown so an old reading reads as old. */
  measuredOn: string;
};

/** The two fields `GET /v1/sessions/{id}` carries beside `volume`. */
type DetailBodyweightFields = {
  bodyweight_kg?: number | null;
  bodyweight_measured_on?: string | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Both fields or nothing. A weight with no date could not be labelled with
 * its check-in, and a date with no weight has nothing to show, so each half
 * alone is treated as absent rather than rendered partly.
 */
export function parseSessionBodyweight(
  body: DetailBodyweightFields | null | undefined,
): SessionBodyweight | null {
  const weight = body?.bodyweight_kg;
  const on = body?.bodyweight_measured_on;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return null;
  if (typeof on !== 'string' || !DAY.test(on)) return null;
  return { kg: weight, measuredOn: on };
}

/**
 * The names of this session's bodyweight exercises, in the order first
 * performed. Only COMPLETED sets count: a planned pull-up nobody did is not a
 * reason to talk about bodyweight.
 *
 * "Bodyweight exercise" is `load_type: 'reps'`, the exact shape the ticket
 * names: reps and no weight field. Every reps-only movement in the catalog
 * moves the athlete's own body, including rings, suspension trainers, box
 * jumps and a band-assisted pull-up.
 *
 * An exercise missing from `catalog` is left out. While the catalog is still
 * loading, the line stays off rather than guessing what an id is.
 */
export function bodyweightExerciseNames(
  sets: readonly Pick<LoggedSet, 'exercise_id' | 'completed'>[],
  catalog: ReadonlyMap<string, Pick<Exercise, 'load_type' | 'name'>>,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const s of sets) {
    if (!s.completed || seen.has(s.exercise_id)) continue;
    const e = catalog.get(s.exercise_id);
    if (e?.load_type !== 'reps') continue;
    seen.add(s.exercise_id);
    names.push(e.name);
  }
  return names;
}

/**
 * "Bodyweight 82.4kg, from your 12 Sep check-in", in the athlete's unit.
 *
 * The date is always stated. The reading may be weeks older than the session,
 * and the athlete deserves to know that rather than assume it is the day's.
 */
export function describeBodyweight(bw: SessionBodyweight | null, units: UnitSystem): string | null {
  if (!bw) return null;
  return `Bodyweight ${formatWeight(bw.kg, units)}, from your ${shortDate(bw.measuredOn)} check-in`;
}

/**
 * Asks the server for a session's bodyweight.
 *
 * `zone` decides which calendar day the session started on, and so which
 * check-in is "on or before" it. The phone's own zone is the athlete's day.
 * UTC would move a 7pm Los Angeles session onto the next morning, where it
 * would pick up a later weigh-in.
 */
export async function getSessionBodyweight(
  getToken: TokenGetter,
  sessionID: string,
  signal?: AbortSignal,
  zone: string = localZone(),
): Promise<SessionBodyweight | null> {
  const body = await apiRequest<DetailBodyweightFields>(
    getToken,
    `/sessions/${encodeURIComponent(sessionID)}?tz=${encodeURIComponent(zone)}`,
    { signal },
  );
  return parseSessionBodyweight(body);
}
