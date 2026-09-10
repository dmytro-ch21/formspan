import { getDb } from './db';
import type { HRSource, SessionMetrics } from './biometric';

/**
 * N547/#990 — a session's heart rate, kept where its SUMMARY is drawn.
 *
 * The athlete: *"In summaries we need to show avg hr as well, vo2 max."*
 *
 * `avg_hr_bpm` is server-side, per session, and the surfaces that show a
 * summary (Today's logged rows, the training calendar) are offline-first
 * LISTS. Fetching per row would be one request per row and nothing offline,
 * so this caches the value at the moment something else already has it. See
 * `db.ts`'s `CREATE_SESSION_HR_SUMMARY` for the full reasoning, including why
 * VO2max is not here.
 */

/**
 * Named `SessionHRSummary`, not `SessionHR`: `lib/healthConnectSync.ts`
 * already exports a `SessionHR` meaning a window's raw samples. Same words,
 * different thing.
 */
export type SessionHRSummary = {
  avgHRBPM: number | null;
  maxHRBPM: number | null;
  hrSource: HRSource;
};

/**
 * Write what a `SessionMetrics` knows about heart rate.
 *
 * Called wherever metrics arrive — the enrichment sweep and the three
 * session-detail screens — so a row gains its heart rate as soon as anything
 * in the app has learned it, and never needs a request of its own.
 *
 * A `'none'` row is written too, deliberately. "We asked and there was
 * nothing" is a different fact from "we have never asked", and only the first
 * is safe to stop re-rendering an absence for.
 */
export async function cacheSessionHR(
  userID: string,
  /**
   * Taken from the CALLER, not from `metrics.session_id`.
   *
   * Every caller already knows which session it is asking about, and taking
   * the id from the response makes the write depend on the server echoing a
   * field back. That is a needless dependency, and it bit immediately: the
   * enrichment sweep's own tests stub `computeSessionMetrics` with just the
   * two fields they assert on, so the echoed id was `undefined` and the write
   * blew up inside the sweep. The stub is unrealistic, but the code should
   * not have been asking.
   */
  sessionID: string,
  metrics: Pick<SessionMetrics, 'avg_hr_bpm' | 'max_hr_bpm' | 'hr_source'>,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO session_hr_summary (user_id, session_id, avg_hr_bpm, max_hr_bpm, hr_source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, session_id) DO UPDATE SET
       avg_hr_bpm = excluded.avg_hr_bpm,
       max_hr_bpm = excluded.max_hr_bpm,
       hr_source  = excluded.hr_source`,
    userID,
    sessionID,
    metrics.avg_hr_bpm ?? null,
    metrics.max_hr_bpm ?? null,
    metrics.hr_source,
  );
}

/**
 * Heart rate for a batch of sessions, keyed by session id.
 *
 * Named `…Summaries`, not `readSessionHR`: `lib/biometricSync.ts` already has
 * a `readSessionHR` that fetches HR SAMPLES for a window from the health
 * store. Two functions a grep apart, one reading a cache and one making
 * network calls, would be a genuinely dangerous pair to confuse.
 *
 * A batch rather than one call per row: the callers are lists, and a query
 * per visible row is the shape this cache exists to avoid — reintroducing it
 * against SQLite instead of the network would be the same mistake, quieter.
 * Sessions with no row are simply absent from the map, which reads as "not
 * known" at the call site rather than as a zero.
 */
export async function readSessionHRSummaries(
  userID: string,
  sessionIDs: string[],
): Promise<Map<string, SessionHRSummary>> {
  const out = new Map<string, SessionHRSummary>();
  if (sessionIDs.length === 0) return out;
  const db = await getDb();
  const holes = sessionIDs.map(() => '?').join(',');
  const rows = await db.getAllAsync<{
    session_id: string;
    avg_hr_bpm: number | null;
    max_hr_bpm: number | null;
    hr_source: HRSource;
  }>(
    `SELECT session_id, avg_hr_bpm, max_hr_bpm, hr_source
     FROM session_hr_summary
     WHERE user_id = ? AND session_id IN (${holes})`,
    userID,
    ...sessionIDs,
  );
  for (const r of rows) {
    out.set(r.session_id, {
      avgHRBPM: r.avg_hr_bpm,
      maxHRBPM: r.max_hr_bpm,
      hrSource: r.hr_source,
    });
  }
  return out;
}

/**
 * The summary line's heart-rate entry, or null when there is nothing honest
 * to say.
 *
 * Null — never a zero, never a dash — under every absence: no cached row, a
 * `'none'` source (asked, found nothing), or a null average. `sessionMeta`
 * filters nulls out, so an absent measure simply does not appear, which is
 * the same discipline every other entry on that line already follows: a "0
 * sets" chip on a mat session reads as an abandoned session, and "0 bpm"
 * would read as a corpse.
 */
export function hrSummaryEntry(hr: SessionHRSummary | undefined): string | null {
  if (!hr || hr.hrSource === 'none' || hr.avgHRBPM == null) return null;
  return `${Math.round(hr.avgHRBPM)} bpm avg`;
}
