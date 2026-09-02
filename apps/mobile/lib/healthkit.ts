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
 *  dedup filter below, not this number. */
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

type HealthKitModule = {
  isHealthDataAvailable: () => boolean;
  requestAuthorization: (toRequest: { toRead: readonly string[] }) => Promise<boolean>;
  queryWorkoutSamples: (options: {
    filter?: { workoutActivityType?: number };
    limit: number;
    ascending?: boolean;
  }) => Promise<readonly NativeWorkout[]>;
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

/** Both read types this feature needs: the workouts themselves, and their
 *  GPS routes — HealthKit authorizes these separately even though they are
 *  read together here. `HKWorkoutTypeIdentifier` / `HKWorkoutRouteTypeIdentifier`
 *  spelled as literals for the same reason `RUNNING_ACTIVITY_TYPE` is: no
 *  value import from the guarded package outside `load()`. */
const READ_TYPES = ['HKWorkoutTypeIdentifier', 'HKWorkoutRouteTypeIdentifier'] as const;

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

function metersFromQuantity(q: NativeQuantity | undefined): number | null {
  if (!q) return null;
  switch (q.unit) {
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
 */
export async function queryRunningWorkouts(): Promise<HealthKitRunningWorkout[]> {
  if (!hk) return [];
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
