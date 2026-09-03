import {
  averagePaceSecPerKm,
  elevationGainMeters,
  splitsFromTrack,
  trackDistanceMeters,
  type RoutePoint,
  type SessionDetail as RunningDetail,
} from './running';

/**
 * `@kingstinct/react-native-healthkit`, imported the same defensive way
 * `lib/cameraModule.ts` imports `expo-camera` — read that file's doc comment
 * first, this one assumes it.
 *
 * ## Why this needs the same blast shield
 *
 * This package is built on Nitro Modules (`react-native-nitro-modules`),
 * which resolve their native binding at import time exactly the way
 * `requireNativeModule` does for `expo-camera` — a native/JS mismatch throws
 * from module scope, not from a call site. `apps/mobile`'s own history
 * (CLAUDE.md's "declared-but-not-installed native dependency" trap, N91/#432)
 * is precisely this failure landing on a real device: the package merged,
 * `pnpm install` ran, the JS bundled, and the native half was never linked in
 * because `pod install` had not re-run for it. In a Release build that is a
 * silent, instant termination with no red box — not a permission screen, not
 * an error, the app just closes. A HealthKit toggle nobody has turned on yet
 * must not be able to do that to every other screen in the app the moment
 * this file is merely imported.
 *
 * ## Why the native call surface stays this thin
 *
 * Everything past `load()` in this file is a plain, native-free mapping
 * from OUR OWN `HealthKitRunningWorkout` shape (a plain object: a uuid, two
 * dates, a duration, an optional distance, and a route) to
 * `running.SessionDetail`. That boundary is deliberate: `queryRunningWorkouts`
 * below is the only function that can touch the actual native module, and it
 * is therefore the only thing in this whole feature that device evidence has
 * to cover — `mapWorkoutToRunningDetail` and `filterNewWorkouts` are pure
 * functions over plain data and are unit tested in
 * `lib/__tests__/healthkit.test.ts` without a device or a mock of the native
 * module at all.
 */

/** Apple's own identifier for the running workout type — `WorkoutActivityType.running`
 *  in the package's generated enum (value 37, verified against
 *  `@kingstinct/react-native-healthkit@14.1.0`'s
 *  `lib/typescript/generated/healthkit.generated.d.ts`). A numeric literal
 *  rather than an imported enum member, so this file never imports a VALUE
 *  from the guarded package — only `load()`'s `require()` may touch it,
 *  which is what keeps the blast shield intact. */
const RUNNING_ACTIVITY_TYPE = 37;

/** How many past workouts one import pass asks for. Generous on purpose —
 *  this runs at most a few times a day (foreground/launch, see
 *  `lib/healthkitSync.ts`) and a runner's lifetime workout count is nowhere
 *  near this even after years on a watch; the real bound on cost is the
 *  dedup filter below, not this number.
 *
 *  Deliberately NOT a `since`/date-range query narrowing this further —
 *  `WorkoutQueryOptions.filter` (`FilterForWorkouts`) was not verified to
 *  carry a start-date predicate against this package's actual v14.1.0
 *  shipped types, and guessing at one is exactly the mistake that shipped
 *  `metersFromQuantity`'s unit bug (an assumption about a native shape,
 *  never checked against the real source, that a fully green test suite
 *  could not catch because the tests started from the same assumption).
 *  `queryRunningWorkouts`'s `alreadyImported` parameter already skips the
 *  expensive per-workout route fetch for anything previously imported,
 *  which is the actual cost this would be trying to save. */
const QUERY_LIMIT = 200;

/** A single point along an imported route, before it becomes a `RoutePoint`.
 *  Matches `WorkoutRouteLocation` from the package's types, narrowed to the
 *  fields this app uses. */
type NativeRouteLocation = {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number;
  readonly date: Date;
};

type NativeQuantity = { readonly unit: string; readonly quantity: number };

/** The subset of `WorkoutProxyTyped` this app reads. Narrowed the same way
 *  `cameraModule.ts`'s `CameraModule` type is: the stub only has to satisfy
 *  what is actually called. */
type NativeWorkout = {
  readonly uuid: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly duration: NativeQuantity;
  readonly totalDistance?: NativeQuantity;
  getWorkoutRoutes: () => Promise<
    readonly { readonly locations: readonly NativeRouteLocation[] }[]
  >;
};

/**
 * One raw quantity sample, as the package's `queryQuantitySamples` returns
 * it — narrowed to the fields this app reads (N477/#822). `sourceRevision`
 * carries what wrote it, which is the only signal this app has for guessing
 * which `biometric.Source` a reading belongs to (see `classifyHealthKitSource`
 * in `lib/biometric.ts`) — HealthKit exposes no vendor enum, only the
 * free-text name and bundle id the writer chose for itself.
 */
type NativeQuantitySample = {
  readonly uuid: string;
  readonly quantity: number;
  readonly unit: string;
  readonly startDate: Date;
  readonly sourceRevision: { readonly source: { readonly name: string; readonly bundleIdentifier: string } };
};

type HealthKitModule = {
  isHealthDataAvailable: () => boolean;
  requestAuthorization: (toRequest: { toRead: readonly string[] }) => Promise<boolean>;
  queryWorkoutSamples: (options: {
    filter?: { workoutActivityType?: number };
    limit: number;
    ascending?: boolean;
  }) => Promise<readonly NativeWorkout[]>;
  queryQuantitySamples: (
    identifier: string,
    options: {
      filter?: { date?: { startDate?: Date; endDate?: Date } };
      limit: number;
      ascending?: boolean;
      unit?: string;
    },
  ) => Promise<readonly NativeQuantitySample[]>;
};

function load(): HealthKitModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@kingstinct/react-native-healthkit') as HealthKitModule;
  } catch {
    // Deliberately swallowed — see cameraModule.ts's doc comment on the same
    // line. The caller (lib/healthkitSync.ts) reads `isHealthKitSupported()`
    // and renders/no-ops accordingly; nothing here can safely log without
    // risking the same class of crash it exists to avoid.
    return null;
  }
}

const hk = load();

/** Every read type this feature needs — workouts and their GPS routes
 *  (N465), plus heart rate and VO₂max (N477/#822). All four are asked for in
 *  ONE `requestAuthorization` call: HealthKit shows a per-type consent
 *  screen regardless, and asking for everything this app will ever read up
 *  front means a returning athlete who granted heart rate later never has to
 *  see a second prompt when VO₂max reading shipped after it.
 *  `HKWorkoutTypeIdentifier` / `HKWorkoutRouteTypeIdentifier` /
 *  `HKQuantityTypeIdentifierHeartRate` / `HKQuantityTypeIdentifierVO2Max`
 *  spelled as literals for the same reason `RUNNING_ACTIVITY_TYPE` is: no
 *  value import from the guarded package outside `load()`. */
const READ_TYPES = [
  'HKWorkoutTypeIdentifier',
  'HKWorkoutRouteTypeIdentifier',
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierVO2Max',
] as const;

/** Whether this binary has a working HealthKit module linked in. `false` on
 *  Android unconditionally (the package is iOS-only; `load()` throws there
 *  too, so this collapses to the same guarded path) and on any iOS build
 *  where the native half was not linked — see this file's doc comment. */
export function isHealthKitSupported(): boolean {
  return hk != null && hk.isHealthDataAvailable();
}

/**
 * Ask for READ-ONLY access to workouts and their routes.
 *
 * Never requests `toShare` — this feature only imports, per the ticket's
 * explicit scope, and `NSHealthUpdateUsageDescription: false` in `app.json`'s
 * plugin config means the write permission string is not even declared, so
 * there is nothing to ask for even if this changed by accident.
 *
 * Safe to call on every import pass, not only the first: HealthKit answers
 * from cache once the athlete has responded to the system prompt once, and
 * does not re-prompt — `requestAuthorization` resolving is not evidence
 * access was GRANTED, only that the athlete has been asked (or already was).
 * HealthKit deliberately never tells an app whether read access was denied,
 * so a query that comes back empty is indistinguishable from "no runs" —
 * `lib/healthkitSync.ts` treats both the same way rather than guessing.
 */
export async function requestHealthKitReadAuthorization(): Promise<boolean> {
  if (!hk) return false;
  return hk.requestAuthorization({ toRead: READ_TYPES });
}

/** One HealthKit-recorded run, reduced to plain data — the boundary
 *  `mapWorkoutToRunningDetail` and `filterNewWorkouts` are tested against. */
export type HealthKitRunningWorkout = {
  uuid: string;
  /** RFC3339 */
  startDate: string;
  /** RFC3339 */
  endDate: string;
  durationSeconds: number;
  /** Meters, or null when HealthKit reports no total and there is no route
   *  to derive one from either. */
  distanceMeters: number | null;
  /** Empty when this workout has no recorded route — common for one logged
   *  by hand in the Health app rather than tracked live. */
  route: RoutePoint[];
};

/**
 * Convert a HealthKit `Quantity` to metres, or `null` when the unit is not
 * one this function knows how to convert.
 *
 * **`'meters'` is the primary case, not `'m'`.** `@kingstinct/react-native-healthkit`
 * (v14.1.0) always reports `totalDistance` in the string `HKUnit.meter().unitString`
 * produces — verified directly against the installed package's own Swift
 * source, `ios/WorkoutProxy.swift`'s `totalDistance` getter: `Quantity(unit:
 * "meters", quantity: hkTotalDistance.doubleValue(for: HKUnit.meter()))`. The
 * value is ALWAYS already in metres regardless of the sample's original
 * unit — HealthKit converts before this ever reaches JS — so `'km'`/`'mi'`
 * below are defensive only, kept in case a future SDK version reports
 * differently, and are not exercised by the real package today.
 *
 * Exported so a test can pin the real unit string against this function
 * directly, rather than only against the already-converted
 * `HealthKitRunningWorkout` shape `queryRunningWorkouts` produces — a stub
 * built from an assumption about the unit string cannot catch a wrong
 * assumption about the unit string, which is exactly how a distance-always-
 * null bug shipped with a fully green suite the first time this was written.
 */
export function metersFromQuantity(q: NativeQuantity | undefined): number | null {
  if (!q || !Number.isFinite(q.quantity)) return null;
  switch (q.unit) {
    case 'meters':
    case 'm':
      return q.quantity;
    case 'km':
      return q.quantity * 1000;
    case 'mi':
      return q.quantity * 1609.344;
    default:
      // An unrecognised unit is a reason to fall back to the route-derived
      // distance below, not a reason to guess at a conversion factor and
      // silently report a wrong number as a confident one.
      return null;
  }
}

/**
 * Read this device's running workouts from HealthKit, newest first, reduced
 * to plain `HealthKitRunningWorkout` objects.
 *
 * **This is the one function in this file device evidence has to cover** —
 * everything downstream of it (`filterNewWorkouts`, `mapWorkoutToRunningDetail`)
 * is pure and already unit tested. Returns `[]`, never throws, when this
 * binary has no HealthKit module or the athlete has not authorized read
 * access — both read as "nothing to import" to the caller, which is the
 * correct behaviour for a feature that is opt-in and silently does nothing
 * when its permission is missing rather than erroring the whole sync pass.
 *
 * `alreadyImported` skips the per-workout `getWorkoutRoutes()` call for
 * anything this device has already brought in — that call is a SECOND
 * native round trip per workout, and fetching it for a workout about to be
 * thrown away by `filterNewWorkouts` anyway is real, avoidable cost on every
 * foreground return for an athlete with years of watch history. Optional and
 * defaulting to empty rather than required, so a caller that genuinely wants
 * every route (there is none today, but a future one might) is not forced
 * to invent an empty ledger to ask for it.
 */
export async function queryRunningWorkouts(
  alreadyImported: ReadonlySet<string> | readonly string[] = [],
): Promise<HealthKitRunningWorkout[]> {
  if (!hk) return [];
  const seen = alreadyImported instanceof Set ? alreadyImported : new Set(alreadyImported);
  let workouts: readonly NativeWorkout[];
  try {
    workouts = await hk.queryWorkoutSamples({
      filter: { workoutActivityType: RUNNING_ACTIVITY_TYPE },
      limit: QUERY_LIMIT,
      ascending: false,
    });
  } catch {
    // Denied authorization, an unavailable store, or any other native
    // failure — all read as "nothing to import right now", the same
    // no-op posture as `isHealthKitSupported()` returning false.
    return [];
  }

  const out: HealthKitRunningWorkout[] = [];
  for (const w of workouts) {
    if (seen.has(w.uuid)) continue;
    let route: RoutePoint[] = [];
    try {
      const routes = await w.getWorkoutRoutes();
      const points: { lat: number; lng: number; elevation_m: number | null; recorded_at: string }[] =
        [];
      for (const r of routes) {
        for (const loc of r.locations) {
          points.push({
            lat: loc.latitude,
            lng: loc.longitude,
            elevation_m: Number.isFinite(loc.altitude) ? loc.altitude : null,
            recorded_at: loc.date.toISOString(),
          });
        }
      }
      // Chronological — a workout can carry more than one WorkoutRoute
      // segment, and nothing guarantees they arrive in order relative to
      // each other even though each segment's own locations do.
      points.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
      route = points;
    } catch {
      // No route access, or this workout genuinely has none (hand-logged in
      // the Health app). Either way, a distance-only import is still a real
      // run worth having — route stays empty rather than failing the whole
      // workout.
    }

    const durationSeconds =
      w.duration.unit === 's'
        ? Math.round(w.duration.quantity)
        : Math.max(0, Math.round((w.endDate.getTime() - w.startDate.getTime()) / 1000));

    out.push({
      uuid: w.uuid,
      startDate: w.startDate.toISOString(),
      endDate: w.endDate.toISOString(),
      durationSeconds,
      // HealthKit's own total is preferred over a route-derived one when
      // present — often sourced from the watch's own GPS/accelerometer
      // fusion, which is ordinarily better than reconstructing distance
      // from however densely this app's route query returned points.
      distanceMeters: metersFromQuantity(w.totalDistance) ?? (route.length >= 2 ? trackDistanceMeters(route) : null),
      route,
    });
  }
  return out;
}

/**
 * Workouts this device has not already imported, in the order given.
 *
 * Pure and device-free: `alreadyImported` is whatever the caller already
 * knows (the local ledger in `lib/healthkitSync.ts`, ordinarily), so this
 * function needs no SQLite and no native call to be exercised — see
 * `lib/__tests__/healthkit.test.ts`.
 */
export function filterNewWorkouts(
  workouts: readonly HealthKitRunningWorkout[],
  alreadyImported: ReadonlySet<string> | readonly string[],
): HealthKitRunningWorkout[] {
  const seen = alreadyImported instanceof Set ? alreadyImported : new Set(alreadyImported);
  return workouts.filter((w) => !seen.has(w.uuid));
}

/**
 * A HealthKit workout, mapped to this module's own `SessionDetail` shape.
 *
 * Pure: no SQLite, no native call, no network — the mapping this ticket
 * asked to be tested is exactly this function, given a plain
 * `HealthKitRunningWorkout` (which is itself what `queryRunningWorkouts`
 * boundary-converts native data into, above).
 */
export function mapWorkoutToRunningDetail(
  workout: HealthKitRunningWorkout,
  sessionID: string,
): RunningDetail {
  const hasRoute = workout.route.length >= 2;
  return {
    session_id: sessionID,
    route_points: workout.route,
    splits: hasRoute ? splitsFromTrack(workout.route) : [],
    // HealthKit's WorkoutTotals carries distance and energy, never
    // elevation — see running.ts's SessionDetail doc for why this is always
    // derived from the track rather than trusted from a source that does
    // not report it.
    elevation_gain_m: hasRoute ? elevationGainMeters(workout.route) || null : null,
    avg_pace_sec_per_km:
      workout.distanceMeters != null
        ? averagePaceSecPerKm(workout.distanceMeters, workout.durationSeconds)
        : null,
    distance_m: workout.distanceMeters,
    duration_seconds: workout.durationSeconds,
    source: 'healthkit',
    healthkit_uuid: workout.uuid,
  };
}

/**
 * -----------------------------------------------------------------------
 * N477/#822 — heart rate and VO₂max
 * -----------------------------------------------------------------------
 *
 * Everything below follows the same split as the running import above: the
 * two `query*` functions are the ONLY code in this file (or this feature)
 * that touches the native module, and everything downstream of them —
 * `lib/biometric.ts`'s mapping and window/plan logic — is pure and
 * platform-agnostic, so the Android sibling ticket (Health Connect, #823)
 * can hand `lib/biometric.ts` the SAME shape without importing anything
 * from this file. See that file's own doc comment for the split's other
 * half.
 */

/** One quantity sample, reduced to plain data at the native boundary —
 *  the shape `lib/biometric.ts`'s pure mapping functions take. */
export type HealthKitQuantitySample = {
  uuid: string;
  value: number;
  /** Whatever unit string the native query was asked to report in. */
  unit: string;
  /** RFC3339. */
  measuredAt: string;
  sourceName: string;
  sourceBundleId: string;
};

/** How many samples one window/backfill query asks for. Generous, on the
 *  same reasoning as `QUERY_LIMIT` above — the real ceiling is the caller's
 *  own bounding (a session's window, or a last-synced watermark), not this
 *  number. Continuous per-second heart rate during an active Watch workout
 *  (design doc §2) is the densest realistic case: a two-hour session is on
 *  the order of a couple thousand samples, comfortably under this. */
const QUANTITY_QUERY_LIMIT = 20000;

function toHealthKitQuantitySample(s: NativeQuantitySample): HealthKitQuantitySample {
  return {
    uuid: s.uuid,
    value: s.quantity,
    unit: s.unit,
    measuredAt: s.startDate.toISOString(),
    sourceName: s.sourceRevision.source.name,
    sourceBundleId: s.sourceRevision.source.bundleIdentifier,
  };
}

/**
 * Read heart-rate samples HealthKit recorded within `[startDate, endDate]`
 * — the design doc's §2 "window read", and the DEFAULT join, not a
 * fallback: `predicateForObjects(from: workout)` returns only samples a
 * writer explicitly associated with its own workout object, and Whoop and
 * Garmin both write workouts without correctly attaching the underlying
 * heart rate (design doc §2). Querying the window directly is what still
 * finds those athletes' data.
 *
 * `count/min` is requested explicitly rather than left to the identifier's
 * default (`count/s`, per this package's own `QuantityUnitByIdentifierMap`
 * — verified against the installed v14.1.0 types) — BPM is what the zone
 * math in `backend/internal/modules/biometric/trimp.go` and every athlete-
 * facing number in this app already assumes, and converting a `count/s`
 * reading by ×60 in JS would be a second unit conversion this app has to
 * keep in sync with the native package's default, for no benefit over
 * asking the query for the unit already wanted.
 *
 * Returns `[]`, never throws, on any native failure — denied authorization,
 * no HealthKit module, or a genuinely empty store (indistinguishable from
 * denial per §5.1) all read as "no heart-rate evidence for this session",
 * which is exactly the honest `hr_source: 'none'` state
 * `lib/biometric.ts`'s `planHRSync` derives from an empty array.
 */
export async function queryHeartRateSamples(
  startDate: Date,
  endDate: Date,
): Promise<HealthKitQuantitySample[]> {
  if (!hk) return [];
  try {
    const samples = await hk.queryQuantitySamples('HKQuantityTypeIdentifierHeartRate', {
      filter: { date: { startDate, endDate } },
      limit: QUANTITY_QUERY_LIMIT,
      ascending: true,
      unit: 'count/min',
    });
    return samples.map(toHealthKitQuantitySample);
  } catch {
    return [];
  }
}

/**
 * Read VO₂max samples recorded SINCE `sinceDate`, ascending.
 *
 * Unlike heart rate, this is never windowed to a session — design doc §3:
 * "VO₂max is read, never computed... show it as a trend on the athlete's
 * profile; do not attach it to a session." `lib/biometricSync.ts` calls
 * this with a high-water mark (the latest previously-synced reading, or a
 * bounded first-run backfill) on every foreground pass, the same
 * "foreground/launch, not background delivery" posture `lib/healthkitSync.ts`
 * takes for runs and for the identical reasoning — see that file's doc
 * comment.
 *
 * `ml/(kg*min)` is this identifier's own native unit (verified against the
 * installed package's `QuantityUnitByIdentifierMap`) and is requested
 * explicitly rather than left to a default, for the same "ask for the unit
 * actually wanted" reasoning as `queryHeartRateSamples`.
 */
export async function queryVO2MaxSamples(sinceDate: Date): Promise<HealthKitQuantitySample[]> {
  if (!hk) return [];
  try {
    const samples = await hk.queryQuantitySamples('HKQuantityTypeIdentifierVO2Max', {
      filter: { date: { startDate: sinceDate } },
      limit: QUANTITY_QUERY_LIMIT,
      ascending: true,
      unit: 'ml/(kg*min)',
    });
    return samples.map(toHealthKitQuantitySample);
  } catch {
    return [];
  }
}
