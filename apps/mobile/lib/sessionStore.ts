import { randomUUID } from 'expo-crypto';
import type { TokenGetter } from './useAuthToken';
import type * as SQLite from 'expo-sqlite';

import { ApiError, isNotFound, isOffline, isPermanentRejection } from './apiError';
import { getDb } from './db';
import type { Exercise } from './exercises';
import type { Workout, WorkoutItem } from './workouts';
import {
  finishSession as pushFinish,
  getSession as pullSession,
  deleteSession,
  listSessions as pullSessions,
  replaceSets as pushSets,
  startSession as pushCreate,
  type LoggedSet,
  type Session,
} from './sessions';

/**
 * Offline-first session storage.
 *
 * Logging is the one thing in this app that must work with no signal at all.
 * A basement gym, a concrete-walled dojo and an aeroplane are not edge cases
 * for a training log — they're where training happens. So every read and
 * write on the session screen goes to SQLite, and the network is a
 * background reconciliation concern rather than something the UI waits on.
 *
 * The design leans entirely on two properties the API already guarantees:
 *
 *   1. The session ID is **client-generated**, so creating a session offline
 *      and pushing it later can never duplicate it — the server's create is
 *      idempotent on that ID.
 *   2. Sets are replaced as a **whole ordered list**, so the outbox needs to
 *      store desired *state*, not a log of operations. Replaying is just
 *      "send what the row says now", which means a failed push followed by
 *      three more edits still costs exactly one request.
 *
 * That second property is what keeps this simple enough to trust. An
 * operation log would need ordering, compaction and conflict resolution;
 * last-write-wins on a whole list needs none of it, and is correct because a
 * live session is edited on exactly one device at a time.
 */

export type LocalSession = Session & {
  /** True while the server doesn't yet hold this exact state. */
  dirty: boolean;
};

type Row = {
  id: string;
  user_id: string;
  workout_id: string | null;
  sport: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  notes: string;
  sets_json: string;
  dirty: number;
  remote: number;
  /** Set once the athlete deleted it; the row survives until the server agrees. */
  deleted_at: string | null;
  updated_at: string;
};

/** Parsed sets, or `null` if the blob is unreadable. */
function parseSets(json: string): LoggedSet[] | null {
  try {
    // `completed` post-dates some cached rows. Defaulting it to true mirrors
    // the server migration's backfill — without it, a session cached before
    // the upgrade reads as entirely unperformed, and if it happens to be
    // dirty the next push writes those false flags straight over the
    // server's backfilled ones.
    return (JSON.parse(json) as LoggedSet[]).map((s) => ({
      ...s,
      completed: s.completed ?? true,
    }));
  } catch {
    return null;
  }
}

function toSession(r: Row): LocalSession {
  // A corrupt blob must not make the session unopenable — an empty list
  // loses the sets on screen, but a throw here would lose the whole workout.
  // The push paths check `parseSets` themselves rather than trusting this,
  // because sending that empty list would turn a local read failure into
  // permanent deletion on the server.
  const sets = parseSets(r.sets_json) ?? [];
  return {
    id: r.id,
    user_id: r.user_id,
    workout_id: r.workout_id,
    sport: r.sport,
    name: r.name,
    started_at: r.started_at,
    ended_at: r.ended_at,
    notes: r.notes,
    sets,
    created_at: r.started_at,
    updated_at: r.updated_at,
    dirty: r.dirty === 1,
  };
}

/**
 * `remote` marks a session the server has acknowledged. It only ever moves
 * 0 -> 1 here (`max` in the conflict clause): a local edit can't un-create
 * something the server already holds. The one path that clears it is a 404
 * on push, in `pushRow`.
 */
/**
 * Exported ONLY so the SQLite fixture can test the tombstone backstop.
 *
 * By design no production path reaches this with a tombstoned id — the pull
 * skips them and `hydrateSession` refuses outright. That layering is what
 * makes the `WHERE deleted_at IS NULL` clause a backstop for a *future*
 * caller, and the only way to exercise a backstop is to be that caller.
 * Nothing outside the tests should import this; use the functions above.
 */
export async function upsert(
  s: LocalSession,
  userID: string,
  dirty: boolean,
  remote: boolean,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workout_id = excluded.workout_id,
       sport      = excluded.sport,
       name       = excluded.name,
       started_at = excluded.started_at,
       ended_at   = excluded.ended_at,
       notes      = excluded.notes,
       sets_json  = excluded.sets_json,
       dirty      = excluded.dirty,
       remote     = max(local_sessions.remote, excluded.remote),
       updated_at = excluded.updated_at
     -- Never write over a tombstone.
     --
     -- Not defensive padding: this clause IS the invariant. The SET list
     -- above clobbers dirty, and deleted_at is deliberately absent from it,
     -- so an upsert onto a deleted row would leave the tombstone in place
     -- but mark it clean -- and the delete would silently never be pushed.
     -- The pull and hydrateSession each guard against reaching here with a
     -- tombstoned id, but that is two callers remembering; a third would
     -- reintroduce the bug with nothing to catch it.
     --
     -- With this, a tombstoned row is immune to upserts until the delete
     -- completes and the row is gone for real.
     WHERE local_sessions.deleted_at IS NULL`,
    s.id,
    userID,
    s.workout_id,
    s.sport,
    s.name,
    s.started_at,
    s.ended_at,
    s.notes ?? '',
    JSON.stringify(s.sets ?? []),
    dirty ? 1 : 0,
    remote ? 1 : 0,
    new Date().toISOString(),
  );
}

/** Starts a session locally. Returns immediately — no network involved. */
export async function startLocalSession(
  userID: string,
  input: { sport: string; name: string; workout_id?: string | null; sets?: LoggedSet[] },
): Promise<LocalSession> {
  const session: LocalSession = {
    id: randomUUID(),
    user_id: userID,
    workout_id: input.workout_id ?? null,
    sport: input.sport,
    name: input.name,
    started_at: new Date().toISOString(),
    ended_at: null,
    notes: '',
    sets: input.sets ?? [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dirty: true,
  };
  // Not remote yet — nothing has been pushed.
  await upsert(session, userID, true, false);
  return session;
}

export async function readLocalSession(
  userID: string,
  id: string,
): Promise<LocalSession | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>(
    `SELECT * FROM local_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    id,
    userID,
  );
  return row ? toSession(row) : null;
}

export async function listLocalSessions(userID: string, limit = 20): Promise<LocalSession[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT * FROM local_sessions
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY started_at DESC LIMIT ?`,
    userID,
    limit,
  );
  return rows.map(toSession);
}

/** Every local edit lands here: write, mark dirty, return. */
export async function saveLocalSets(
  userID: string,
  id: string,
  sets: LoggedSet[],
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE local_sessions SET sets_json = ?, dirty = 1, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    JSON.stringify(sets),
    new Date().toISOString(),
    id,
    userID,
  );
}

export async function finishLocalSession(userID: string, id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE local_sessions SET ended_at = ?, dirty = 1, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    new Date().toISOString(),
    new Date().toISOString(),
    id,
    userID,
  );
}

/**
 * Delete a session — as a tombstone, not a hard delete.
 *
 * Hard-deleting the row is what made an offline delete undo itself. The row
 * vanished locally, the server still held it, and the next pull fetched it
 * straight back. Worse: with the row gone there was nothing left carrying
 * "this needs deleting", so the intent was lost the moment the fire-and-forget
 * `DELETE /v1/sessions/{id}` failed — which, offline, it always does.
 *
 * So the row stays, marked and dirty, and the ordinary push path carries the
 * delete out whenever the network allows. Reads filter tombstones, so it is
 * invisible from the moment the athlete taps Delete.
 *
 * **Always a tombstone — this does not decide whether the server knows.**
 *
 * It used to: `remote = 0` meant "never pushed, nothing to tell the server",
 * so the row was hard-deleted outright. That read is racy. A first push sets
 * `remote = 1` partway through `pushRow`, so deleting during that window sees
 * `remote = 0`, hard-deletes locally — and then the push it was racing
 * *creates the session on the server*. Local row gone, server row created,
 * next pull brings it back. The exact resurrection this whole feature exists
 * to prevent, reintroduced by the optimisation meant to avoid a pointless
 * outbox entry.
 *
 * So the decision moves to `pushRow`, which reads the row inside the
 * serialised sync and can act on what is true *then*. A never-pushed
 * tombstone costs one sync cycle and needs no network, so it clears on the
 * next attempt whether online or not.
 *
 * The interleaving is safe because the tombstone bumps `updated_at`: a push
 * already in flight finds its CAS
 * (`UPDATE ... SET dirty = 0 ... AND updated_at = ?`) no longer matches, so
 * the row stays dirty and the *next* pass sees the tombstone with `remote`
 * now correctly 1.
 */
export async function deleteLocalSession(userID: string, id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE local_sessions SET deleted_at = ?, dirty = 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    now,
    now,
    id,
    userID,
  );
}

/** Ids this device has deleted but the server hasn't been told about yet. */
export async function tombstonedIDs(userID: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM local_sessions WHERE user_id = ? AND deleted_at IS NOT NULL`,
    userID,
  );
  return new Set(rows.map((r) => r.id));
}

export async function countPendingSessions(userID: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM local_sessions WHERE user_id = ? AND dirty = 1`,
    userID,
  );
  return row?.n ?? 0;
}

/**
 * Pushes one session and clears its dirty flag. Nothing else.
 *
 * This exists because the session screen called `syncSessions` on every
 * save, and `syncSessions` is a *full reconciliation*: it pushes every dirty
 * session at 2–3 requests each, then pulls the last twenty. One tick of a
 * set therefore cost `3 × dirty + 1` requests, every debounced keystroke did
 * the same, and any session that could never push stayed dirty and was
 * retried on all of them — a request storm that grew with your history
 * rather than with what you were doing.
 *
 * Editing a session should talk about that session. Reconciliation belongs
 * on screen focus, where it happens once.
 */
export async function pushSession(
  userID: string,
  id: string,
  getToken: TokenGetter,
): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>(
    `SELECT * FROM local_sessions WHERE id = ? AND user_id = ? AND dirty = 1`,
    id,
    userID,
  );
  if (row) await pushRow(db, row, userID, getToken);
}

/**
 * Pushes one row's state to the server and clears its dirty flag.
 *
 * Shared by `pushSession` and `syncSessions` rather than written twice: the
 * ordering, the idempotency assumptions and the compare-and-swap below are
 * all load-bearing, and two copies of that would drift.
 */
async function pushRow(
  db: SQLite.SQLiteDatabase,
  row: Row,
  userID: string,
  getToken: TokenGetter,
): Promise<void> {
  // A tombstone is a delete, not an update — carry it out and drop the row.
  //
  // A 404 counts as success: the server agreeing it isn't there is precisely
  // the state we were asking for. Without that, a session deleted twice (or
  // deleted on the web first) would keep a tombstone forever, so `pending`
  // never reached 0 and the retry ladder ground on for the life of the
  // install.
  if (row.deleted_at) {
    // Never reached the server, so there is nothing to tell it. Decided HERE
    // rather than at delete time because `remote` is only trustworthy inside
    // the serialised sync — see deleteLocalSession.
    if (row.remote === 0) {
      await db.runAsync(`DELETE FROM local_sessions WHERE id = ? AND user_id = ?`, row.id, userID);
      return;
    }

    try {
      await deleteSession(getToken, row.id);
    } catch (err) {
      // A 404 is success: the server agreeing it isn't there is the state
      // being asked for. Without this, deleting twice — or deleting on the
      // web first — leaves a tombstone that can never clear.
      if (isNotFound(err)) {
        // fall through to the local delete
      } else if (isPermanentRejection(err)) {
        // The server will refuse this identically forever. Leaving the
        // tombstone would hide the session for the life of the install while
        // `pending` stayed above zero and every foreground retried a doomed
        // request — the failure PR2 fixed for updates and did not apply here.
        //
        // So restore the row. The session was NOT deleted, and continuing to
        // hide it would be a lie about what the server holds. Rethrown so the
        // sync reports it rather than swallowing a delete that silently
        // didn't happen.
        // `dirty = 0` is a small lie in one edge case: unsynced SET edits made
        // before the delete are marked clean and will not push. Accepted
        // because this branch is near-unreachable for a DELETE (404 is
        // success, 401/408/429 retry, and the id is a client UUID so there is
        // no validation failure to hit) and because the alternative — leaving
        // it dirty — re-pushes a session the server just refused to let us
        // touch. Worth knowing rather than discovering.
        await db.runAsync(
          `UPDATE local_sessions SET deleted_at = NULL, dirty = 0 WHERE id = ? AND user_id = ?`,
          row.id,
          userID,
        );
        throw err;
      } else {
        // Transient — the row stays dirty and goes out with the next sync.
        throw err;
      }
    }
    await db.runAsync(`DELETE FROM local_sessions WHERE id = ? AND user_id = ?`, row.id, userID);
    return;
  }

  // Not `toSession`, which papers over a corrupt blob with an empty list.
  // `pushSets` *replaces* the server's list, so pushing that empty array
  // would turn a local read failure into permanent remote deletion.
  const sets = parseSets(row.sets_json);
  if (sets === null) throw new Error('This session is corrupted on this device and was not synced.');

  const s = toSession(row);
  let remote = row.remote === 1;

  // Only until the server has acknowledged it. The create is idempotent, so
  // repeating it was harmless — but it doubled the cost of every keystroke
  // and made the server re-validate the workout template each time.
  if (!remote) {
    await pushCreate(getToken, {
      id: s.id,
      sport: s.sport,
      name: s.name,
      workout_id: s.workout_id,
      started_at: s.started_at,
      sets,
    });
    remote = true;
    await db.runAsync(`UPDATE local_sessions SET remote = 1 WHERE id = ? AND user_id = ?`, s.id, userID);
  }

  try {
    // Always, even straight after a create: `POST /v1/sessions` ignores the
    // sets in the body on a replay, so they need their own call regardless.
    await pushSets(getToken, s.id, sets);
  } catch (err) {
    // The session was deleted on another device. Forget that it's remote so
    // the next attempt recreates it — the device actively logging holds the
    // live copy, and dropping the sets to honour a delete made elsewhere
    // would lose work that only exists here.
    if (err instanceof ApiError && err.status === 404) {
      await db.runAsync(`UPDATE local_sessions SET remote = 0 WHERE id = ? AND user_id = ?`, s.id, userID);
    }
    throw err;
  }
  if (s.ended_at) await pushFinish(getToken, s.id, s.ended_at);

  await db.runAsync(
    `UPDATE local_sessions SET dirty = 0 WHERE id = ? AND user_id = ?
     -- Only if nothing changed underneath us mid-push, or we'd mark a newer
     -- edit as already sent and silently drop it.
     AND updated_at = ?`,
    s.id,
    userID,
    row.updated_at,
  );
}

/**
 * How a sync failed, classified where the error object still exists.
 *
 * `error` is a display string, and a display string is all it is — the API
 * conventions are explicit that codes are contract and messages are not.
 * Classifying by pattern-matching that string (the orchestrator briefly did,
 * on `/reach VOLA/`) is the exact thing `apiError.ts` warns against: it
 * survives a server rewording but breaks the moment someone edits our own UI
 * copy, and it breaks *silently, inverted*.
 *
 * - `offline` — never reached the server. Retrying is the whole plan.
 * - `permanent` — the server answered and will answer the same way forever
 *   (a 404, a 409, a validation error). Retrying is pointless, and retrying
 *   forever is what made a single refused row cost 2-3 doomed requests per
 *   foreground for the life of the install.
 * - `transient` — anything else worth another go.
 *
 * Worst-case wins, not last-row-wins: with several failing rows the old code
 * kept the final row's message, so an offline failure followed by a
 * validation error classified as online.
 */
export type SyncErrorKind = 'offline' | 'permanent' | 'transient';

export type SessionSyncResult = {
  pushed: number;
  pulled: number;
  failed: number;
  error?: string;
  errorKind?: SyncErrorKind;
};

/**
 * Keep the most actionable classification seen this run.
 *
 * `offline` outranks the rest: if we couldn't reach the server at all, that is
 * the fact worth acting on, whatever else also went wrong.
 */
function worseKind(a: SyncErrorKind | undefined, b: SyncErrorKind): SyncErrorKind {
  if (a === 'offline' || b === 'offline') return 'offline';
  if (a === 'permanent' || b === 'permanent') return 'permanent';
  return 'transient';
}

function classify(err: unknown): SyncErrorKind {
  if (isOffline(err)) return 'offline';
  if (isPermanentRejection(err)) return 'permanent';
  return 'transient';
}

/**
 * Reconciles local and remote.
 *
 * Push first, then pull. The order is not incidental: pulling first would
 * overwrite unsynced local work with the server's older copy — the exact
 * data loss the offline store exists to prevent.
 *
 * A dirty session is pushed as create-then-replace rather than one call.
 * `POST /v1/sessions` is idempotent on the ID, but on a replay it returns
 * the *existing* row and ignores the sets in the body — correct for its own
 * purposes, and precisely why the sets need their own PUT behind it. Two
 * requests, and both are safe to repeat.
 */
/**
 * One sync at a time, process-wide.
 *
 * **`lib/sync.ts` is the only permitted caller** — it owns when sync happens.
 * This inner queue predates it and is kept as a backstop, but it is exactly
 * the kind of safety net that would silently rescue a new direct caller and
 * let the seven-scattered-call-sites problem creep back unnoticed. If you are
 * about to call this from a screen: don't, call `request()` instead.
 *
 * Callers keep their fire-and-forget shape — a queued run resolves with the
 * result of the run that actually happened for it.
 */
let syncInFlight: Promise<SessionSyncResult> | null = null;

export function syncSessions(
  userID: string,
  getToken: TokenGetter,
): Promise<SessionSyncResult> {
  const run = (syncInFlight ?? Promise.resolve(null)).catch(() => null).then(() =>
    runSync(userID, getToken),
  );
  syncInFlight = run.catch(
    () => ({ pushed: 0, pulled: 0, failed: 0 }) as SessionSyncResult,
  );
  return run;
}

async function runSync(
  userID: string,
  getToken: TokenGetter,
): Promise<SessionSyncResult> {
  const db = await getDb();
  const result: SessionSyncResult = { pushed: 0, pulled: 0, failed: 0 };

  const dirty = await db.getAllAsync<Row>(
    `SELECT * FROM local_sessions WHERE user_id = ? AND dirty = 1 ORDER BY started_at`,
    userID,
  );

  for (const row of dirty) {
    try {
      await pushRow(db, row, userID, getToken);
      result.pushed++;
    } catch (err) {
      result.failed++;
      result.error = err instanceof Error ? err.message : String(err);
      result.errorKind = worseKind(result.errorKind, classify(err));
    }
  }

  // Pull only what we don't hold dirty — the server is authoritative for
  // everything the device isn't currently editing.
  //
  // `remote` is a snapshot from *before* the loop, and the local row can move
  // underneath us between the fetch and the check. That is not hypothetical:
  // adding an exercise mid-session fires one sync from the picker and another
  // from the session screen's refocus, so two runs overlap by construction.
  // The sequence that bit an athlete:
  //
  //   run A: pullSessions() -> snapshot WITHOUT the new exercise
  //   picker: writes the new exercise locally, dirty = 1
  //   run B: pushes it, sets dirty = 0
  //   run A: reads dirty = 0, upserts its stale snapshot -> exercise gone
  //   later: another pull brings it back
  //
  // Which is exactly "apparently the exercise was added but would just load
  // without my intervention". The push side already guards against its own
  // version of this with a CAS on `updated_at`; the pull side had nothing.
  //
  // NOTE: an earlier commit on this branch claimed the cause was a stale
  // debounce racing the picker, and "fixed" it by flushing before navigating.
  // That was wrong — both entry points already flushed — and the wrong
  // diagnosis is recorded here so it is not re-derived.
  try {
    const remote = await pullSessions(getToken, { limit: 20 });
    // Ids this device has deleted but hasn't managed to tell the server about.
    // The server still lists them, so without this the pull writes each one
    // straight back — the exact resurrection tombstones exist to stop. Read
    // once per run rather than per row.
    const buried = await tombstonedIDs(userID);
    for (const r of remote) {
      if (buried.has(r.id)) continue;
      const local = await db.getFirstAsync<{ dirty: number; updated_at: string }>(
        `SELECT dirty, updated_at FROM local_sessions WHERE id = ? AND user_id = ?`,
        r.id,
        userID,
      );
      if (local?.dirty === 1) continue;
      // Refuse to go backwards. If the local row is newer than the copy we
      // fetched, this snapshot is stale and writing it would erase whatever
      // landed in between.
      if (local && local.updated_at > r.updated_at) continue;
      await upsert({ ...r, dirty: false }, userID, false, true);
      result.pulled++;
    }
  } catch (err) {
    if (result.failed === 0) {
      result.failed++;
      result.error = err instanceof Error ? err.message : String(err);
    }
    // Classified even when a push already failed: the kinds combine, and the
    // pull failing offline is worth knowing regardless of what the push hit.
    result.errorKind = worseKind(result.errorKind, classify(err));
  }

  return result;
}

/**
 * Fetches one session from the server into the local store, for a session
 * this device has never seen — started on the web, say. A no-op offline.
 */
export async function hydrateSession(
  userID: string,
  id: string,
  getToken: TokenGetter,
): Promise<LocalSession | null> {
  // Never hydrate something this device has deleted.
  //
  // `readLocalSession` filters tombstones, so a screen opened on a deleted id
  // finds nothing locally and falls through to here — which would fetch the
  // server's copy and upsert it with `dirty = 0`. The row would stay hidden
  // (reads filter it), but the tombstone would no longer be dirty, so the
  // push would never carry the delete out. A delete that silently never
  // happens is worse than one that visibly fails.
  const db = await getDb();
  const buried = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM local_sessions
     WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
    id,
    userID,
  );
  if (buried) return null;

  try {
    const { session } = await pullSession(getToken, id);
    await upsert({ ...session, dirty: false }, userID, false, true);
    return { ...session, dirty: false };
  } catch {
    return null;
  }
}

// --- plan cache -----------------------------------------------------------

/**
 * Workouts are cached per user because they *are* the offline plan. Caching
 * the catalog but not the templates left the start screen claiming you had
 * no workouts — a lie told at the exact moment you're standing in a gym.
 */
export async function cacheWorkouts(userID: string, list: Workout[]): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    for (const w of list) {
      await db.runAsync(
        `INSERT INTO workout_cache (id, user_id, sport, name, goal, items_json, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sport = excluded.sport, name = excluded.name, goal = excluded.goal,
           items_json = excluded.items_json, cached_at = excluded.cached_at`,
        w.id,
        userID,
        w.sport,
        w.name,
        w.goal,
        JSON.stringify(w.items ?? []),
        now,
      );
    }
  });
}

export async function cachedWorkouts(userID: string, sport: string): Promise<Workout[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    sport: string;
    name: string;
    goal: string | null;
    items_json: string;
  }>(`SELECT * FROM workout_cache WHERE user_id = ? AND sport = ? ORDER BY name`, userID, sport);

  return rows.map((r) => {
    let items: WorkoutItem[] = [];
    try {
      items = JSON.parse(r.items_json) as WorkoutItem[];
    } catch {
      items = [];
    }
    return {
      id: r.id,
      owner_user_id: userID,
      name: r.name,
      sport: r.sport as Workout['sport'],
      // Cached alongside the plan since schema v6. It decides the rep range
      // the progression rule works inside, and a null here would start an
      // offline session on a different range than the session screen uses.
      goal: r.goal as Workout['goal'],
      notes: '',
      visibility: 'private' as const,
      items,
      created_at: '',
      updated_at: '',
    };
  });
}

// --- catalog cache --------------------------------------------------------

/**
 * The catalog cache is what makes a session *readable* offline. Without it
 * the screen has set rows and no idea what exercise they belong to, which
 * measures to render, or what to call them — a log you can write but not
 * read isn't offline support.
 */
export async function cacheExercises(list: Exercise[]): Promise<void> {
  if (list.length === 0) return;
  const db = await getDb();
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    for (const e of list) {
      await db.runAsync(
        `INSERT INTO exercise_cache
           (id, sport, name, movement_pattern, load_type, is_unilateral, thumbnail_url, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sport = excluded.sport, name = excluded.name,
           movement_pattern = excluded.movement_pattern,
           load_type = excluded.load_type,
           is_unilateral = excluded.is_unilateral,
           thumbnail_url = excluded.thumbnail_url,
           cached_at = excluded.cached_at`,
        e.id,
        e.sport,
        e.name,
        e.movement_pattern,
        e.load_type,
        e.is_unilateral ? 1 : 0,
        e.media.find((m) => m.kind === 'thumbnail' && m.url)?.url ?? null,
        now,
      );
    }
  });
}

/** Reads the cache back in the shape the screens already expect. */
/**
 * The cached catalog, optionally narrowed to one discipline.
 *
 * Omitting the sport returns everything cached — what the records view needs,
 * since a shortlist can span disciplines and it only wants names.
 */
export async function cachedExercises(sport?: string): Promise<Exercise[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    sport: string;
    name: string;
    movement_pattern: string;
    load_type: string;
    is_unilateral: number;
    thumbnail_url: string | null;
  }>(
    sport
      ? `SELECT * FROM exercise_cache WHERE sport = ? ORDER BY name`
      : `SELECT * FROM exercise_cache ORDER BY name`,
    ...(sport ? [sport] : []),
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sport: r.sport,
    movement_pattern: r.movement_pattern,
    movement_pattern_detail: '',
    primary_muscles: [],
    secondary_muscles: [],
    equipment: [],
    load_type: r.load_type as Exercise['load_type'],
    is_unilateral: r.is_unilateral === 1,
    instructions: '',
    media: r.thumbnail_url
      ? [
          {
            kind: 'thumbnail' as const,
            storage_key: '',
            url: r.thumbnail_url,
            content_type: '',
            width: null,
            height: null,
            position: 0,
            is_default: false,
          },
        ]
      : [],
  }));
}
