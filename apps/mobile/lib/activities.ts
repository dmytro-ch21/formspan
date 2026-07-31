import { randomUUID } from 'expo-crypto';

import { isPermanentStatus } from './apiError';
import { getDb } from './db';
import { newTraceId, traceparent } from './trace';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

export type LocalActivity = {
  id: string;
  kind: string;
  occurred_at: string;
  notes: string | null;
  synced: number;
};

/**
 * Writes the activity locally and returns immediately — no network involved.
 *
 * The ID is generated here, on the client, which is what makes the later
 * sync idempotent: retrying a push with the same ID can never duplicate the
 * row server-side. It's a CSPRNG UUID rather than `Math.random()` hex
 * (unlike lib/trace.ts, whose IDs are log-correlation only): a collision
 * here isn't cosmetic — the server treats this ID as an idempotency key,
 * and a guessable one is a security-relevant value.
 */
export async function logActivityOffline(
  userId: string,
  kind: string,
  notes: string | null,
): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  await db.runAsync(
    `INSERT INTO activities (id, user_id, kind, occurred_at, notes, synced) VALUES (?, ?, ?, ?, ?, 0)`,
    id,
    userId,
    kind,
    new Date().toISOString(),
    notes,
  );
  return id;
}

/** Scoped to one user — a shared device must never show another's history. */
export async function listLocalActivities(userId: string): Promise<LocalActivity[]> {
  const db = await getDb();
  return db.getAllAsync<LocalActivity>(
    `SELECT id, kind, occurred_at, notes, synced FROM activities
     WHERE user_id = ? ORDER BY occurred_at DESC`,
    userId,
  );
}

export type SyncResult = { synced: number; failed: number; error?: string };

/**
 * Pushes the signed-in user's unsynced rows to the API, one request each,
 * marking a row synced only on a confirmed 2xx. Anything transient leaves
 * the row pending so the next attempt retries it — safe precisely because
 * create is idempotent on the client-generated ID.
 *
 * Deliberately sequential: these are a handful of rows, and serial requests
 * keep the failure semantics simple (one bad row doesn't obscure others).
 */
export async function syncPendingActivities(
  userId: string,
  getToken: () => Promise<string | null>,
): Promise<SyncResult> {
  const db = await getDb();
  const pending = await db.getAllAsync<LocalActivity>(
    `SELECT id, kind, occurred_at, notes, synced FROM activities
     WHERE user_id = ? AND synced = 0`,
    userId,
  );
  if (pending.length === 0) return { synced: 0, failed: 0 };

  // One trace ID for the whole sync run, so every row's request correlates
  // as a single logical operation in the API's logs.
  const traceId = newTraceId();
  let synced = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (const row of pending) {
    try {
      // Fetched per row, not once per run: Clerk session tokens are
      // short-lived and getToken() refreshes internally, so a long backlog
      // over a slow link would otherwise start failing 401 partway through.
      const token = await getToken();
      if (!token) {
        failed++;
        firstError ??= 'Not signed in.';
        continue;
      }

      const res = await fetch(`${API_BASE}/activities`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          traceparent: traceparent(traceId),
        },
        body: JSON.stringify({
          id: row.id,
          kind: row.kind,
          occurred_at: row.occurred_at,
          notes: row.notes,
        }),
      });

      if (res.ok) {
        await db.runAsync(`UPDATE activities SET synced = 1 WHERE id = ?`, row.id);
        synced++;
        continue;
      }

      failed++;
      // A 4xx the server will never accept means retrying forever would
      // silently inflate the pending count with a row that can't drain, so
      // surface it instead of looping. The boundary lives in `apiError` rather
      // than here: this used to be an inline copy that disagreed with
      // `isPermanentRejection` about 401, so the same token expiry was
      // transient on this path and fatal on the session path.
      firstError ??= isPermanentStatus(res.status)
        ? `Rejected (${res.status}) — this entry can't sync.`
        : `API responded ${res.status}`;
    } catch (err) {
      // Offline, DNS failure, etc. — leave the row pending and move on.
      failed++;
      firstError ??= String(err);
    }
  }

  return { synced, failed, error: firstError };
}
