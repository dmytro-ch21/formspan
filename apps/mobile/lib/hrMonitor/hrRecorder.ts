import { randomUUID } from 'expo-crypto';

import { putBiometricSamples, type BiometricSample } from '../biometric';
import { getDb } from '../db';
import type { TokenGetter } from '../useAuthToken';

/**
 * N528/#958 — what the live stream leaves behind: one row per reading while
 * a session is running, in `hr_monitor_samples`, uploaded later as
 * `source_platform: 'bluetooth'` / `source: 'hr_monitor'` samples. Offline
 * first, like every other write on this phone: a gym with no signal records
 * exactly as well as one with, and the flush happens whenever it can.
 *
 * The server's `MergeHRSources` then prefers these over anything Apple
 * Health / Health Connect has for the same window, and the existing
 * enrichment pass (`biometricSync.ts` / `healthConnectSync.ts`) computes the
 * session's metrics as it always did — it just finds the direct samples
 * already there.
 */

/** Readings closer together than this are coalesced — a monitor reports
 *  ~1/s and a session's report does not get better past that. */
export const MIN_SAMPLE_SPACING_MS = 1_000;

/** Rows already uploaded are pruned after this — they exist only to survive
 *  being offline, not as a second copy of the server. */
export const UPLOADED_RETENTION_DAYS = 7;

export async function recordHRMonitorSample(
  userID: string,
  sessionID: string,
  bpm: number,
  measuredAt: Date,
): Promise<void> {
  if (!Number.isFinite(bpm) || bpm <= 0) return;
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO hr_monitor_samples (id, user_id, session_id, measured_at, bpm, uploaded_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    randomUUID(),
    userID,
    sessionID,
    measuredAt.toISOString(),
    Math.round(bpm),
  );
}

type Row = { id: string; session_id: string; measured_at: string; bpm: number };

/** Rows owed to the server, oldest first. */
export async function pendingHRMonitorSamples(userID: string, limit = 5_000): Promise<Row[]> {
  const db = await getDb();
  return db.getAllAsync<Row>(
    `SELECT id, session_id, measured_at, bpm FROM hr_monitor_samples
     WHERE user_id = ? AND uploaded_at IS NULL ORDER BY measured_at, id LIMIT ?`,
    userID,
    limit,
  );
}

export function toMonitorBiometricSample(row: Pick<Row, 'id' | 'measured_at' | 'bpm'>): BiometricSample {
  return {
    id: row.id,
    metric_type: 'heart_rate',
    source: 'hr_monitor',
    source_platform: 'bluetooth',
    value: row.bpm,
    unit: 'bpm',
    measured_at: row.measured_at,
  };
}

/**
 * Uploads everything pending and stamps it. Throws on a failed upload with
 * nothing stamped, so the next flush retries the same rows — the server
 * dedupes by sample id, so a retry after a half-delivered batch is safe.
 * Returns how many rows were uploaded.
 */
export async function flushHRMonitorSamples(userID: string, getToken: TokenGetter, now: Date = new Date()): Promise<number> {
  const rows = await pendingHRMonitorSamples(userID);
  if (rows.length === 0) {
    await pruneUploadedHRMonitorSamples(userID, now);
    return 0;
  }
  await putBiometricSamples(getToken, rows.map(toMonitorBiometricSample));
  const db = await getDb();
  const stamp = now.toISOString();
  // One statement per chunk of ids rather than one per row — a session is
  // a few thousand rows.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db.runAsync(
      `UPDATE hr_monitor_samples SET uploaded_at = ? WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(',')})`,
      stamp,
      userID,
      ...chunk.map((r) => r.id),
    );
  }
  await pruneUploadedHRMonitorSamples(userID, now);
  return rows.length;
}

export async function pruneUploadedHRMonitorSamples(userID: string, now: Date): Promise<void> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - UPLOADED_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.runAsync(
    `DELETE FROM hr_monitor_samples WHERE user_id = ? AND uploaded_at IS NOT NULL AND uploaded_at < ?`,
    userID,
    cutoff,
  );
}

/** How many direct readings this phone holds for one session (uploaded or
 *  not) — what the in-session screen shows as "recording" evidence. */
export async function countHRMonitorSamples(userID: string, sessionID: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM hr_monitor_samples WHERE user_id = ? AND session_id = ?`,
    userID,
    sessionID,
  );
  return row?.n ?? 0;
}
