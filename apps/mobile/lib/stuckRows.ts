import { NO_HTTP_CODE, isContractCode } from './apiError';
import { getDb } from './db';
import { STUCK_ROW_SOURCES, type StuckDomain, type StuckState } from './outboxPredicates';
import { PREF_STUCK_ROWS_REPORTED, readPref, writePref } from './prefs';
import { capture as realCapture, flush as realFlush } from './telemetryClient';

/**
 * Stuck sync rows, reported off the device — N565/#1108.
 *
 * ## The gap
 *
 * N167/#544 made a stuck row visible ON the phone: `SyncState.needsAttention`
 * counts sessions and workouts the server refused but are still owed, food
 * entries and sequences it refused and are no longer owed, and plans in either
 * state. Nothing reported any of it OFF the phone, so an operator could not
 * say how many athletes had stuck rows, in which domain, for which server
 * error, or for how long.
 *
 * ## What leaves the device, and what never does
 *
 * Per (domain, state, code) group: how many rows, the age of the oldest in
 * whole hours, and how many have no recorded age. That is all.
 *
 * - **No row ids, names, notes, or `last_error`.** The message is built from
 *   three enumerated values and nothing else; the query never selects a
 *   content column, so there is nothing here that could leak one.
 * - **The code, never the message.** `last_error_code` is the contract
 *   `error.code`. A stored value not shaped like one is reported as `other`
 *   rather than trusted.
 * - **Ages from `stuck_since`**, which `db.ts`'s triggers stamp when a row
 *   ENTERS a stuck state — never `updated_at`, which every edit moves.
 *
 * ## The three code buckets that are not server codes
 *
 * - `unknown` — the row has no code recorded. In practice: stuck before this
 *   change shipped. Nothing is backfilled, because nothing is known.
 * - `no_http_code` — recorded at refusal time, but the failure carried no
 *   contract code: a local failure, or a response whose body did not parse.
 * - `other` — codes folded together past {@link MAX_CODES_PER_SOURCE}, or a
 *   stored value that is not code-shaped.
 *
 * ## Channel: the existing telemetry path, nothing new
 *
 * `capture` from `telemetryClient.ts` → `POST /v1/client-errors` →
 * `health_events`, under the existing kind `sync_blocked` — which the server
 * already defines as "a client has given up pushing something". Every detail
 * key passes `telemetry.ts`'s allowlist; the three numeric keys this needs were
 * added there, in both copies, and `check:telemetry-parity` checks that every
 * key in {@link STUCK_ROW_DETAIL_KEYS} is allowlisted. No backend change: the
 * ingest validates `kind` and bounds `details` by size, and accepts any keys.
 *
 * `details.reason` is `stuck_blocked` or `stuck_refused`, which is what tells
 * this periodic count apart from the session screen's one-off `sync_blocked`
 * incident on the admin Health screen.
 *
 * ## Cadence
 *
 * The telemetry path has no scheduler of its own — `capture` only buffers, and
 * a 30-second timer flushes — so the trigger has to come from outside it. It
 * is the end of a sync pass that REACHED THE SERVER (`sync.ts`): that is when
 * refusals are written and counts change, and it is when a flush has signal.
 * On that trigger a report goes out when {@link reportDue} says so: the first
 * time, then at most once per {@link REPORT_EVERY_MS} while the counts hold,
 * or again when the counts change — but never twice inside
 * {@link MIN_CHANGE_INTERVAL_MS}, which is the telemetry buffer's own cap
 * window. A device with nothing stuck sends nothing at all.
 */

/** Codes kept per (domain, state) before the rest fold into `other`. */
export const MAX_CODES_PER_SOURCE = 5;
/** At most one report per this long while the counts do not change. */
export const REPORT_EVERY_MS = 24 * 60 * 60 * 1000;
/**
 * The shortest gap between two reports, even when the counts changed.
 *
 * Equal to `telemetry.ts`'s `windowMs`. A sync storm refusing one row per pass
 * would otherwise report on every pass; the next pass after this long reports
 * whatever the counts settled at.
 */
export const MIN_CHANGE_INTERVAL_MS = 15 * 60 * 1000;

export const UNKNOWN_CODE = 'unknown';
export const OTHER_CODE = 'other';

/**
 * Every detail key a stuck-row event carries. `check-telemetry-parity.py`
 * parses this list and fails if a key is missing from either allowlist — a
 * key `redact()` does not permit is silently dropped, so the report would
 * arrive without its numbers and nothing would look wrong.
 */
export const STUCK_ROW_DETAIL_KEYS = [
  'reason',
  'entity',
  'code',
  'rows',
  'oldest_age_hours',
  'rows_age_unknown',
] as const;

export type StuckGroup = {
  domain: StuckDomain;
  state: StuckState;
  code: string;
  rows: number;
  /** The earliest recorded `stuck_since` among these rows, or null if none has one. */
  oldestStuckSince: string | null;
  /** Rows with no recorded `stuck_since` — stuck before N565 shipped. */
  rowsAgeUnknown: number;
};

type RawGroup = { code: string | null; n: number; oldest: string | null; unknown_age: number };

const SENTINELS = new Set([UNKNOWN_CODE, NO_HTTP_CODE, OTHER_CODE]);

/** The bucket a stored `last_error_code` is reported under. */
export function bucketOf(code: string | null): string {
  if (code === null) return UNKNOWN_CODE;
  return isContractCode(code) ? code : OTHER_CODE;
}

function merge(into: StuckGroup, g: RawGroup | StuckGroup): void {
  const rows = 'n' in g ? g.n : g.rows;
  const unknown = 'unknown_age' in g ? g.unknown_age : g.rowsAgeUnknown;
  const oldest = 'oldest' in g ? g.oldest : g.oldestStuckSince;
  into.rows += rows;
  into.rowsAgeUnknown += unknown;
  if (oldest !== null && (into.oldestStuckSince === null || oldest < into.oldestStuckSince)) {
    into.oldestStuckSince = oldest;
  }
}

/**
 * Bucket, merge and fold one source's raw groups.
 *
 * Real codes beyond the top {@link MAX_CODES_PER_SOURCE} by row count fold into
 * `other`, so one report is bounded however many codes the server grows. The
 * three sentinel buckets are never folded away: `unknown` in particular is
 * what separates rows with no history from rows with a real refusal.
 */
export function foldGroups(
  source: { domain: StuckDomain; state: StuckState },
  raw: RawGroup[],
): StuckGroup[] {
  const byCode = new Map<string, StuckGroup>();
  for (const r of raw) {
    const code = bucketOf(r.code);
    const g = byCode.get(code) ?? {
      ...source, code, rows: 0, oldestStuckSince: null, rowsAgeUnknown: 0,
    };
    merge(g, r);
    byCode.set(code, g);
  }

  const real = [...byCode.values()]
    .filter((g) => !SENTINELS.has(g.code))
    .sort((a, b) => b.rows - a.rows || a.code.localeCompare(b.code));
  for (const g of real.slice(MAX_CODES_PER_SOURCE)) {
    byCode.delete(g.code);
    const other = byCode.get(OTHER_CODE) ?? {
      ...source, code: OTHER_CODE, rows: 0, oldestStuckSince: null, rowsAgeUnknown: 0,
    };
    merge(other, g);
    byCode.set(OTHER_CODE, other);
  }

  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * This athlete's stuck rows, grouped by domain, state and code.
 *
 * Selects counts and timestamps only — never an id, a name or `last_error` —
 * so there is no content column in this function's reach to leak.
 */
export async function stuckRowGroups(userId: string): Promise<StuckGroup[]> {
  const db = await getDb();
  const out: StuckGroup[] = [];
  for (const source of STUCK_ROW_SOURCES) {
    // Table and predicate are this module's own literals from
    // `outboxPredicates.ts`; only the user id is bound.
    const raw = await db.getAllAsync<RawGroup>(
      `SELECT last_error_code AS code,
              COUNT(*) AS n,
              MIN(stuck_since) AS oldest,
              SUM(CASE WHEN stuck_since IS NULL THEN 1 ELSE 0 END) AS unknown_age
         FROM ${source.table}
        WHERE user_id = ? AND (${source.predicate})
        GROUP BY last_error_code`,
      userId,
    );
    out.push(...foldGroups(source, raw));
  }
  return out;
}

/** Whole hours since `since`, or null when there is no usable timestamp. */
export function ageHours(since: string | null, now: number): number | null {
  if (since === null) return null;
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  // Clamped: a phone clock moved backwards must not report a negative age.
  return Math.max(0, Math.floor((now - at) / 3_600_000));
}

/**
 * What decides "the counts changed": domain, state, code and row count. Ages
 * are left out on purpose — they change every hour, and a report per hour is
 * precisely the cadence this is meant to prevent.
 */
export function signatureOf(groups: StuckGroup[]): string {
  return groups.map((g) => `${g.domain}:${g.state}:${g.code}:${g.rows}`).join(',');
}

/** One telemetry event for one group. Numbers and enumerated words only. */
export function stuckRowEvent(
  g: StuckGroup,
  now: number,
): { message: string; details: Record<string, string | number> } {
  const details: Record<string, string | number> = {
    reason: `stuck_${g.state}`,
    entity: g.domain,
    code: g.code,
    rows: g.rows,
    rows_age_unknown: g.rowsAgeUnknown,
  };
  const age = ageHours(g.oldestStuckSince, now);
  // Omitted rather than sent as 0 when no row has a recorded age: 0 would read
  // as "just got stuck", which is the one thing that is not known.
  if (age !== null) details.oldest_age_hours = age;
  // Domain, state and code are all in the message because the telemetry buffer
  // fingerprints on it: two groups sharing a message would coalesce into ONE
  // event carrying the first group's numbers.
  return { message: `stuck rows: ${g.domain} ${g.state} ${g.code}`, details };
}

export type LastReport = { at: number; signature: string };

export function parseLastReport(raw: string | null): LastReport | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastReport>;
    if (typeof v.at === 'number' && Number.isFinite(v.at) && typeof v.signature === 'string') {
      return { at: v.at, signature: v.signature };
    }
  } catch {
    // A corrupt marker is treated as no marker: one extra report, never none.
  }
  return null;
}

/** Whether a report should go out now. See the module comment's Cadence. */
export function reportDue(last: LastReport | null, signature: string, now: number): boolean {
  if (signature === '') return false;
  if (last === null) return true;
  const since = now - last.at;
  // A clock that moved backwards past the last report: report once and re-stamp,
  // rather than staying silent until the clock catches up — possibly months.
  if (since < 0) return true;
  if (since >= REPORT_EVERY_MS) return true;
  return last.signature !== signature && since >= MIN_CHANGE_INTERVAL_MS;
}

export type StuckReportDeps = {
  now?: () => number;
  /** False once the signed-in athlete is no longer `userId`. */
  isCurrent?: () => boolean;
  capture?: typeof realCapture;
  flush?: typeof realFlush;
};

/**
 * Report this athlete's stuck rows, if one is due. Never throws.
 *
 * Returns whether a report was handed to the telemetry buffer — for tests; the
 * sync orchestrator ignores it.
 */
export async function reportStuckRows(userId: string, deps: StuckReportDeps = {}): Promise<boolean> {
  const send = deps.capture ?? realCapture;
  const flushNow = deps.flush ?? realFlush;
  const isCurrent = deps.isCurrent ?? (() => true);
  try {
    const now = (deps.now ?? Date.now)();
    const groups = await stuckRowGroups(userId);
    const signature = signatureOf(groups);
    const last = parseLastReport(await readPref(userId, PREF_STUCK_ROWS_REPORTED));
    if (!reportDue(last, signature, now)) return false;

    // Checked around the last await, not once. The telemetry buffer is sent
    // under whichever token is installed WHEN IT FLUSHES, so a report built for
    // athlete A and captured after a switch to B would be filed under B.
    if (!isCurrent()) return false;
    // Written BEFORE the capture. If the write fails this throws into the
    // catch and nothing is sent — a missed report — rather than sending one
    // every pass because the marker never sticks.
    await writePref(userId, PREF_STUCK_ROWS_REPORTED, JSON.stringify({ at: now, signature }));
    if (!isCurrent()) return false;

    // Drain first. The buffer COALESCES by fingerprint and keeps the first
    // occurrence's details, so an earlier report still sitting in it — the
    // timer does not run while the app is backgrounded — would swallow this
    // one and ship the old numbers. `flush` drains synchronously before its
    // first await, which is all this needs.
    void flushNow();
    for (const g of groups) {
      const e = stuckRowEvent(g, now);
      send('error', 'sync_blocked', e.message, e.details);
    }
    // Then send now rather than on the 30-second timer, for the same reason:
    // nothing else should get the chance to coalesce into it.
    void flushNow();
    return true;
  } catch {
    // Reporting a problem must never create one (`telemetryClient.ts`).
    return false;
  }
}
