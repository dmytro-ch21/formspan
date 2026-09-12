import type { PhaseKind } from './anthropometry';
import { listCheckins, listPhases, type Checkin, type Phase } from './body';
import { getDb, withTransaction } from './db';
import type { TokenGetter } from './useAuthToken';

/**
 * The last-known check-ins and phase goal, kept on this phone — N568 (#1129).
 *
 * ## A read cache, and only that
 *
 * `lib/body.ts` records why check-in WRITES need signal, and that still holds.
 * This module makes the READS survive a dead spot: the last successful answer
 * is stored, and the day panel states it with the time it was fetched. There is
 * no outbox, no `dirty` flag and nothing here is ever sent anywhere. If this
 * ever grows a push, it has stopped being this ticket and become the second
 * sync surface `body.ts` argues against.
 *
 * ## Three states, never two
 *
 * - **never fetched** — no `body_cache_fetches` row for this athlete → `unknown`.
 *   The panel says "not available on this phone yet", never "none".
 * - **fetched, with rows** → the rows, each carrying the `fetched_at` of the
 *   fetch that last returned it.
 * - **fetched, genuinely empty** → `known` with nothing in it, plus the window
 *   that answer covered, so the empty state is "none since <from>" — an honest
 *   sentence about a 30-day query, not a claim about all time.
 *
 * ## When a cached row no longer exists on the server
 *
 * Offline, the phone cannot know, so the rule is about what it does know:
 *
 * 1. A cached fact is backed by its CACHE row, and says when that row was last
 *    confirmed. It never claims to be current.
 * 2. The next successful fetch that COVERS the row and does not return it
 *    deletes it — inside the fetched window for check-ins, the whole list for
 *    phases (which are fetched whole). So a check-in deleted on the web lingers
 *    only until the phone next has signal on Today, and is labelled with its
 *    old time until then.
 * 3. A row OUTSIDE a later fetch's window is left alone, and keeps its OLDER
 *    `fetched_at`. It was not re-confirmed, so it must not borrow the newer time.
 *
 * ## Keyed by athlete, and guarded against the wrong one
 *
 * Every read and write is scoped by `user_id`. A write whose rows name a
 * different athlete than the one it is filed under is refused outright — the
 * shape of a response that lands after an account switch on a shared phone —
 * because filing it would show one account's weight to the next.
 */

export type CachedCheckin = {
  measured_on: string;
  weight_kg: number | null;
  /** When the fetch that last returned this row answered. ISO. */
  fetched_at: string;
};

export type CachedPhase = {
  id: string;
  kind: PhaseKind;
  started_on: string;
  target_on: string | null;
  target_weight_kg: number | null;
  ended_on: string | null;
  fetched_at: string;
};

export type CheckinCacheView =
  | { state: 'unknown' }
  | {
      state: 'known';
      /** When the most recent check-in fetch answered. */
      fetchedAt: string;
      /** The range that answer covered. */
      from: string;
      to: string;
      /** The newest cached check-in on or before the day asked about. */
      latest: CachedCheckin | null;
    };

export type PhaseCacheView =
  | { state: 'unknown' }
  | {
      state: 'known';
      fetchedAt: string;
      /** The phase with no end date, or null when the athlete has none. */
      active: CachedPhase | null;
    };

type Marker = { fetched_at: string; window_from: string | null; window_to: string | null };

function namesAnotherAthlete(rows: { user_id: string }[], userId: string): boolean {
  return rows.some((r) => r.user_id !== userId);
}

/**
 * Store one answer to `listCheckins(from..to)`.
 *
 * Rows inside the window that the server did not return are deleted — the
 * same shape as `cacheTargets`, and for the same reason: a check-in deleted on
 * the web must not reappear the next time the phone is offline.
 *
 * Returns false, writing nothing, when a row names another athlete.
 */
export async function cacheCheckins(
  userId: string,
  from: string,
  to: string,
  checkins: Checkin[],
  fetchedAt: string = new Date().toISOString(),
): Promise<boolean> {
  if (namesAnotherAthlete(checkins, userId)) return false;
  const db = await getDb();
  await withTransaction(db, async () => {
    const days = checkins.map((c) => c.measured_on);
    const placeholders = days.length ? days.map(() => '?').join(',') : `''`;
    await db.runAsync(
      `DELETE FROM body_checkins_cache
        WHERE user_id = ? AND measured_on BETWEEN ? AND ?
          AND measured_on NOT IN (${placeholders})`,
      userId, from, to, ...days,
    );
    for (const c of checkins) {
      await db.runAsync(
        `INSERT INTO body_checkins_cache (user_id, measured_on, weight_kg, fetched_at)
         VALUES (?,?,?,?)
         ON CONFLICT(user_id, measured_on) DO UPDATE SET
           weight_kg = excluded.weight_kg, fetched_at = excluded.fetched_at`,
        userId, c.measured_on, c.weight_kg ?? null, fetchedAt,
      );
    }
    await db.runAsync(
      `INSERT INTO body_cache_fetches (user_id, kind, fetched_at, window_from, window_to)
       VALUES (?, 'checkins', ?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET
         fetched_at = excluded.fetched_at,
         window_from = excluded.window_from, window_to = excluded.window_to`,
      userId, fetchedAt, from, to,
    );
  });
  return true;
}

/**
 * Store one answer to `listPhases`, which returns the athlete's whole list — so
 * any cached phase it did not return is gone, and is deleted.
 *
 * Returns false, writing nothing, when a row names another athlete.
 */
export async function cachePhases(
  userId: string,
  phases: Phase[],
  fetchedAt: string = new Date().toISOString(),
): Promise<boolean> {
  if (namesAnotherAthlete(phases, userId)) return false;
  const db = await getDb();
  await withTransaction(db, async () => {
    const ids = phases.map((p) => p.id);
    const placeholders = ids.length ? ids.map(() => '?').join(',') : `''`;
    await db.runAsync(
      `DELETE FROM body_phases_cache WHERE user_id = ? AND id NOT IN (${placeholders})`,
      userId, ...ids,
    );
    for (const p of phases) {
      await db.runAsync(
        `INSERT INTO body_phases_cache
           (user_id, id, kind, started_on, target_on, target_weight_kg, ended_on, fetched_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           kind = excluded.kind, started_on = excluded.started_on,
           target_on = excluded.target_on, target_weight_kg = excluded.target_weight_kg,
           ended_on = excluded.ended_on, fetched_at = excluded.fetched_at`,
        userId, p.id, p.kind, p.started_on, p.target_on ?? null,
        p.target_weight_kg ?? null, p.ended_on ?? null, fetchedAt,
      );
    }
    await db.runAsync(
      `INSERT INTO body_cache_fetches (user_id, kind, fetched_at, window_from, window_to)
       VALUES (?, 'phases', ?, NULL, NULL)
       ON CONFLICT(user_id, kind) DO UPDATE SET fetched_at = excluded.fetched_at`,
      userId, fetchedAt,
    );
  });
  return true;
}

async function marker(userId: string, kind: 'checkins' | 'phases'): Promise<Marker | null> {
  const db = await getDb();
  return db.getFirstAsync<Marker>(
    `SELECT fetched_at, window_from, window_to FROM body_cache_fetches
      WHERE user_id = ? AND kind = ?`,
    userId, kind,
  );
}

/** The newest cached check-in on or before `on`, or `unknown` if never fetched. */
export async function localCheckinView(userId: string, on: string): Promise<CheckinCacheView> {
  const m = await marker(userId, 'checkins');
  if (!m) return { state: 'unknown' };
  const db = await getDb();
  const latest = await db.getFirstAsync<CachedCheckin>(
    `SELECT measured_on, weight_kg, fetched_at FROM body_checkins_cache
      WHERE user_id = ? AND measured_on <= ?
      ORDER BY measured_on DESC
      LIMIT 1`,
    userId, on,
  );
  return {
    state: 'known',
    fetchedAt: m.fetched_at,
    from: m.window_from ?? '',
    to: m.window_to ?? '',
    latest: latest ?? null,
  };
}

/** The cached phase with no end date, or `unknown` if never fetched. */
export async function localPhaseView(userId: string): Promise<PhaseCacheView> {
  const m = await marker(userId, 'phases');
  if (!m) return { state: 'unknown' };
  const db = await getDb();
  const active = await db.getFirstAsync<CachedPhase>(
    `SELECT id, kind, started_on, target_on, target_weight_kg, ended_on, fetched_at
       FROM body_phases_cache
      WHERE user_id = ? AND ended_on IS NULL
      ORDER BY started_on DESC, id
      LIMIT 1`,
    userId,
  );
  return { state: 'known', fetchedAt: m.fetched_at, active: active ?? null };
}

/**
 * Fetch check-ins and phases, and keep what came back.
 *
 * **The only writer of the cache.** Called from Today's check-in refresh, which
 * runs on every focus of Today — and Today is where the day panel is opened
 * from, so whenever the phone had signal on the way in, the panel's cache is
 * seconds old.
 *
 * - A fetch that FAILS rejects before anything is written. The previous
 *   last-known values stay, with their older time — which is the truth.
 * - A cache write that fails is swallowed. The athlete asked Today for their
 *   check-ins and got them; SQLite failing must not turn that into an error,
 *   and the cost is only that the panel keeps its older time.
 * - `userId` null (not signed in yet) fetches without caching: there is no
 *   athlete to file the answer under.
 */
export async function refreshBody(
  getToken: TokenGetter,
  userId: string | null,
  range: { from: string; to: string },
): Promise<{ checkins: Checkin[]; phases: Phase[] }> {
  const [checkins, phases] = await Promise.all([
    listCheckins(getToken, range),
    listPhases(getToken),
  ]);
  if (userId) {
    const fetchedAt = new Date().toISOString();
    // allSettled, not all: both writes run to completion either way, so a
    // failed check-in write cannot leave the phase write racing on unawaited.
    await Promise.allSettled([
      cacheCheckins(userId, range.from, range.to, checkins, fetchedAt),
      cachePhases(userId, phases, fetchedAt),
    ]);
  }
  return { checkins, phases };
}
