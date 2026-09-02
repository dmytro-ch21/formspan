import type { ExerciseRecords, PersonalRecord } from './records';
import { hasUnresolvedLoad, type SetType } from './sessions';
import { formatDistance as formatDistanceMetric, formatPace as formatPaceMetric } from './units';

/**
 * What a finished session gets to say about itself.
 *
 * Pure, and deliberately a plain data object rather than something read off the
 * session screen's state: the card that renders this is meant to become a
 * shareable image later, and a component that reaches into a screen for its
 * numbers cannot be rendered anywhere else. Everything the card shows arrives
 * through `SessionSummary` and nothing else does.
 *
 * ## Objective and subjective are separated here, not in the view
 *
 * `stats` is what the session measurably WAS — time, sets, reps, tonnage.
 * `felt` is one number somebody typed about themselves, and it is nullable
 * because effort tracking is a setting the athlete can turn off, so RPE is
 * legitimately absent for whole stretches of history. Mixing them into one row
 * of tiles would present a self-rating as a measurement and would render a
 * confident "0" for an athlete who simply never opted in.
 */

export type CelebrationSport = 'strength' | 'bjj' | 'running';

export type SessionSummary = {
  title: string;
  sport: CelebrationSport;
  /** Wall-clock seconds from start to finish. */
  durationSeconds: number;
  exercises: number;
  sets: number;
  reps: number;
  /** Kilograms. Structurally zero for BJJ — see `statsFor`. */
  tonnageKg: number;
  /**
   * True when `tonnageKg` is a silent UNDER-count — this session swapped an
   * exercise offline and the new one's `load_factor` could not be resolved
   * from the local catalog, so `localVolume` left that set's tonnage out of
   * the sum rather than guessing it (#425). `statsFor` reads this to withhold
   * the Volume tile entirely rather than celebrate a number that is wrong by
   * an unknown amount and will change, unexplained, the moment this syncs.
   *
   * Optional, not because it can legitimately be unknown, but so a caller
   * building a `SessionSummary` by hand for a sport with no tonnage at all —
   * `bjj/session/[id].tsx` sets `tonnageKg: 0` directly, never through
   * `summariseSession` — has nothing new to supply. `statsFor`'s BJJ branch
   * returns before this is ever read there either way; the optionality is
   * belt-and-braces, not load-bearing.
   */
  tonnageUnknown?: boolean;
  /** BJJ only. */
  rounds?: number;
  matMinutes?: number;
  /**
   * Metres. Running only, and left undefined (never a zero) for a manual
   * entry with no distance recorded — the same "omit rather than show a
   * failure to record something" rule `tonnageKg` follows for a bodyweight
   * strength session.
   */
  distanceM?: number;
  /**
   * Seconds per kilometre, averaged over the whole run. Running only, and
   * always stored per-KILOMETRE regardless of the athlete's own unit system —
   * matching `running.SessionDetail.AvgPaceSecPerKm` on the wire, and the same
   * store-in-one-unit / convert-on-the-way-out rule `lib/units.ts` already
   * follows for weight and distance. `statsFor`'s `formatPace` argument is
   * what converts this to seconds-per-mile for an imperial athlete; nothing
   * here does that conversion.
   */
  avgPaceSecPerKm?: number;
  /** Metres of total climb over the run. Running only. */
  elevationGainM?: number;
  /**
   * The GPS track, already thinned to `ROUTE_THUMBNAIL_POINTS` by
   * `downsampleRoute` — see that function's own doc for why a postage-stamp
   * map never needs the full recorded track. Running only, and empty for a
   * manual entry or an imported summary with no track at all (a real run, not
   * an error — `running.RoutePoints`'s own doc covers both). The card omits
   * the thumbnail entirely when this is empty rather than drawing a blank
   * frame.
   */
  routePoints?: { lat: number; lng: number }[];
  /**
   * The hardest effort recorded, or null when effort tracking is off.
   *
   * Null and zero are different states and must stay that way: null means "not
   * collected", zero would mean "recorded as nothing".
   */
  hardestRpe: number | null;
  /** Personal records this session set. Empty offline — see `recordsFromSession`. */
  records: SessionRecord[];
  /**
   * The exercises to ask the records endpoint about.
   *
   * Scoped to what this session actually contained rather than fetching the
   * athlete's whole record history to find a handful of rows — on an account
   * with years of training that is the difference between a small request and
   * a large one, at the exact moment somebody wants to put their phone down.
   */
  recordExerciseIDs: string[];
};

export type SessionRecord = {
  exerciseID: string;
  /**
   * The exercise's real name, resolved by the caller — never set by
   * `recordsFromSession` itself, which only knows an id. Optional/nullable
   * rather than falling back to the id: `undefined` here means "nobody has
   * tried to resolve it yet" (the ordinary state right after the fetch),
   * `null` means "resolution was attempted and the catalog had nothing" —
   * and both read as "say nothing" wherever this is captioned, matching the
   * de-slugified-id ban this ticket exists to end (see `prBadgeFor`).
   */
  exerciseName?: string | null;
  record: PersonalRecord;
};

/**
 * Which of the athlete's records were set by THIS session.
 *
 * The server is the authority on what counts as a record, and every record it
 * returns carries the `session_id` that set it — so this is a filter, not a
 * second implementation of the rules. Re-deriving "is this a best?" on the
 * phone would be a second opinion that can disagree with the records screen,
 * and the two disagreeing about whether you set a PR is worse than not
 * mentioning it.
 *
 * **Empty is the correct answer offline.** Records need the network; a session
 * finished in a basement gym shows no PR section rather than a guessed one.
 * Silence is not a claim, a wrong medal is.
 */
export function recordsFromSession(
  all: ExerciseRecords[],
  sessionID: string,
  /**
   * Resolves an exercise id to its display name, or null when unresolved.
   *
   * Optional, and defaulted to "unresolved" rather than made required — this
   * function has no catalog of its own to consult (it only ever sees ids),
   * so asking every caller for a resolver would make the common
   * filter-only usage (this file's own tests, the celebration modal, which
   * never captions a record by name) thread a no-op through for no reason.
   * A caller that DOES need names — `SessionShare`'s badge — passes a real
   * one.
   */
  exerciseName: (exerciseID: string) => string | null = () => null,
): SessionRecord[] {
  if (!sessionID) return [];
  return all.flatMap((e) => {
    const name = exerciseName(e.exercise_id);
    return e.records
      .filter((r) => r.session_id === sessionID)
      .map((record) => ({ exerciseID: e.exercise_id, exerciseName: name, record }));
  });
}

// `accomplishment` is the mat's half: a BJJ first, derived and stamped by the
// server exactly as a personal record is. See `lib/accomplishments.ts`. One
// slot either way — a session is one sport, so the two never co-occur.
export type Badge = { key: 'record' | 'accomplishment'; label: string };

/**
 * The badge, or nothing at all.
 *
 * **Nothing at all is the common case, and that is the design.** A badge that
 * appears on every session is wallpaper: it stops being read within a week and
 * takes the real ones down with it. So there is exactly one thing worth a badge
 * from the data available the moment a session ends — a personal record, which
 * the server has already decided is genuine.
 *
 * Deliberately NOT badges: long sessions, many exercises, high tonnage. Each
 * would fire constantly for whoever trains that way and never for anyone else,
 * which makes them a description of a training style rather than an
 * achievement. And none of them can be judged without history the phone does
 * not have at this moment.
 *
 * BJJ therefore gets no badge yet, honestly — it has no record equivalent at
 * all. That gap is its own piece of work, and inventing a "you showed up"
 * badge to fill it in the meantime is the exact wallpaper this avoids.
 */
export function badgeFor(
  summary: Pick<SessionSummary, 'records'>,
  /**
   * The mat's half, already resolved by the caller — a BJJ first, from
   * `lib/accomplishments.ts`. Second argument rather than a field on the
   * summary because it arrives from a network call the card does not make.
   *
   * Taking it here rather than falling back at the call site is what makes the
   * precedence testable: "records win, then an accomplishment, then nothing" is
   * a rule, and a rule living in JSX is one nothing can pin.
   */
  accomplishment?: { label: string } | null,
): Badge | null {
  const n = summary.records.length;
  if (n > 0) {
    return { key: 'record', label: n === 1 ? 'Personal record' : `${n} personal records` };
  }
  // Records first, and it is not a real contest: a session is one sport, so a
  // strength session never has an accomplishment and a BJJ session never has
  // records. The order is stated so that if that ever stops being true, the
  // measured thing wins rather than whichever happened to be checked first.
  if (accomplishment) return { key: 'accomplishment', label: accomplishment.label };
  return null;
}

/**
 * Was this session worth showing a card for at all?
 *
 * An empty session — opened, nothing logged, finished — has nothing to
 * celebrate, and congratulating someone for it is the kind of hollow praise
 * that teaches people to ignore the app. They get the ordinary finished screen.
 */
/**
 * Should the streak chime play?
 *
 * One celebratory sound per session, and the personal record outranks the
 * streak: a PR is rare and a streak recurs every week, so hearing the smaller
 * one instead would be the wrong trade every time they coincide.
 *
 * `recordsSettled` is what makes that precedence real rather than a race. The
 * two lookups are independent, and without the gate a fast history would chime
 * the streak and latch the PR out. An EMPTY records result is an answer;
 * a pending one is not, which is why this cannot be inferred from the array.
 *
 * Extracted from the card so the rule is testable without rendering anything —
 * the precedence is the part worth pinning, not the JSX around it.
 */
/**
 * Should the personal-record chime play?
 *
 * Extracted for the same reason `celebratesStreak` was — the precedence is the
 * part worth pinning, not the JSX around it — and extracted *now* because
 * review found the precedence was not actually being enforced by anything a
 * test could see.
 *
 * Two conditions beyond having a record, and both are about losing gracefully
 * to the rung above:
 *
 *  - **`streakSettled`.** The record and the history are independent fetches,
 *    and the shared chime latch is claimed by whichever effect fires FIRST, not
 *    by whichever ranks highest. The records lookup usually answers sooner (a
 *    handful of exercise ids, against a rollup of a year of days), so without
 *    this gate a once-a-year milestone was silenced by a personal record every
 *    time the two coincided. It is the exact mirror of the `recordsSettled`
 *    gate that already keeps the ordinary streak from latching the record out.
 *  - **`milestone`.** Explicit rather than left to the latch, so the rule is
 *    a value a test can assert instead of a property of effect declaration
 *    order inside a component.
 */
export function celebratesRecord(opts: {
  streakSettled: boolean;
  hasRecords: boolean;
  milestone?: boolean;
}): boolean {
  return opts.streakSettled && opts.hasRecords && !opts.milestone;
}

export function celebratesStreak(opts: {
  recordsSettled: boolean;
  hasRecords: boolean;
  carried: boolean;
  /**
   * Whether this session also crossed a streak MILESTONE (N19).
   *
   * Top of the precedence ladder, above the personal record that outranks the
   * ordinary streak — see `celebratesMilestone` for why the frequency argument
   * reverses at that rung. It needs no settling gate of its own: the streak and
   * the milestone are computed from the same history in the same pass, so this
   * boolean is never pending while `carried` is known.
   */
  milestone?: boolean;
}): boolean {
  if (opts.milestone) return false;
  return opts.recordsSettled && !opts.hasRecords && opts.carried;
}

/**
 * Which record gets the share card's PR badge, when a session set more than
 * one.
 *
 * **TOP ONE ONLY** (N447/#745). The badge shares a two-slot rail with the
 * streak line — `cardFromSummary` still pushes "N weeks unbroken" into the
 * second slot — so this rail was never room for a list, and the whole reason
 * this ticket exists is that the card already reads as crowded. A second PR
 * in one session is genuinely rare; naming a third thing would not read as
 * "and more", it would read as truncated.
 *
 * The FIRST record wins, matching `recordsFromSession`'s own order (the
 * order the records endpoint returned exercises in, then each exercise's own
 * record order) — deterministic without needing this function to know
 * anything about which kind of record outranks another.
 */
export function topRecord(records: SessionRecord[]): SessionRecord | null {
  return records[0] ?? null;
}

/**
 * The badge's evidence — what was actually done, never a calculated number.
 *
 * `estimated_1rm`'s own `value` IS a model's output (a rep-max curve — see
 * `RECORD_BASIS` in `lib/records.ts`), and a share card showing that number
 * instead of the set that produced it is the other half of what N447/#745
 * reports. So this never reads `record.value` — it reads the MEASURED
 * `weight_kg`/`reps` off the record instead, which exist for every strength
 * kind because every record, `estimated_1rm` included, is set BY a specific
 * logged set.
 *
 * Returns null for a record with neither — a bodyweight-only record with no
 * rep count, or a `longest_time`/`furthest_distance` kind, which this format
 * does not cover. The card omits the badge line rather than print something
 * unit-less or wrong; `cardFromSummary`'s highlight still says NEW BEST
 * regardless, since that only needs to know a record exists.
 */
export function prEvidence(
  record: Pick<PersonalRecord, 'weight_kg' | 'reps'>,
  formatWeight: (kg: number) => string,
): string | null {
  if (record.weight_kg != null && record.reps != null) {
    return `${formatWeight(record.weight_kg)} × ${record.reps}`;
  }
  if (record.reps != null) return `${record.reps} reps`;
  return null;
}

/**
 * The share card's PR badge text — "Back Squat · 152kg × 5 PR" — or null.
 *
 * Null covers three honest reasons, and none of them fall back to a count or
 * a raw id: no record this session, the top record's exercise name could not
 * be resolved (`SessionRecord.exerciseName`, see its own doc), or the record
 * carries neither a weight nor a rep count for `prEvidence` to describe. A
 * card that cannot caption a PR correctly says nothing instead of guessing.
 */
export function prBadgeFor(
  records: SessionRecord[],
  formatWeight: (kg: number) => string,
): string | null {
  const top = topRecord(records);
  if (!top?.exerciseName) return null;
  const evidence = prEvidence(top.record, formatWeight);
  if (!evidence) return null;
  return `${top.exerciseName} · ${evidence} PR`;
}

export function worthCelebrating(
  summary: Pick<SessionSummary, 'sets' | 'rounds' | 'distanceM'> &
    Partial<Pick<SessionSummary, 'sport' | 'durationSeconds'>>,
): boolean {
  // A run has neither sets nor rounds — a sets-only check would silently
  // suppress the card for the whole sport, exactly the failure `rounds` was
  // added here to fix for BJJ. Gated explicitly on `sport` rather than folded
  // into one big OR, so a stray `distanceM` on some future sport's summary
  // can't accidentally mark it celebration-worthy.
  if (summary.sport === 'running') {
    return (summary.distanceM ?? 0) > 0 || (summary.durationSeconds ?? 0) > 0;
  }
  return summary.sets > 0 || (summary.rounds ?? 0) > 0;
}

/** Enough points to draw a recognisable shape on a postage-stamp map; cheap
 *  to keep in a `SessionSummary` and cheap to render on an old phone. */
export const ROUTE_THUMBNAIL_POINTS = 60;

/**
 * Thins a route down to a size a thumbnail can draw cheaply.
 *
 * A real track can carry up to `running.MaxRoutePoints` (20,000) points; a
 * card meant to be read in three seconds does not need more than a few dozen
 * to read as the run's shape. Strides evenly across the whole array rather
 * than slicing the front of it, so the kept points spread across the WHOLE
 * run — a naive `slice(0, max)` on a marathon's track would draw only its
 * opening kilometre.
 */
export function downsampleRoute(
  points: { lat: number; lng: number }[],
  max: number = ROUTE_THUMBNAIL_POINTS,
): { lat: number; lng: number }[] {
  if (points.length <= max) return points;
  const stride = points.length / max;
  const out: { lat: number; lng: number }[] = [];
  for (let i = 0; i < max; i++) {
    out.push(points[Math.floor(i * stride)]);
  }
  // Always end on the true finish line, wherever striding happened to land —
  // a run's last point is the one place a thumbnail should never guess at.
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * The map region that frames a route, with headroom so the track never
 * touches the thumbnail's own edge.
 *
 * Null for anything a map cannot meaningfully draw — no points, or a single
 * point with nothing to connect it to (a GPS fix taken then immediately
 * stopped). The card omits the thumbnail entirely in that case rather than
 * showing a lone dot on a slab of ocean.
 */
export function regionForRoute(
  points: { lat: number; lng: number }[],
): { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number } | null {
  if (points.length < 2) return null;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLng = points[0].lng;
  let maxLng = points[0].lng;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  // A margin so the track never touches the frame's edge, and a floor so a
  // short out-and-back near one point doesn't zoom in past what a
  // postage-stamp map can usefully show (roughly 400m at the equator).
  const MARGIN = 1.4;
  const MIN_DELTA = 0.004;
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(latSpan * MARGIN, MIN_DELTA),
    longitudeDelta: Math.max(lngSpan * MARGIN, MIN_DELTA),
  };
}

export type Stat = { label: string; value: string };

/** `1h 04m`, or `24m` under the hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/**
 * The objective tiles — what the session measurably was.
 *
 * Sport-shaped, because a shared vocabulary would print the wrong thing for
 * one of them. **Tonnage is omitted for BJJ rather than shown as zero**: a BJJ
 * session genuinely has no tonnage, and a "0 kg" tile on a card meant to mark
 * an achievement reads as a failure to record something. The same reasoning
 * omits it from a strength session that was all bodyweight.
 */
export function statsFor(
  summary: SessionSummary,
  formatTonnage: (kg: number) => string,
  /** Injected for the same reason `formatTonnage` is — a run's distance is
   *  unit-system-dependent and this file must not know which one is active. */
  formatDistance?: (metres: number) => string,
  /** Same reason. Converts `avgPaceSecPerKm` to the athlete's own pace unit
   *  (seconds per mile for imperial); defaults to per-kilometre, matching
   *  storage, so a caller with no unit system handy still gets a real number. */
  formatPace?: (secPerKm: number) => string,
): Stat[] {
  if (summary.sport === 'running') {
    return runningStats(summary, formatDistance, formatPace);
  }

  const stats: Stat[] = [{ label: 'Time', value: formatDuration(summary.durationSeconds) }];

  if (summary.sport === 'bjj') {
    if (summary.rounds) stats.push({ label: 'Rounds', value: String(summary.rounds) });
    // "Rolling", not "Mat time": the screen underneath uses "on the mat" for
    // wall-clock duration, which this card already shows as Time. Two names
    // for one quantity and one name for two is how a summary stops being
    // trusted.
    if (summary.matMinutes) stats.push({ label: 'Rolling', value: `${summary.matMinutes}m` });
    return stats;
  }

  stats.push({ label: 'Sets', value: String(summary.sets) });
  // Reps used to be a third tile here. Dropped (N447/#745): with the PR badge
  // now naming the exercise plus its own weight-and-reps evidence, a bare
  // rep COUNT for the whole session sat next to it saying nothing the badge
  // did not already say better, and the card was reported as "crowded" with
  // it in. Sets and Volume stay — neither is restated anywhere else on the
  // card.
  // `!summary.tonnageUnknown` — a positive number here can still be wrong
  // (#425): an unresolved offline swap makes `tonnageKg` a silent
  // under-count, and a celebration card is exactly the "moments after" case
  // the ticket is about. Omitting it here follows the same rule the omitted-
  // for-BJJ case above already lives by — say nothing rather than something
  // that reads as an achievement and is not the true number.
  if (summary.tonnageKg > 0 && !summary.tonnageUnknown) {
    stats.push({ label: 'Volume', value: formatTonnage(summary.tonnageKg) });
  }
  return stats;
}

/**
 * The running strip: Distance, Duration, Avg Pace, Elevation Gain — replacing
 * Sets/Volume, which a run has neither of.
 *
 * A SEPARATE leading tile from strength/BJJ's shared "Time", not a reuse of
 * it: running already gets its own Duration tile in the same position, and
 * showing the identical number twice under two labels is exactly the
 * crowding N447/#745 removed the Reps tile for.
 *
 * Each tile is omitted, never shown as a zero, when its number is missing —
 * the same rule `statsFor`'s Volume tile follows for a bodyweight session.
 * `formatDistance`/`formatPace` default to `lib/units.ts`'s own metric
 * formatters — not a hand-rolled duplicate — so a caller with no unit system
 * handy (a test, or a screen not yet updated for running) still gets a
 * readable card in the storage unit, rather than a second, driftable copy of
 * the formatting rule.
 */
function runningStats(
  summary: SessionSummary,
  formatDistance?: (metres: number) => string,
  formatPace?: (secPerKm: number) => string,
): Stat[] {
  const distanceFmt = formatDistance ?? ((m: number) => formatDistanceMetric(m, 'metric'));
  const paceFmt = formatPace ?? ((s: number) => formatPaceMetric(s, 'metric'));
  const stats: Stat[] = [];
  if (summary.distanceM != null && summary.distanceM > 0) {
    stats.push({ label: 'Distance', value: distanceFmt(summary.distanceM) });
  }
  // Omitted at zero too, same as every other tile here — a genuinely
  // zero-length run (both the running detail and the start/end timestamps
  // agree on nothing) has no duration to celebrate either. Reachable only
  // defensively: `worthCelebrating` already keeps a truly empty run from
  // opening this card at all.
  if (summary.durationSeconds > 0) {
    stats.push({ label: 'Duration', value: formatDuration(summary.durationSeconds) });
  }
  if (summary.avgPaceSecPerKm != null && summary.avgPaceSecPerKm > 0) {
    stats.push({ label: 'Avg Pace', value: paceFmt(summary.avgPaceSecPerKm) });
  }
  if (summary.elevationGainM != null && summary.elevationGainM > 0) {
    stats.push({ label: 'Elevation Gain', value: `${Math.round(summary.elevationGainM)} m` });
  }
  return stats;
}

/**
 * The one subjective number, kept apart from the measurements.
 *
 * Null when effort tracking is off, which is a real and common state rather
 * than an edge case — the switch exists and people use it. Returning a zero
 * here would put a confident number on the card for someone who never rated
 * anything, and it would sit in a row of measurements looking exactly like
 * one.
 */
export function feltFor(summary: Pick<SessionSummary, 'hardestRpe'>): Stat | null {
  if (summary.hardestRpe == null || summary.hardestRpe <= 0) return null;
  return { label: 'Hardest set', value: `RPE ${summary.hardestRpe}` };
}

/**
 * The line under the title.
 *
 * **No praise, and no judgement in either direction.** The house rule is no
 * shame-based messaging, and the mirror of that rule matters just as much: a
 * card that says "Great work!" after four sets is not encouragement, it is the
 * app not paying attention, and everyone can tell. So this states what
 * happened and lets the numbers speak.
 */
export function subtitleFor(summary: SessionSummary): string {
  if (summary.sport === 'bjj') {
    return summary.rounds ? `${summary.rounds} rounds logged` : 'Session logged';
  }
  if (summary.sport === 'running') {
    // Duration only, deliberately: this line has no unit system to draw on
    // (unlike the Distance tile below it, which is injected one), and
    // `formatDuration` needs none — seconds are seconds in either system.
    return `${formatDuration(summary.durationSeconds)} run`;
  }
  const e = summary.exercises;
  return `${summary.sets} ${summary.sets === 1 ? 'set' : 'sets'} across ${e} ${
    e === 1 ? 'exercise' : 'exercises'
  }`;
}

/**
 * Builds the summary from a finished session.
 *
 * `effortTracked` is passed in rather than read from the sets, and that
 * distinction is the whole point: a session where every RPE is empty looks
 * identical to one where the athlete turned effort tracking off, and only the
 * setting knows which. Inferring it from the data would show "How it felt" as
 * absent for someone who simply had a light day, and would show nothing at all
 * for someone who opted out — the same output for two different facts.
 */
/**
 * The running half of a finished session, as `summariseSession`'s fourth
 * argument wants it.
 *
 * Matches the fields of `running.SessionDetail` this card can actually use —
 * splits and per-point elevation/timestamps are not read here, the same way
 * this function never reads a strength session's per-set RIR. `route_points`
 * takes only `lat`/`lng`: the thumbnail draws a shape, not a pace-over-time
 * chart, so nothing else about a point matters to it.
 */
export type RunningSessionDetail = {
  distance_m: number | null;
  duration_seconds: number | null;
  avg_pace_sec_per_km: number | null;
  elevation_gain_m: number | null;
  route_points: { lat: number; lng: number }[];
};

export function summariseSession(
  session: {
    name: string;
    sport: string;
    started_at: string;
    ended_at: string | null;
    sets: {
      exercise_id: string;
      completed: boolean;
      reps: number | null;
      set_type: SetType;
      weight_kg: number | null;
      load_factor?: number | null;
    }[];
  },
  volume: { working_sets: number; total_reps: number; tonnage_kg: number; hardest_rpe: number },
  effortTracked: boolean,
  /**
   * The running module's own detail — passed only for a running session, and
   * ignored otherwise. Optional/nullable rather than required: a caller
   * building a strength summary (every caller today) has none to give, and a
   * running session read back before its detail synced legitimately has none
   * yet either.
   */
  runningDetail?: RunningSessionDetail | null,
): SessionSummary {
  const started = new Date(session.started_at).getTime();
  const ended = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
  const logged = session.sets.filter((x) => x.completed);
  const exerciseIDs = [...new Set(logged.map((x) => x.exercise_id))];

  if (session.sport === 'running') {
    const timestampDuration = Math.max(0, (ended - started) / 1000);
    return {
      title: session.name,
      sport: 'running',
      // Prefers the running module's own duration when there is a REAL one —
      // it can exclude paused time a plain start/end timestamp diff cannot,
      // per `running.SessionDetail.DurationSeconds`'s own doc — and falls
      // back to the timestamps otherwise, e.g. before the detail has synced.
      //
      // Deliberately NOT `runningDetail?.duration_seconds ?? timestampDuration`
      // — `??` only falls through on null/undefined, so a genuine
      // `duration_seconds: 0` (an imported entry with a broken clock, say)
      // would render as a confident zero-length run instead of falling back
      // to the timestamps, which is exactly the "confident zero" this file's
      // own header exists to prevent (see `feltFor`'s doc on null vs zero).
      durationSeconds:
        runningDetail?.duration_seconds && runningDetail.duration_seconds > 0
          ? runningDetail.duration_seconds
          : timestampDuration,
      // Counts whatever `session_sets` row the running module's own doc says
      // a client usually writes (a "run" exercise, for the generic PR
      // pipeline) — 0 or 1 in practice today, computed the same
      // sport-agnostic way the strength branch below counts its exercises.
      exercises: exerciseIDs.length,
      sets: 0,
      reps: 0,
      tonnageKg: 0,
      distanceM: runningDetail?.distance_m ?? undefined,
      avgPaceSecPerKm: runningDetail?.avg_pace_sec_per_km ?? undefined,
      elevationGainM: runningDetail?.elevation_gain_m ?? undefined,
      routePoints: downsampleRoute(runningDetail?.route_points ?? []),
      // Running carries no session-level RPE today — see `bjjSummaryFor` for
      // the mat's equivalent, which reads a real field this sport has none of.
      hardestRpe: null,
      records: [],
      recordExerciseIDs: exerciseIDs,
    };
  }

  /*
    `working_sets`, not the count of logged rows.

    The screen behind this card takes its Sets figure from `volume`, which
    excludes warmups — so counting rows here made the card say 12 while the
    header underneath said 9, about the same session, a tap apart. Which
    definition is right for a celebration is arguable; the two surfaces
    disagreeing is not.
  */
  return {
    title: session.name,
    sport: session.sport === 'bjj' ? 'bjj' : 'strength',
    durationSeconds: Math.max(0, (ended - started) / 1000),
    exercises: exerciseIDs.length,
    sets: volume.working_sets,
    reps: volume.total_reps,
    tonnageKg: volume.tonnage_kg,
    // See the field's own doc — `volume.tonnage_kg` (passed in, usually
    // `localVolume`'s result) already left an unresolved set's tonnage OUT
    // rather than guessing it, so this session's `sets` is what still knows
    // whether that happened.
    tonnageUnknown: hasUnresolvedLoad(logged),
    hardestRpe: effortTracked ? volume.hardest_rpe : null,
    records: [],
    recordExerciseIDs: exerciseIDs,
  };
}
