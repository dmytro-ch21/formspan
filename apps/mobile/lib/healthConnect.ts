import { Platform } from 'react-native';

import { heartRateSamplesInWindow, type RawHeartRateSample } from './biometricEnrichment';
import type { BiometricSource } from './biometricApi';

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
 * `lib/biometricEnrichment.ts` holds every pure decision (the window clip,
 * the history-wall check, the HRmax estimate, the retry ledger logic) and
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

type ReadRecordsOptions = {
  timeRangeFilter: { operator: 'between'; startTime: string; endTime: string };
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
    recordType: 'HeartRate' | 'Vo2Max',
    options: ReadRecordsOptions,
  ) => Promise<{ records: unknown[] }>;
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

/** The two record types this feature reads. Literals, not an imported
 *  `RecordType` value, for the same reason as `SDK_AVAILABLE`. */
const READ_RECORD_TYPES = ['HeartRate', 'Vo2Max'] as const;

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
 * has responded to the system dialog once. Like HealthKit, a query that
 * comes back empty after this is indistinguishable from "nothing to read" —
 * `lib/healthConnectSync.ts` treats both the same way rather than guessing
 * at which.
 */
export async function requestHealthConnectReadAuthorization(): Promise<boolean> {
  if (!(await ensureInitialized())) return false;
  try {
    const granted = await hc!.requestPermission(
      READ_RECORD_TYPES.map((recordType) => ({ accessType: 'read' as const, recordType })),
    );
    return READ_RECORD_TYPES.every((rt) =>
      granted.some((g) => g.recordType === rt && g.accessType === 'read'),
    );
  } catch {
    return false;
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
 * `biometricEnrichment.ts`'s `isWithinHealthConnectHistoryWall` themselves
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
  } catch {
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
 * Same "return `[]`, never throw" posture as `queryHeartRateSamples`, for
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
  } catch {
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
