import { Platform } from 'react-native';

import { heartRateSamplesInWindow, type BiometricSource, type RawHeartRateSample } from './biometric';
import { stepsFromHealthConnect, type StepsOutcome } from './steps';

/**
 * `react-native-health-connect`, imported the same defensive way
 * `lib/healthkit.ts` imports `@kingstinct/react-native-healthkit` — read
 * that file's doc comment first, this one assumes it.
 *
 * ## Why this needs the same blast shield
 *
 * Verified directly against the installed package (v4.1.3)'s
 * `src/index.tsx` and `src/NativeHealthConnect.ts`: on the new architecture
 * (this app's default — see `react-native-nitro-modules` elsewhere in
 * `package.json`) the module does
 * `TurboModuleRegistry.getEnforcing<Spec>('HealthConnect')` at MODULE SCOPE,
 * inside the same `Platform.select` that runs the moment `index.tsx` is
 * evaluated — `getEnforcing` throws immediately if the native side isn't
 * linked in. That is exactly the `apps/mobile`'s "declared-but-not-installed
 * native dependency" hazard (CLAUDE.md, N91/#432): a native/JS mismatch
 * throwing from module scope rather than from a call site, fatal with no red
 * box in a Release build. Android is a brand-new build target for this app
 * (N475) and this is its first new native dependency since that baseline —
 * exactly the situation that trap is written for.
 *
 * ## Why the native call surface stays this thin
 *
 * `lib/biometric.ts` holds every pure decision (the window clip, the
 * history-wall check, the HRmax estimate, the retry ledger logic) and
 * imports nothing from this file's guarded module. This file's only job is
 * turning a Health Connect record into plain data and back — `load()`,
 * `ensureInitialized()` and the two `query*` functions below are the entire
 * surface that touches the actual native module, and therefore the only
 * things device evidence has to cover.
 */

/** One `HeartRateRecord` reduced to what this app reads. Field names match
 *  `react-native-health-connect`'s own `HeartRateRecord`/`HeartRateSample`
 *  types (v4.1.3, `src/types/records.types.ts`/`base.types.ts`). */
type NativeHeartRateRecord = {
  readonly metadata?: { readonly id?: string; readonly dataOrigin?: string };
  readonly startTime: string;
  readonly endTime: string;
  readonly samples: readonly { readonly time: string; readonly beatsPerMinute: number }[];
};

/** One `Vo2MaxRecord` reduced to what this app reads. */
type NativeVo2MaxRecord = {
  readonly metadata?: { readonly id?: string; readonly dataOrigin?: string };
  readonly time: string;
  readonly vo2MillilitersPerMinuteKilogram: number;
};

/** One `ExerciseSessionRecord` reduced to what this app reads (N479/#824).
 *  Field names match `react-native-health-connect`'s own type (v4.1.3,
 *  `src/types/records.types.ts`) — `exerciseType` is a plain number keyed
 *  against that package's `ExerciseType` constant, per its own doc comment. */
type NativeExerciseSessionRecord = {
  readonly metadata?: { readonly id?: string; readonly dataOrigin?: string };
  readonly startTime: string;
  readonly endTime: string;
  readonly exerciseType: number;
};

type ReadRecordsOptions = {
  timeRangeFilter: { operator: 'between'; startTime: string; endTime: string };
  /** Verified present on the package's own `ReadRecordsOptions` (v4.1.3). */
  pageSize?: number;
};

type Permission = { accessType: 'read' | 'write'; recordType: string };

type HealthConnectModule = {
  getSdkStatus: (providerPackageName?: string) => Promise<number>;
  initialize: (providerPackageName?: string) => Promise<boolean>;
  requestPermission: (permissions: Permission[]) => Promise<Permission[]>;
  /** Narrowed to `unknown` records — each call site below casts to the
   *  specific shape it asked for by `recordType`, rather than this type
   *  trying to encode the real package's generic/overloaded signature. */
  readRecords: (
    recordType: 'HeartRate' | 'Vo2Max' | 'ExerciseSession' | 'Steps',
    options: ReadRecordsOptions,
  ) => Promise<{ records: unknown[] }>;
  /** N569. `aggregateRecord` for `Steps` resolves `{ COUNT_TOTAL }`, and an
   *  empty window resolves `COUNT_TOTAL: 0` rather than rejecting — verified
   *  against `ReactStepsRecord.kt`'s `parseAggregationResult` (`?: 0.0`). It
   *  rejects through the same `rejectWithException` as `readRecords`, so a
   *  refusal arrives as `PERMISSION_ERROR` here too. */
  aggregateRecord: (request: {
    recordType: 'Steps';
    timeRangeFilter: ReadRecordsOptions['timeRangeFilter'];
  }) => Promise<{ COUNT_TOTAL?: number | null }>;
  /** N527. Synchronous and void in v4.1.3 — see `openHealthConnectSettingsScreen`. */
  openHealthConnectSettings: () => void;
};

/** `SdkAvailabilityStatus.SDK_AVAILABLE` — a numeric literal for the same
 *  reason `lib/healthkit.ts`'s `RUNNING_ACTIVITY_TYPE` is one: no VALUE
 *  import from the guarded package outside `load()`. Verified against the
 *  installed package's `src/constants.ts`. */
const SDK_AVAILABLE = 3;

function load(): HealthConnectModule | null {
  if (Platform.OS !== 'android') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-health-connect') as unknown as HealthConnectModule;
  } catch {
    // Deliberately swallowed — see this file's doc comment and
    // healthkit.ts's identical stance. The caller
    // (`lib/healthConnectSync.ts`) reads `isHealthConnectSupported()` and
    // no-ops accordingly; nothing here can safely log without risking the
    // same class of crash it exists to avoid.
    return null;
  }
}

const hc = load();

/** The record types this feature reads. Literals, not an imported
 *  `RecordType` value, for the same reason as `SDK_AVAILABLE`.
 *
 * `ExerciseSession` joined N477/#822's original two for N479/#824 — same
 * "ask for everything up front" reasoning `healthkit.ts`'s `READ_TYPES` doc
 * comment gives: Health Connect shows one consent screen regardless, so an
 * athlete who already granted heart rate never sees a second prompt when
 * walk/hike detection shipped after it. */
const READ_RECORD_TYPES = ['HeartRate', 'Vo2Max', 'ExerciseSession', 'Steps'] as const;

export type HealthConnectRecordType = (typeof READ_RECORD_TYPES)[number];

/**
 * N569/#1130 — `Steps` is in `READ_RECORD_TYPES`, because every type this app
 * reads is (and `check:health-permissions-parity` holds the manifest to that
 * list), but it is NOT asked for by a sync pass until the athlete has asked for
 * it. Same reason as `lib/healthkit.ts`'s `STEPS_READ_TYPE`: a pass re-requests
 * access on every foreground return, and a new type in that request opens the
 * Health Connect permission screen with nothing on screen saying why.
 *
 * Pure and exported because it is the guard: `includeSteps: false` must never
 * contain `Steps`.
 */
export function healthConnectReadRecordTypes(includeSteps: boolean): readonly HealthConnectRecordType[] {
  return includeSteps ? READ_RECORD_TYPES : READ_RECORD_TYPES.filter((t) => t !== 'Steps');
}

/**
 * W15/#944 — a read that Health Connect REFUSED, as opposed to one that
 * found nothing.
 *
 * The three `query*` functions below used to catch everything and return
 * `[]`, and on Android that made a missing manifest permission — the
 * `ExerciseSession` read was requested by `READ_RECORD_TYPES` while
 * `READ_EXERCISE` was never declared in `app.config.js` — indistinguishable
 * from an athlete who simply has no walks recorded. The feature was dead,
 * Settings said it worked, and every layer above agreed there was nothing
 * to show. That is the trap: a swallow that turns "not allowed" into "not
 * there" cannot be caught by any test, because the tests can only ever see
 * the empty array it produced.
 *
 * So a permission failure is now the ONE thing these reads throw. Every
 * other failure keeps the old "return `[]`, never throw" posture — see the
 * reasoning on `queryHeartRateSamples` — because a transient IO error and an
 * empty window really are the same to the caller: try again next pass.
 * A refused permission is not; it stays refused until somebody changes the
 * manifest or the athlete changes the grant, and the caller needs to know
 * which of those it is looking at.
 *
 * **iOS does not get an equivalent, and that is HealthKit's design, not an
 * omission here.** HealthKit deliberately returns an empty result for a
 * read the athlete denied — Apple treats "which data types you refused" as
 * itself private — so `healthkit.ts`'s identical `catch { return [] }` is
 * the correct and only possible posture there. Health Connect does say no
 * out loud, and this class is what carries that answer up.
 */
export class HealthConnectPermissionError extends Error {
  readonly recordType: HealthConnectRecordType;
  constructor(recordType: HealthConnectRecordType) {
    super(`Health Connect refused to read ${recordType}: permission not granted`);
    this.name = 'HealthConnectPermissionError';
    this.recordType = recordType;
  }
}

/**
 * `react-native-health-connect`'s own code for a native `SecurityException`
 * — verified against the installed package's
 * `android/.../utils/ExceptionsUtils.kt`, where `rejectWithException` maps
 * `is SecurityException -> "PERMISSION_ERROR"` and rejects the bridge
 * promise with that as the error's `code`. `readRecords` in the package's
 * TypeScript returns the native promise directly (no wrapping — its
 * `HealthConnectError` class is only thrown for `insertRecords` argument
 * validation), so this is exactly the shape that reaches the `catch`
 * blocks below. A vendor-defined code, matched exactly, rather than a
 * substring of a human-readable message that a package update could
 * reword.
 */
const PERMISSION_ERROR_CODE = 'PERMISSION_ERROR';

/**
 * Is this rejection Health Connect saying "not permitted"? Pure and exported
 * so the classification is testable without a device — the native surface
 * itself is not (see the file comment), but the decision about what its
 * errors MEAN can be pinned exactly.
 */
export function isHealthConnectPermissionError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === PERMISSION_ERROR_CODE
  );
}

/** The one exception to "return `[]`, never throw" — see `HealthConnectPermissionError`. */
function rethrowIfNotPermitted(err: unknown, recordType: HealthConnectRecordType): void {
  if (isHealthConnectPermissionError(err)) throw new HealthConnectPermissionError(recordType);
}

let sdkChecked = false;
let sdkAvailable = false;
let initialized = false;

/**
 * Whether this binary has a working Health Connect module linked in AND the
 * Health Connect app/provider itself is actually available on this device —
 * `false` unconditionally on iOS (the package is Android-only; `load()`
 * returns `null` there too, so this collapses to the same guarded path),
 * and `false` on an Android device that has no Health Connect provider
 * installed (pre-14 devices without the standalone app, mainly).
 *
 * Caches its answer for the process lifetime, same reasoning as
 * `healthkit.ts`'s `isHealthKitSupported`: a native module is either linked
 * into this binary or it is not, and the SDK's own availability does not
 * change while the process is alive either.
 */
export async function isHealthConnectSupported(): Promise<boolean> {
  if (!hc) return false;
  if (sdkChecked) return sdkAvailable;
  try {
    const status = await hc.getSdkStatus();
    sdkAvailable = status === SDK_AVAILABLE;
  } catch {
    sdkAvailable = false;
  }
  sdkChecked = true;
  return sdkAvailable;
}

async function ensureInitialized(): Promise<boolean> {
  if (!(await isHealthConnectSupported())) return false;
  if (initialized) return true;
  try {
    initialized = await hc!.initialize();
  } catch {
    initialized = false;
  }
  return initialized;
}

/**
 * Ask for READ-ONLY access to heart rate and VO2max.
 *
 * Never requests `write` — matches `healthkit.ts`'s stance and this
 * ticket's explicit scope. Safe to call on every sync pass, not only the
 * first: Health Connect answers from its own stored grant once the athlete
 * has responded to the system dialog once.
 *
 * **Its boolean is deliberately NOT how a refused grant is detected**, and
 * `lib/healthConnectSync.ts` discards it on purpose (W15/#944). A grant can
 * be revoked in the Health Connect app between this call and the read, and
 * a permission absent from the MANIFEST — the actual bug — is refused at
 * read time regardless of what this returned. The read site is the ground
 * truth, and `HealthConnectPermissionError` is how it reports.
 */
export async function requestHealthConnectReadAuthorization(
  options: { includeSteps?: boolean } = {},
): Promise<boolean> {
  if (!(await ensureInitialized())) return false;
  const types = healthConnectReadRecordTypes(options.includeSteps ?? false);
  try {
    const granted = await hc!.requestPermission(
      types.map((recordType) => ({ accessType: 'read' as const, recordType })),
    );
    return types.every((rt) => granted.some((g) => g.recordType === rt && g.accessType === 'read'));
  } catch {
    return false;
  }
}

/**
 * N569/#1130 — the deliberate ask, from the "Allow steps" action only. Returns
 * whether `Steps` was granted, which the UI does not rely on either: the next
 * read is the ground truth, for the reasons `requestHealthConnectReadAuthorization`
 * gives.
 */
export async function requestHealthConnectStepsAuthorization(): Promise<boolean> {
  if (!(await ensureInitialized())) return false;
  try {
    const granted = await hc!.requestPermission(
      READ_RECORD_TYPES.map((recordType) => ({ accessType: 'read' as const, recordType })),
    );
    return granted.some((g) => g.recordType === 'Steps' && g.accessType === 'read');
  } catch {
    return false;
  }
}

/**
 * N527/#949 — open Health Connect, so an athlete whose grant was refused can
 * allow it. Returns whether the call was made; never throws.
 *
 * **It opens Health Connect's settings home, not VOLA's own permission page,
 * because that is all the installed package can open.** Verified against
 * `react-native-health-connect` v4.1.3's `HealthConnectManager.kt`:
 * `openHealthConnectSettings` starts
 * `Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)`, and the only
 * other screen it exposes, `openHealthConnectDataManagement`, is data
 * management rather than permissions. So the Settings copy names the path
 * inside it — App permissions, then VOLA.
 *
 * **Why not `requestPermission` ("Ask again") instead**, the way N569's Steps
 * row does: every foreground pass already calls it with exactly the toggle's
 * types (`requestHealthConnectReadAuthorization`). A type still refused after
 * that is one Health Connect is no longer asking about, and a button making
 * the same call again would do nothing visible.
 */
export function openHealthConnectSettingsScreen(): boolean {
  if (!hc) return false;
  try {
    hc.openHealthConnectSettings();
    return true;
  } catch {
    return false;
  }
}

/**
 * Today's step count from Health Connect — N569/#1130.
 *
 * An AGGREGATE, not a sum of `readRecords`: a phone and a watch app often both
 * write steps for the same minutes, and Health Connect's aggregate is what
 * de-duplicates them by the athlete's data-source priority, the same number the
 * Health Connect app shows. Summing records would double-count.
 *
 * - A refused grant throws `HealthConnectPermissionError('Steps')` (W15/#944),
 *   the same posture as every read in this file.
 * - **Any other failure also throws**, unlike the `query*` functions above: an
 *   empty list is harmless to their callers, a swallowed failure here would be a
 *   step count. `lib/steps.ts`'s `runStepsRead` catches and records nothing.
 * - `COUNT_TOTAL: 0` is resolved by `stepsFromHealthConnect`: a zero only when
 *   some app has recorded a `Steps` record in the lookback, `no_data` otherwise.
 */
export async function queryHealthConnectSteps(window: {
  dayStart: Date;
  lookbackStart: Date;
  now: Date;
}): Promise<StepsOutcome> {
  if (!(await ensureInitialized())) throw new Error('Health Connect is not available');
  try {
    const total = (
      await hc!.aggregateRecord({
        recordType: 'Steps',
        timeRangeFilter: {
          operator: 'between',
          startTime: window.dayStart.toISOString(),
          endTime: window.now.toISOString(),
        },
      })
    ).COUNT_TOTAL;
    if (total != null && Number.isFinite(total) && total > 0) return stepsFromHealthConnect(total, true);
    const recent = await hc!.readRecords('Steps', {
      timeRangeFilter: {
        operator: 'between',
        startTime: window.lookbackStart.toISOString(),
        endTime: window.now.toISOString(),
      },
      pageSize: 1,
    });
    return stepsFromHealthConnect(total, recent.records.length > 0);
  } catch (err) {
    rethrowIfNotPermitted(err, 'Steps');
    throw err;
  }
}

/** A heart-rate reading with enough provenance to derive a stable sample id
 *  and a `biometric.Source` from. */
export type HeartRateReading = RawHeartRateSample & {
  /** `hc:<record metadata.id>:<sample time>` — see `heartRateSampleID`. */
  id: string;
  /** The record's own `dataOrigin` (a package name), for
   *  `sourceFromDataOrigin` to classify — see `healthConnectSync.ts`. */
  dataOrigin: string | null;
};

/** Deterministic id for one heart-rate reading inside a record — stable
 *  across repeated reads of the same record, which is what makes a retried
 *  upload idempotent (`biometric.Sample.ID`'s own doc comment) without this
 *  app maintaining any ledger of individual sample ids itself. Bounded well
 *  under the backend's 128-character `maxSampleIDLength`. */
export function heartRateSampleID(recordID: string, sampleTimeISO: string): string {
  return `hc:hr:${recordID}:${sampleTimeISO}`;
}

/** Deterministic id for one VO2max reading — the record itself IS the
 *  sample (an `InstantaneousRecord`), so no per-sample suffix is needed. */
export function vo2MaxSampleID(recordID: string): string {
  return `hc:vo2:${recordID}`;
}

/**
 * Read heart-rate samples whose record overlaps `[windowStart, windowEnd]`,
 * clipped to exactly that window (`heartRateSamplesInWindow`), for the §2
 * window join.
 *
 * Returns `[]`, never throws, when this binary has no Health Connect module,
 * the SDK is unavailable, or the query itself fails (denied permission, a
 * window past the history wall the caller forgot to check, or any other
 * native failure) — the same "nothing to import right now" posture
 * `healthkit.ts`'s `queryRunningWorkouts` takes. Callers MUST apply
 * `biometric.ts`'s `isWithinHealthConnectHistoryWall` themselves
 * before calling this for an old session — this function does not check it,
 * so a caller that skips that guard gets a swallowed native error rather
 * than the honest "the platform wall stopped this" this ticket exists to
 * make legible.
 */
export async function queryHeartRateSamples(
  windowStart: string,
  windowEnd: string,
): Promise<HeartRateReading[]> {
  if (!(await ensureInitialized())) return [];
  let records: NativeHeartRateRecord[];
  try {
    const result = await hc!.readRecords('HeartRate', {
      timeRangeFilter: { operator: 'between', startTime: windowStart, endTime: windowEnd },
    });
    records = result.records as NativeHeartRateRecord[];
  } catch (err) {
    rethrowIfNotPermitted(err, 'HeartRate');
    return [];
  }

  const out: HeartRateReading[] = [];
  for (const record of records) {
    const recordID = record.metadata?.id;
    if (!recordID) continue; // no id, no way to derive a stable sample id — skip rather than guess
    const clipped = heartRateSamplesInWindow(record.samples, windowStart, windowEnd);
    for (const sample of clipped) {
      out.push({
        time: sample.time,
        beatsPerMinute: sample.beatsPerMinute,
        id: heartRateSampleID(recordID, sample.time),
        dataOrigin: record.metadata?.dataOrigin ?? null,
      });
    }
  }
  return out;
}

/** One VO2max reading, reduced to plain data. */
export type Vo2MaxReading = {
  id: string;
  /** RFC3339 */
  time: string;
  vo2MillilitersPerMinuteKilogram: number;
  dataOrigin: string | null;
};

/**
 * Read VO2max readings in `[since, until]` — a device-written estimate
 * (design doc §3), read as a profile-level trend and never attached to a
 * session, so unlike `queryHeartRateSamples` this is not called per-session
 * at all; see `lib/healthConnectSync.ts` for when it runs.
 *
 * Same posture as `queryHeartRateSamples` — `[]` on anything transient, a
 * `HealthConnectPermissionError` on a refused grant (W15/#944) — for
 * the same reasons.
 */
export async function queryVo2MaxReadings(since: string, until: string): Promise<Vo2MaxReading[]> {
  if (!(await ensureInitialized())) return [];
  let records: NativeVo2MaxRecord[];
  try {
    const result = await hc!.readRecords('Vo2Max', {
      timeRangeFilter: { operator: 'between', startTime: since, endTime: until },
    });
    records = result.records as NativeVo2MaxRecord[];
  } catch (err) {
    rethrowIfNotPermitted(err, 'Vo2Max');
    return [];
  }

  const out: Vo2MaxReading[] = [];
  for (const record of records) {
    const recordID = record.metadata?.id;
    if (!recordID) continue;
    out.push({
      id: vo2MaxSampleID(recordID),
      time: record.time,
      vo2MillilitersPerMinuteKilogram: record.vo2MillilitersPerMinuteKilogram,
      dataOrigin: record.metadata?.dataOrigin ?? null,
    });
  }
  return out;
}

/**
 * -----------------------------------------------------------------------
 * N479/#824 — activity Health Connect noticed that VOLA never asked about
 * -----------------------------------------------------------------------
 *
 * The Android sibling of `healthkit.ts`'s "other workouts" section — same
 * split, same reasoning: this and the two `query*` functions above are the
 * only code in this file that touches the native module, so this is the
 * only thing device evidence has to cover for this ticket on Android;
 * `lib/detectedActivity.ts`'s filtering is pure and already unit tested.
 */

/** `ExerciseType.WALKING` / `.HIKING` — verified against the installed
 *  package's `src/constants.ts` (79 and 37 respectively), the same way
 *  `SDK_AVAILABLE` above was. Health Connect's own `ExerciseSessionRecord`
 *  carries a numeric `exerciseType`, not an enum value, so these stay plain
 *  numbers for the identical reason. */
const OTHER_EXERCISE_TYPE_CODES = { walking: 79, hiking: 37 } as const;

/** Matches `healthkit.ts`'s own type of the same name — the two platforms'
 *  native boundaries converge on one shared vocabulary before anything
 *  downstream (`lib/detectedActivity.ts`) has to care which produced it. */
export type DetectedActivityType = 'walking' | 'hiking';

function otherExerciseTypeFromCode(code: number): DetectedActivityType | null {
  if (code === OTHER_EXERCISE_TYPE_CODES.walking) return 'walking';
  if (code === OTHER_EXERCISE_TYPE_CODES.hiking) return 'hiking';
  return null;
}

/** One walking/hiking exercise session, reduced to plain data. No distance —
 *  Health Connect reports that as a separate `DistanceRecord`, and joining
 *  the two by time is real added complexity this ticket's scope does not
 *  need: the Today card reads fine with just how long the activity was. */
export type HealthConnectOtherWorkout = {
  id: string;
  type: DetectedActivityType;
  /** RFC3339 */
  startDate: string;
  /** RFC3339 */
  endDate: string;
  durationSeconds: number;
};

/**
 * Read this device's recent walking/hiking exercise sessions from Health
 * Connect, for the `[since, until]` window — the Android counterpart to
 * `healthkit.ts`'s `queryOtherWorkouts`.
 *
 * Same posture as `queryHeartRateSamples` above — `[]` on anything transient,
 * a `HealthConnectPermissionError` on a refused grant, never anything else
 * (W15/#944; see that class). Defensively re-checks `exerciseType` per record
 * rather than trusting `readRecords('ExerciseSession', ...)` to have filtered
 * by type at all — this package's `ReadRecordsOptions` has no type-narrowing
 * filter the way HealthKit's `queryWorkoutSamples` does, so every session of
 * every kind comes back and this function is the only place that narrows it.
 */
export async function queryOtherExerciseSessions(
  since: string,
  until: string,
): Promise<HealthConnectOtherWorkout[]> {
  if (!(await ensureInitialized())) return [];
  let records: NativeExerciseSessionRecord[];
  try {
    const result = await hc!.readRecords('ExerciseSession', {
      timeRangeFilter: { operator: 'between', startTime: since, endTime: until },
    });
    records = result.records as NativeExerciseSessionRecord[];
  } catch (err) {
    rethrowIfNotPermitted(err, 'ExerciseSession');
    return [];
  }

  const out: HealthConnectOtherWorkout[] = [];
  for (const record of records) {
    const recordID = record.metadata?.id;
    if (!recordID) continue; // no id, no stable id to key the ledger on — skip rather than guess
    const type = otherExerciseTypeFromCode(record.exerciseType);
    if (!type) continue;
    const durationSeconds = Math.max(
      0,
      Math.round(
        (new Date(record.endTime).getTime() - new Date(record.startTime).getTime()) / 1000,
      ),
    );
    out.push({ id: recordID, type, startDate: record.startTime, endDate: record.endTime, durationSeconds });
  }
  return out;
}

/**
 * Every exercise session Health Connect holds in `[since, until]`, reduced
 * to its own start and end — W19/#985, and the Android half of the
 * "prefer the watch's own workout" rule. The counterpart to
 * `lib/healthkit.ts`'s `queryWorkoutWindows`, returning the identical
 * platform-neutral shape so `lib/hrWorkoutWindow.ts` decides once for both
 * platforms rather than twice.
 *
 * Deliberately unfiltered by `exerciseType`, unlike `queryOtherExerciseSessions`
 * above — see `queryWorkoutWindows`'s own doc comment for why the activity
 * type cannot answer the question being asked here. It also means this
 * needs none of that function's per-record type narrowing, and no record
 * `metadata.id`: nothing downstream keys a ledger on these, so a record
 * without an id is still perfectly good evidence of when training happened.
 *
 * Same permission posture as every read in this file (W15/#944): a REFUSED
 * `ExerciseSession` grant throws `HealthConnectPermissionError` rather than
 * coming back as an empty list, so a missing manifest entry can never
 * masquerade as "the watch knows no workout". `ExerciseSession` has been in
 * `READ_RECORD_TYPES` since N479/#824, so this asks for nothing new.
 */
export async function queryExerciseSessionWindows(
  since: string,
  until: string,
): Promise<{ start: string; end: string }[]> {
  if (!(await ensureInitialized())) return [];
  let records: NativeExerciseSessionRecord[];
  try {
    const result = await hc!.readRecords('ExerciseSession', {
      timeRangeFilter: { operator: 'between', startTime: since, endTime: until },
    });
    records = result.records as NativeExerciseSessionRecord[];
  } catch (err) {
    rethrowIfNotPermitted(err, 'ExerciseSession');
    return [];
  }
  return records.map((r) => ({ start: r.startTime, end: r.endTime }));
}

/**
 * Known Health Connect writer package names, matched to `biometric.Source`.
 *
 * Not exhaustive by design — Health Connect exposes no stable vendor
 * identifier the way `HKSource.bundleIdentifier` at least resembles one on
 * iOS, so this is a best-effort recognise-the-common-ones list rather than a
 * closed mapping. Anything not matched here (Samsung Health chief among
 * them — extremely common on Android and deliberately not guessed at)
 * becomes `SourceAndroidWearable` — a real, honest "some Android app wrote
 * this" rather than a fabricated vendor name. See biometric.go's own doc
 * comment on that value for the reasoning.
 */
const KNOWN_DATA_ORIGINS: Record<string, BiometricSource> = {
  'com.garmin.android.apps.connectmobile': 'garmin',
  'com.whoop.android': 'whoop',
  'com.ouraring.oura': 'oura',
};

/**
 * Classify a Health Connect record's `dataOrigin` (a package name) into
 * this app's `biometric.Source` vocabulary. Pure — exercised by
 * `lib/__tests__/healthConnect.test.ts` without a device.
 */
export function sourceFromDataOrigin(dataOrigin: string | null): BiometricSource {
  if (dataOrigin && dataOrigin in KNOWN_DATA_ORIGINS) return KNOWN_DATA_ORIGINS[dataOrigin];
  return 'android_wearable';
}
