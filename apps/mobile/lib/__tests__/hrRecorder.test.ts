import { migratedFixture, type FixtureDb } from './support/sqlite';
import {
  UPLOADED_RETENTION_DAYS,
  countHRMonitorSamples,
  flushHRMonitorSamples,
  pendingHRMonitorSamples,
  pruneUploadedHRMonitorSamples,
  recordHRMonitorSample,
  toMonitorBiometricSample,
} from '../hrMonitor/hrRecorder';

/**
 * N528/#958 — the recorder against the REAL `hr_monitor_samples` table the
 * app's own `migrate()` creates (same fixture pattern as biometricSync's
 * tests); only the network upload is a fake.
 */

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `hr-${++mockUuid}` }));

const mockPut = jest.fn();
jest.mock('../biometric', () => {
  const real = jest.requireActual('../biometric');
  return { ...real, putBiometricSamples: (...args: unknown[]) => mockPut(...args) };
});

const USER = 'user_hr_rec';
const getToken = async () => 'tok';
const t0 = new Date('2026-09-08T10:00:00.000Z');

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockUuid = 0;
  mockPut.mockReset();
  mockPut.mockResolvedValue({ samples: [] });
});

describe('recordHRMonitorSample', () => {
  it('writes one pending row per reading, rounding bpm, and refuses nonsense', async () => {
    await recordHRMonitorSample(USER, 'ses-1', 131.6, t0);
    await recordHRMonitorSample(USER, 'ses-1', 0, t0);
    await recordHRMonitorSample(USER, 'ses-1', Number.NaN, t0);
    const rows = await pendingHRMonitorSamples(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: 'ses-1', bpm: 132, measured_at: t0.toISOString() });
    expect(await countHRMonitorSamples(USER, 'ses-1')).toBe(1);
  });
});

describe('toMonitorBiometricSample', () => {
  it('is always the bluetooth/hr_monitor pair the server pairs in Validate()', () => {
    expect(toMonitorBiometricSample({ id: 'a', measured_at: 'x', bpm: 120 })).toEqual({
      id: 'a',
      metric_type: 'heart_rate',
      source: 'hr_monitor',
      source_platform: 'bluetooth',
      value: 120,
      unit: 'bpm',
      measured_at: 'x',
    });
  });
});

describe('flushHRMonitorSamples', () => {
  it('uploads every pending row as a bluetooth sample, stamps them, and a second flush sends nothing', async () => {
    await recordHRMonitorSample(USER, 'ses-1', 120, t0);
    await recordHRMonitorSample(USER, 'ses-1', 125, new Date(t0.getTime() + 1000));
    await recordHRMonitorSample('someone_else', 'ses-9', 99, t0);

    expect(await flushHRMonitorSamples(USER, getToken, t0)).toBe(2);
    expect(mockPut).toHaveBeenCalledTimes(1);
    const [, uploaded] = mockPut.mock.calls[0];
    expect(uploaded).toHaveLength(2);
    expect(uploaded.every((s: { source_platform: string; source: string }) => s.source_platform === 'bluetooth' && s.source === 'hr_monitor')).toBe(true);
    expect(await pendingHRMonitorSamples(USER)).toEqual([]);
    expect(await pendingHRMonitorSamples('someone_else')).toHaveLength(1); // untouched

    mockPut.mockClear();
    expect(await flushHRMonitorSamples(USER, getToken, t0)).toBe(0);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('a failed upload stamps nothing — the same rows go on the next flush', async () => {
    await recordHRMonitorSample(USER, 'ses-1', 120, t0);
    mockPut.mockRejectedValueOnce(new Error('offline'));
    await expect(flushHRMonitorSamples(USER, getToken, t0)).rejects.toThrow('offline');
    expect(await pendingHRMonitorSamples(USER)).toHaveLength(1);
    expect(await flushHRMonitorSamples(USER, getToken, t0)).toBe(1);
  });

  it('prunes uploaded rows past the retention window, never pending ones', async () => {
    await recordHRMonitorSample(USER, 'ses-old', 120, t0);
    await flushHRMonitorSamples(USER, getToken, t0);
    await recordHRMonitorSample(USER, 'ses-new', 121, t0);
    const later = new Date(t0.getTime() + (UPLOADED_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    mockPut.mockRejectedValueOnce(new Error('offline'));
    await flushHRMonitorSamples(USER, getToken, later).catch(() => {});
    // The old, uploaded row is still there — pruning only runs after a
    // successful flush or an empty one.
    expect(await countHRMonitorSamples(USER, 'ses-old')).toBe(1);
    await flushHRMonitorSamples(USER, getToken, later);
    expect(await countHRMonitorSamples(USER, 'ses-old')).toBe(0);
    expect(await countHRMonitorSamples(USER, 'ses-new')).toBe(1);
  });
});

describe('pruneUploadedHRMonitorSamples', () => {
  it('removes only UPLOADED rows past the window — a pending row of any age is owed to the server and stays', async () => {
    await recordHRMonitorSample(USER, 'ses-old', 120, t0);
    await flushHRMonitorSamples(USER, getToken, t0); // uploaded, stamped t0
    await recordHRMonitorSample(USER, 'ses-pending', 121, t0); // never uploaded
    const later = new Date(t0.getTime() + (UPLOADED_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    await pruneUploadedHRMonitorSamples(USER, later);
    expect(await countHRMonitorSamples(USER, 'ses-old')).toBe(0);
    expect(await countHRMonitorSamples(USER, 'ses-pending')).toBe(1);
    expect(await pendingHRMonitorSamples(USER)).toHaveLength(1);
  });
});
