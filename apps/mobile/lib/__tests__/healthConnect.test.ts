/**
 * The pure half of Health Connect reading (N478): the vendor classifier and
 * the deterministic sample-id derivation, plus the module-scope platform
 * guard that keeps this file inert off Android. Deliberately not testing
 * `queryHeartRateSamples`/`queryVo2MaxReadings`/
 * `requestHealthConnectReadAuthorization` against the real native call —
 * those are the one part of this feature no test run from this environment
 * can reach (see `lib/healthConnect.ts`'s own doc comment on why the native
 * surface is kept this thin, and the ticket's NEEDS HUMAN EVIDENCE
 * criterion).
 *
 * `react-native-health-connect` IS installed here (a real dependency, not a
 * mock) — and unlike `@kingstinct/react-native-healthkit`, requiring it
 * under Jest does NOT throw: verified directly (see the module-guard test
 * below), `Platform.OS` under `jest-expo` is `'ios'`, and this package's own
 * `Platform.select` for that case is a `Proxy` that only throws on property
 * ACCESS of an exported function's return, not at require time — so a naive
 * "does requiring this throw" test would pass for the wrong reason. What
 * actually keeps this file safe under Jest (and on a real iOS device, which
 * has no Health Connect at all) is `load()`'s own `Platform.OS !== 'android'`
 * check, BEFORE any `require` — that is what this suite verifies.
 */

import {
  isHealthConnectSupported,
  queryOtherExerciseSessions,
  sourceFromDataOrigin,
  heartRateSampleID,
  vo2MaxSampleID,
} from '../healthConnect';
import { Platform } from 'react-native';

describe('isHealthConnectSupported — the module-scope platform guard', () => {
  it("is false under this suite's platform (never touches the native module)", async () => {
    // Documents the environment this whole file's other tests run under —
    // see this file's doc comment for why this specific fact is what makes
    // the guard, not the package's own behaviour, the thing keeping this
    // file safe here.
    expect(Platform.OS).toBe('ios');
    expect(await isHealthConnectSupported()).toBe(false);
  });
});

/**
 * N479/#824 — same "resolves to empty, never throws" contract as
 * `queryHeartRateSamples`/`queryVo2MaxReadings`, exercised the same way: this
 * suite's platform makes `ensureInitialized()` false before any native call.
 */
describe('queryOtherExerciseSessions', () => {
  it('resolves to an empty array when Health Connect is unavailable', async () => {
    await expect(
      queryOtherExerciseSessions('2026-08-29T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
    ).resolves.toEqual([]);
  });
});

describe('sourceFromDataOrigin', () => {
  it('recognises Garmin Connect', () => {
    expect(sourceFromDataOrigin('com.garmin.android.apps.connectmobile')).toBe('garmin');
  });

  it('recognises Whoop', () => {
    expect(sourceFromDataOrigin('com.whoop.android')).toBe('whoop');
  });

  it('recognises Oura', () => {
    expect(sourceFromDataOrigin('com.ouraring.oura')).toBe('oura');
  });

  it('falls back to android_wearable for an unrecognised writer (Samsung Health, most commonly)', () => {
    // This is the case this value exists for — see biometric.go's own doc
    // comment on `SourceAndroidWearable`: Samsung Health is extremely
    // common on Android and Health Connect exposes no stable per-vendor
    // identifier to match it against.
    expect(sourceFromDataOrigin('com.sec.android.app.shealth')).toBe('android_wearable');
  });

  it('falls back to android_wearable for null (never fabricates a real vendor)', () => {
    expect(sourceFromDataOrigin(null)).toBe('android_wearable');
  });
});

describe('heartRateSampleID', () => {
  it('is deterministic for the same record and sample time', () => {
    const a = heartRateSampleID('rec-1', '2026-09-01T07:05:00.000Z');
    const b = heartRateSampleID('rec-1', '2026-09-01T07:05:00.000Z');
    expect(a).toBe(b);
  });

  it('differs for a different sample time in the same record', () => {
    const a = heartRateSampleID('rec-1', '2026-09-01T07:05:00.000Z');
    const b = heartRateSampleID('rec-1', '2026-09-01T07:05:01.000Z');
    expect(a).not.toBe(b);
  });

  it('differs for a different record', () => {
    const a = heartRateSampleID('rec-1', '2026-09-01T07:05:00.000Z');
    const b = heartRateSampleID('rec-2', '2026-09-01T07:05:00.000Z');
    expect(a).not.toBe(b);
  });

  it('stays comfortably under the backend maxSampleIDLength (128)', () => {
    const id = heartRateSampleID('11111111-1111-1111-1111-111111111111', '2026-09-01T07:05:00.000Z');
    expect(id.length).toBeLessThan(128);
  });
});

describe('vo2MaxSampleID', () => {
  it('is deterministic for the same record', () => {
    expect(vo2MaxSampleID('rec-1')).toBe(vo2MaxSampleID('rec-1'));
  });

  it('differs for a different record', () => {
    expect(vo2MaxSampleID('rec-1')).not.toBe(vo2MaxSampleID('rec-2'));
  });

  it('never collides with a heart-rate sample id for the same record', () => {
    expect(vo2MaxSampleID('rec-1')).not.toBe(heartRateSampleID('rec-1', '2026-09-01T07:05:00.000Z'));
  });
});
