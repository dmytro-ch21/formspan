import { randomUUID } from 'expo-crypto';
import type { TokenGetter } from './useAuthToken';
import type * as SQLite from 'expo-sqlite';

import { ApiError, isNotFound, isOffline, isPermanentRejection } from './apiError';
import { getDb } from './db';
import type { Exercise } from './exercises';
import type { Workout, WorkoutItem } from './workouts';
import {
  createWorkout,
  deleteWorkout,
  renameWorkout,
  replaceItems,
} from './workouts';
import {
  finishSession as pushFinish,
  getSession as pullSession,
  deleteSession,
  listSessions as pullSessions,
  replaceSets as pushSets,
  renameSession as pushRename,
  startSession as pushCreate,
  type LoggedSet,
  type Session,
} from './sessions';
import { putDetail as pushBjjDetail, type SessionDetail as BjjDetail } from './bjjSession';

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
  /**
   * The BJJ reflection, or NULL for every other sport. See the v12 note in
   * `db.ts` — NULL is what tells the push path to skip the detail call
   * entirely rather than send an empty one.
   */
  bjj_json: string | null;
  dirty: number;
  /** 1 while this row's name has not reached the server. */
  name_dirty: number;
  remote: number;
  /** Set once the athlete deleted it; the row survives until the server agrees. */
  deleted_at: string | null;
  updated_at: string;
};

/**
 * Parsed BJJ reflection, or `null` if the blob is unreadable.
 *
 * Unreadable is survivable here in a way it is not for sets: the session, its
 * timing and its RPE-driven load have already been pushed, so dropping a
 * corrupt reflection costs the tags, not the training record. The push path
 * therefore skips it rather than failing the whole row.
 */
function parseBjjDetail(json: string): BjjDetail | null {
  try {
    const d = JSON.parse(json) as BjjDetail;
    // Tags absent from an older blob must read as "none recorded", not as a
    // crash in the push path.
    return { ...d, tags: d.tags ?? [] };
  } catch {
    return null;
  }
}

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
  input: {
    sport: string;
    name: string;
    workout_id?: string | null;
    sets?: LoggedSet[];
    /**
     * When it actually happened, for a session recorded after the fact.
     *
     * Retroactive logging is first-class rather than an edge case: most BJJ
     * sessions get written down that evening, and the design that assumes
     * "now" is when training started makes every one of them wrong. Defaults
     * to now, so the live strength flow is unchanged.
     */
    started_at?: string;
    /**
     * Set when the session is already over at the moment it is created —
     * a reflection log rather than a live one.
     *
     * Not cosmetic: training history derives every duration from
     * `ended_at - started_at`, so a session created without one contributes
     * nothing to mat time no matter how long it really was.
     */
    ended_at?: string | null;
  },
): Promise<LocalSession> {
  const session: LocalSession = {
    id: randomUUID(),
    user_id: userID,
    workout_id: input.workout_id ?? null,
    sport: input.sport as Workout['sport'],
    name: input.name,
    started_at: input.started_at ?? new Date().toISOString(),
    ended_at: input.ended_at ?? null,
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
 * Store the BJJ reflection locally and mark the session for push.
 *
 * The same shape as `saveLocalSets`, deliberately: written locally first,
 * pushed by the ordinary outbox, replaced wholesale rather than merged. A
 * reflection filled in on the mat with no signal is the normal case, not the
 * edge case — the design doc puts reflection within ~20 minutes of stepping
 * off the mat, which is exactly where the signal is worst.
 */
export async function saveLocalBjjDetail(
  userID: string,
  id: string,
  detail: BjjDetail,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE local_sessions SET bjj_json = ?, dirty = 1, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    JSON.stringify(detail),
    new Date().toISOString(),
    id,
    userID,
  );
}

/**
 * Rename a session.
 *
 * BJJ sessions are named from their kind ("Class", "Rolling"), which is right
 * as a default and wrong the moment it was actually a seminar, an open mat or
 * a competition class. Marks the row dirty so the outbox carries it — the name
 * is part of the session the server already stores, so this needs no new
 * endpoint.
 *
 * Trimmed, and an empty result is refused rather than written: a session with
 * a blank name renders as a gap in the history list with nothing to tap on.
 */
export async function renameLocalSession(
  userID: string,
  id: string,
  name: string,
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const db = await getDb();
  await db.runAsync(
    `UPDATE local_sessions SET name = ?, dirty = 1, name_dirty = 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    trimmed,
    new Date().toISOString(),
    id,
    userID,
  );
  return true;
}

/**
 * The locally-held reflection for a session, or null if there isn't one.
 *
 * Read from SQLite rather than the API so a session opened offline still
 * shows what was logged — the reflection is the thing most likely to have
 * been written offline in the first place.
 */
export async function readLocalBjjDetail(
  userID: string,
  id: string,
): Promise<BjjDetail | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ bjj_json: string | null }>(
    `SELECT bjj_json FROM local_sessions
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    id,
    userID,
  );
  if (!row?.bjj_json) return null;
  return parseBjjDetail(row.bjj_json);
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
  if (!row) return;
  // The same deferral `syncSessions` applies, and it has to be here too.
  //
  // This runs on every debounced save from the session screen, so it is the
  // path an athlete actually hits: create a workout offline, start a session
  // from it, walk into signal, tick a set before the orchestrator's run
  // finishes. Without this the create goes out with a workout_id the server
  // has never seen, is refused 400, classifies as PERMANENT — and the screen
  // shows a fatal-looking error and files a `sync_blocked` operator report,
  // mid-workout, for a row that would have healed itself on the next run.
  if (row.workout_id) {
    const unsynced = await unsyncedWorkoutIDs(userID);
    if (unsynced.has(row.workout_id)) return;
  }
  await pushRow(db, row, userID, getToken);
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
  // Captured BEFORE the create flips `remote`, because the create already
  // carries the name — re-sending it would add a wasted round trip to the
  // one path that is already two.
  const wasRemote = remote;

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
      // Sent on the create, not left to the finish call below.
      //
      // A session that was already over when it was first pushed — every BJJ
      // reflection log — must land complete in one request. Relying on the
      // follow-up finish meant anything that could fail in between took the
      // session's duration with it, and since history derives all duration
      // from `ended_at - started_at`, "no duration" means the session counts
      // for nothing. The optional reflection could therefore cost the
      // mandatory floor its mat time, which inverts the whole point of the
      // floor being independent.
      ended_at: s.ended_at,
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

  // Before the reflection, deliberately. The finish is what the session's
  // duration depends on; the reflection is optional. Ordered the other way
  // round, a permanently-refused reflection (a 400 from a retired technique
  // id, say) throws before this line is ever reached and the session is left
  // with no `ended_at` at all — the optional half silently costing the
  // mandatory one. Redundant now that the create carries `ended_at` too,
  // and kept because two independent guarantees is the right number for the
  // one field that decides whether a session counts.
  if (s.ended_at) await pushFinish(getToken, s.id, s.ended_at);

  // The BJJ half, if this is one. After the session exists server-side,
  // same as the sets push and for the same reason: the server rejects it
  // with a 404 until it does.
  //
  // NULL means "not a BJJ session" and skips the call entirely — which is
  // why the column is nullable rather than defaulted to an empty object.
  if (row.bjj_json) {
    const detail = parseBjjDetail(row.bjj_json);
    // A corrupt blob is not a reason to fail the whole push: the session and
    // its timing have already landed and are worth keeping. Same posture as
    // the catalog's pre-v10 rows — degrade, don't discard.
    if (detail !== null) {
      try {
        await pushBjjDetail(getToken, s.id, detail);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          await db.runAsync(
            `UPDATE local_sessions SET remote = 0 WHERE id = ? AND user_id = ?`,
            s.id,
            userID,
          );
        }
        throw err;
      }
    }
  }

  // The name, LAST, and only when it actually changed.
  //
  // `POST /v1/sessions` is ON CONFLICT DO NOTHING, so a replayed create does
  // not carry a later rename — without this the phone renamed locally, marked
  // the row clean, and the change never left the device.
  //
  // Ordered after the reflection for the same reason the finish is ordered
  // before it: the server bounds the name at 120 characters and rejects a
  // longer one PERMANENTLY. Sent first, that 400 aborted the row before the
  // reflection ever went out, and every retry replayed the same doomed
  // request — one over-long name stranding a session's evidence forever.
  // Last means the worst case costs only the name.
  if (wasRemote && row.name_dirty === 1) {
    await pushRename(getToken, s.id, s.name);
    await db.runAsync(
      `UPDATE local_sessions SET name_dirty = 0 WHERE id = ? AND user_id = ?`,
      s.id,
      userID,
    );
  }

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
  /**
   * Rows held back because something they depend on has not synced yet.
   *
   * Counted apart from `failed` on purpose. A session whose workout has not
   * reached the server is *waiting*, and calling that a failure would both
   * alarm the athlete and — since the FK error is a 4xx, and 4xx classifies
   * as permanent — make the orchestrator give up retrying it.
   */
  deferred: number;
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
 * Record — or clear — why one row could not sync.
 *
 * Only PERMANENT rejections are stored. A transient failure is the ordinary
 * state of a phone in a basement, and writing "Network request failed" onto
 * every row would turn a repair list into a list of everything you have ever
 * logged offline. What belongs here is the row the server will refuse
 * forever, which is the only kind a person can act on.
 *
 * Cleared on success, so a row that was refused and later accepted (the
 * server was fixed, the workout it referenced finally landed) stops being
 * reported as broken.
 */
async function noteRowError(
  db: SQLite.SQLiteDatabase,
  table: 'local_sessions' | 'workout_cache',
  id: string,
  userID: string,
  err: unknown,
): Promise<void> {
  if (err !== null && !isPermanentRejection(err)) return;
  const message = err === null ? null : err instanceof Error ? err.message : String(err);
  // The table name is interpolated, never the values: it comes from this
  // function's own literal union, so there is no path from user input to it.
  await db.runAsync(
    `UPDATE ${table} SET last_error = ? WHERE id = ? AND user_id = ?`,
    message,
    id,
    userID,
  );
}

/** A row the server has refused, with what it said. */
export type BlockedRow = {
  kind: 'session' | 'workout';
  id: string;
  name: string;
  lastError: string;
};

/**
 * Everything that cannot sync and needs a person.
 *
 * Deliberately not merged into `pending`: these are rows that will never
 * clear on their own, so counting them as "waiting" would be a lie that
 * never resolves.
 */
export async function blockedRows(userID: string): Promise<BlockedRow[]> {
  const db = await getDb();
  const sessions = await db.getAllAsync<{ id: string; name: string; last_error: string }>(
    `SELECT id, name, last_error FROM local_sessions
      WHERE user_id = ? AND last_error IS NOT NULL AND dirty = 1
      ORDER BY started_at DESC`,
    userID,
  );
  const workouts = await db.getAllAsync<{ id: string; name: string; last_error: string }>(
    `SELECT id, name, last_error FROM workout_cache
      WHERE user_id = ? AND last_error IS NOT NULL AND dirty = 1
      ORDER BY name`,
    userID,
  );
  return [
    ...sessions.map((r) => ({
      kind: 'session' as const, id: r.id, name: r.name, lastError: r.last_error,
    })),
    ...workouts.map((r) => ({
      kind: 'workout' as const, id: r.id, name: r.name, lastError: r.last_error,
    })),
  ];
}

/**
 * Try one blocked row again.
 *
 * Clears the recorded error FIRST. Otherwise a row that now succeeds would
 * keep its old message until a full sync happened to touch it, and the repair
 * screen would report a fixed row as still broken.
 */
export async function retryBlockedRow(
  userID: string,
  row: BlockedRow,
  getToken: TokenGetter,
): Promise<void> {
  const db = await getDb();
  const table = row.kind === 'session' ? 'local_sessions' : 'workout_cache';
  await noteRowError(db, table, row.id, userID, null);
  if (row.kind === 'session') {
    await pushSession(userID, row.id, getToken);
    return;
  }
  const w = await db.getFirstAsync<WorkoutRow>(
    `SELECT * FROM workout_cache WHERE id = ? AND user_id = ?`,
    row.id,
    userID,
  );
  if (w) await pushWorkoutRow(db, w, userID, getToken);
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
    () => ({ pushed: 0, pulled: 0, failed: 0, deferred: 0 }) as SessionSyncResult,
  );
  return run;
}

async function runSync(
  userID: string,
  getToken: TokenGetter,
): Promise<SessionSyncResult> {
  const db = await getDb();
  const result: SessionSyncResult = { pushed: 0, pulled: 0, failed: 0, deferred: 0 };

  const dirty = await db.getAllAsync<Row>(
    `SELECT * FROM local_sessions WHERE user_id = ? AND dirty = 1 ORDER BY started_at`,
    userID,
  );

  // WORKOUTS FIRST, and not merely as a preference.
  //
  // sessions.workout_id is a real FK server-side, so a session referencing a
  // workout the server has never seen is refused — and a 4xx classifies as
  // `permanent`, which would make the orchestrator stop retrying training
  // that is perfectly fine and report it as doomed. So the order is load
  // bearing, and so is the deferral below.
  const dirtyWorkouts = await db.getAllAsync<WorkoutRow>(
    `SELECT * FROM workout_cache WHERE user_id = ? AND ${workoutOwed} ORDER BY updated_at`,
    userID,
  );
  for (const w of dirtyWorkouts) {
    try {
      await pushWorkoutRow(db, w, userID, getToken);
      result.pushed++;
      await noteRowError(db, 'workout_cache', w.id, userID, null);
    } catch (err) {
      result.failed++;
      result.error = err instanceof Error ? err.message : String(err);
      result.errorKind = worseKind(result.errorKind, classify(err));
      await noteRowError(db, 'workout_cache', w.id, userID, err);
    }
  }

  // Whatever the server still has not acknowledged AFTER that attempt. A
  // session pointing at one of these is waiting on a dependency, not broken.
  const unsynced = await unsyncedWorkoutIDs(userID);

  for (const row of dirty) {
    // Held back, and deliberately NOT counted as a failure: reporting it
    // would tell the athlete their training failed to sync when the only
    // thing wrong is that its plan has not landed yet. It stays dirty and
    // goes out on the next pass, which is what `pending` already means.
    if (row.workout_id && unsynced.has(row.workout_id)) {
      result.deferred++;
      continue;
    }
    try {
      await pushRow(db, row, userID, getToken);
      result.pushed++;
      await noteRowError(db, 'local_sessions', row.id, userID, null);
    } catch (err) {
      result.failed++;
      result.error = err instanceof Error ? err.message : String(err);
      result.errorKind = worseKind(result.errorKind, classify(err));
      await noteRowError(db, 'local_sessions', row.id, userID, err);
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
    // RECONCILE, don't just accumulate.
    //
    // This only ever upserted, and nothing anywhere deleted from the table —
    // so a workout deleted on this phone or on the web stayed cached forever.
    // With the Plan tab now reading the cache first, that means the deleted
    // template flashes back on every tab focus until the network answers, and
    // offline it is simply listed as still existing, dead-ending on tap.
    //
    // Safe because both callers pass the COMPLETE `mine` list: anything of
    // this athlete's not in it no longer exists.
    const keep = list.map((w) => w.id);
    await db.runAsync(
      `DELETE FROM workout_cache
       WHERE user_id = ?
         AND id NOT IN (${keep.map(() => '?').join(',') || "''"})
         -- Absent from the server list is only evidence of deletion for rows
         -- the server KNOWS about. A workout created here and not yet pushed
         -- is absent because the server has never heard of it -- reconciling
         -- it away would silently destroy the athlete's new plan. Same for a
         -- pending local edit or delete.
         AND dirty = 0 AND remote = 1 AND deleted_at IS NULL`,
      userID,
      ...keep,
    );

    for (const w of list) {
      await db.runAsync(
        `INSERT INTO workout_cache
           (id, user_id, sport, name, goal, items_json, owner_user_id, visibility, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sport = excluded.sport, name = excluded.name, goal = excluded.goal,
           items_json = excluded.items_json, cached_at = excluded.cached_at,
           owner_user_id = excluded.owner_user_id, visibility = excluded.visibility
         -- Never write over a local edit or a tombstone. Rows arriving here
         -- come FROM the server, so they are by definition older than
         -- anything this device has not pushed yet. Same backstop shape as
         -- local_sessions, and for the same reason: the pull skips these
         -- rows anyway, but relying on every caller to remember is how the
         -- session store nearly lost a delete.
         WHERE workout_cache.dirty = 0 AND workout_cache.name_dirty = 0
           AND workout_cache.deleted_at IS NULL`,
        w.id,
        userID,
        w.sport,
        w.name,
        w.goal,
        JSON.stringify(w.items ?? []),
        // Stored as the server reports them. A VOLA template has no owner,
        // and `canEdit` keys off exactly this — see the column comment.
        w.owner_user_id,
        w.visibility,
        now,
      );
    }
  });
}

/**
 * Cached workouts, optionally narrowed to one discipline.
 *
 * Omitting the sport returns everything cached for this athlete — what the
 * Plan tab needs, since it lists across disciplines. Same shape as
 * `cachedExercises`.
 */
export async function cachedWorkouts(userID: string, sport?: string): Promise<Workout[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    sport: string;
    name: string;
    goal: string | null;
    items_json: string;
    owner_user_id: string | null;
    visibility: string;
  }>(
    sport
      ? `SELECT * FROM workout_cache
           WHERE user_id = ? AND sport = ? AND deleted_at IS NULL ORDER BY name`
      : `SELECT * FROM workout_cache
           WHERE user_id = ? AND deleted_at IS NULL ORDER BY name`,
    ...(sport ? [userID, sport] : [userID]),
  );

  return rows.map((r) => {
    let items: WorkoutItem[] = [];
    try {
      items = JSON.parse(r.items_json) as WorkoutItem[];
    } catch {
      items = [];
    }
    return {
      id: r.id,
      // The truth, not `userID`. Hardcoding the reader's own id here made
      // every cached workout look editable offline — including VOLA's
      // ownerless templates and other athletes' public ones — because
      // `workout/[id].tsx` derives `canEdit` from this field.
      owner_user_id: r.owner_user_id,
      name: r.name,
      sport: r.sport as Workout['sport'],
      // Cached alongside the plan since schema v6. It decides the rep range
      // the progression rule works inside, and a null here would start an
      // offline session on a different range than the session screen uses.
      goal: r.goal as Workout['goal'],
      notes: '',
      visibility: r.visibility as Workout['visibility'],
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
           (id, sport, name, movement_pattern, load_type, is_unilateral, thumbnail_url,
            payload_json, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sport = excluded.sport, name = excluded.name,
           movement_pattern = excluded.movement_pattern,
           load_type = excluded.load_type,
           is_unilateral = excluded.is_unilateral,
           thumbnail_url = excluded.thumbnail_url,
           payload_json = excluded.payload_json,
           cached_at = excluded.cached_at`,
        e.id,
        e.sport,
        e.name,
        e.movement_pattern,
        e.load_type,
        e.is_unilateral ? 1 : 0,
        e.media.find((m) => m.kind === 'thumbnail' && m.url)?.url ?? null,
        JSON.stringify(e),
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
    payload_json: string | null;
  }>(
    sport
      ? `SELECT * FROM exercise_cache WHERE sport = ? ORDER BY name`
      : `SELECT * FROM exercise_cache ORDER BY name`,
    ...(sport ? [sport] : []),
  );

  return rows.map((r) => {
    // The stored payload IS the exercise the API sent, so prefer it whole.
    //
    // The reconstruction below it is not an equivalent fallback — it fabricates
    // empty muscles, empty equipment and empty instructions, which is why the
    // Library used to look gutted offline rather than merely cached. It stays
    // only for rows written before v10, which have no payload to read and
    // nothing to backfill from; the next catalog fetch replaces them.
    if (r.payload_json) {
      try {
        return JSON.parse(r.payload_json) as Exercise;
      } catch {
        // A corrupt blob falls through to the typed columns rather than
        // dropping the exercise from the list entirely — a searchable name
        // with no detail beats an exercise you cannot find.
      }
    }
    return {
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
    };
  });
}

// --- workouts, writable offline ------------------------------------------

/**
 * Create a workout on this device.
 *
 * The id is generated here, which is what makes the push idempotent: the
 * server does `ON CONFLICT (id) DO NOTHING`, so a retry after a lost response
 * is a no-op rather than a duplicate plan. Same contract sessions already use.
 *
 * `remote = 0` because the server has never heard of it. That flag is what the
 * session push consults before sending anything that references this workout.
 */
export async function createLocalWorkout(
  userID: string,
  input: { name: string; sport: string; goal: string | null; visibility: string },
): Promise<Workout> {
  const db = await getDb();
  const now = new Date().toISOString();
  const w: Workout = {
    id: randomUUID(),
    owner_user_id: userID,
    name: input.name,
    sport: input.sport as Workout['sport'],
    goal: input.goal as Workout['goal'],
    notes: '',
    visibility: input.visibility as Workout['visibility'],
    items: [],
    created_at: now,
    updated_at: now,
  };
  await db.runAsync(
    `INSERT INTO workout_cache
       (id, user_id, sport, name, goal, items_json, owner_user_id, visibility,
        dirty, remote, deleted_at, updated_at, cached_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 1, 0, NULL, ?, ?)`,
    w.id, userID, w.sport, w.name, w.goal, userID, w.visibility, now, now,
  );
  return w;
}

/** Replace a workout's exercises locally. Owed to the server afterwards. */
export async function saveLocalWorkoutItems(
  userID: string,
  id: string,
  items: WorkoutItem[],
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const r = await db.runAsync(
    `UPDATE workout_cache SET items_json = ?, dirty = 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    JSON.stringify(items), now, id, userID,
  );
  // Zero rows means the workout is gone from under us — deleted on the web
  // and reconciled away, most likely. Returning quietly would have the
  // screen report a successful save of work that now exists nowhere; the
  // caller already has an honest "Couldn't save on this device" path.
  if (r.changes === 0) throw new Error('This workout no longer exists on this device.');
}

/**
 * A workout row still owes the server something.
 *
 * `dirty` is the item list; `name_dirty` is the name; a tombstone sets `dirty`.
 * Written once and reused, because the failure mode of adding a third flag to
 * the push loop but not to the pending count is a sync that never finishes
 * with nothing on screen explaining why.
 */
const workoutOwed = '(dirty = 1 OR name_dirty = 1)';

/**
 * Rename a workout template locally. Owed to the server afterwards.
 *
 * Trims and refuses a blank, so the local row can never hold something the
 * server will reject — an outbox entry that is permanently invalid is worse
 * than a refused edit, because nothing on the screen ever explains why the
 * pending count will not go down.
 *
 * Returns false rather than throwing on a blank: the caller's response is to
 * put the old name back and close the field, not to show an alert. A missing
 * row still throws, because that one is genuinely surprising.
 */
export async function renameLocalWorkout(
  userID: string,
  id: string,
  name: string,
): Promise<boolean> {
  const trimmed = name.trim();
  if (trimmed === '') return false;
  const db = await getDb();
  const now = new Date().toISOString();
  const r = await db.runAsync(
    // `name_dirty` ONLY — deliberately NOT `dirty`.
    //
    // `dirty` means "the item list is owed to PUT /items", and setting it here
    // made a rename re-send `items_json` — which is exactly the silent rewrite
    // this endpoint was added to prevent. It is reachable: the detail screen
    // fetches the server's copy into React state but never writes it back to
    // the cache, so add an exercise on the web, open the workout on the phone,
    // rename it, and the push replaces the server's list with the phone's older
    // one. The new exercise is gone with no signal anywhere.
    //
    // Every "is this row owed anything" query therefore has to test BOTH flags;
    // they are listed at `workoutOwed` below.
    `UPDATE workout_cache SET name = ?, name_dirty = 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    trimmed, now, id, userID,
  );
  if (r.changes === 0) throw new Error('This workout no longer exists on this device.');
  return true;
}

/**
 * Delete a workout — a tombstone, same rules as sessions.
 *
 * Always marked, never hard-deleted here: deciding on `remote` at this point
 * races a first push that flips it mid-flight, which is exactly how a delete
 * ended up resurrecting in the session store. The push decides.
 */
export async function deleteLocalWorkout(userID: string, id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const r = await db.runAsync(
    `UPDATE workout_cache SET deleted_at = ?, dirty = 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    now, now, id, userID,
  );
  if (r.changes === 0) {
    // Zero rows has two meanings and they need different answers. Already
    // tombstoned: the caller is asking for a state that already holds, so
    // succeed quietly — a delete that is not idempotent is a worse bug than
    // this one. Genuinely absent (deleted on the web and reconciled away):
    // say so, or the screen navigates back as though it had deleted
    // something.
    const still = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM workout_cache WHERE id = ? AND user_id = ?`, id, userID,
    );
    if (!still) throw new Error('This workout no longer exists on this device.');
    return;
  }
  // Cut the link the same way the server would, and for the same reason.
  //
  // sessions.workout_id is ON DELETE SET NULL server-side. Locally it was
  // left pointing at the deleted plan, which stranded the session
  // *deterministically* rather than as a race: the workout tombstone is
  // pushed first by design, its row then leaves the cache, so
  // `unsyncedWorkoutIDs` no longer lists it, the session is not deferred,
  // and its create is refused with 400 "unknown workout" — a permanent
  // rejection, so retries stop and the training is lost with no repair path.
  //
  // Nulling here mirrors what the server does, so both sides converge. The
  // link is metadata; the training is the data, and only one of them is
  // irreplaceable. `dirty` is deliberately NOT set: an already-synced session
  // needs no push for this, because the server performs the same nulling
  // itself when the delete lands.
  await db.runAsync(
    `UPDATE local_sessions SET workout_id = NULL WHERE workout_id = ? AND user_id = ?`,
    id, userID,
  );
}

/**
 * Workout ids holding local edits the server hasn't got.
 *
 * Distinct from `unsyncedWorkoutIDs`, which asks whether the workout EXISTS
 * server-side (`remote`). This asks whether our copy is newer (`dirty`), which
 * is the question a screen needs before letting a network response overwrite
 * what is on screen.
 *
 * Returned as ids rather than added to `Workout` because that type is the wire
 * contract; local sync bookkeeping does not belong in it.
 */
export async function dirtyWorkoutIDs(userID: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM workout_cache WHERE user_id = ? AND ${workoutOwed}`,
    userID,
  );
  return new Set(rows.map((r) => r.id));
}

/** Workout ids this device holds that the server has not acknowledged. */
export async function unsyncedWorkoutIDs(userID: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM workout_cache WHERE user_id = ? AND remote = 0`,
    userID,
  );
  return new Set(rows.map((r) => r.id));
}

/** Workouts with local changes the server hasn't got. */
export async function countPendingWorkouts(userID: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM workout_cache WHERE user_id = ? AND ${workoutOwed}`,
    userID,
  );
  return row?.n ?? 0;
}

type WorkoutRow = {
  id: string;
  sport: string;
  name: string;
  goal: string | null;
  items_json: string;
  visibility: string;
  remote: number;
  dirty: number;
  name_dirty: number;
  deleted_at: string | null;
  updated_at: string;
};

/**
 * Push one workout's local state to the server.
 *
 * Mirrors `pushRow` for sessions, including the parts that were learned the
 * hard way there: a tombstone is carried out and only then hard-deleted, a 404
 * counts as success, a permanent refusal restores the row rather than hiding
 * it forever, and the clean-up CASes on `updated_at` so an edit that landed
 * mid-push is not marked as already sent.
 */
async function pushWorkoutRow(
  db: SQLite.SQLiteDatabase,
  row: WorkoutRow,
  userID: string,
  getToken: TokenGetter,
): Promise<void> {
  if (row.deleted_at) {
    // Never pushed, so there is nothing to tell the server. Decided HERE, not
    // at delete time, because `remote` is only trustworthy inside the
    // serialised sync.
    if (row.remote === 0) {
      await db.runAsync(`DELETE FROM workout_cache WHERE id = ? AND user_id = ?`, row.id, userID);
      return;
    }
    try {
      await deleteWorkout(getToken, row.id);
    } catch (err) {
      if (isNotFound(err)) {
        // The server agreeing it is gone IS the state being asked for.
      } else if (isPermanentRejection(err)) {
        // It will refuse identically forever. Keeping the tombstone would
        // hide the plan for the life of the install while pending never
        // reached zero. Restore it: the workout was not deleted.
        await db.runAsync(
          `UPDATE workout_cache SET deleted_at = NULL, dirty = 0 WHERE id = ? AND user_id = ?`,
          row.id, userID,
        );
        throw err;
      } else {
        throw err;
      }
    }
    await db.runAsync(`DELETE FROM workout_cache WHERE id = ? AND user_id = ?`, row.id, userID);
    return;
  }

  // Captured BEFORE the create below, because the guard on the rename needs to
  // know whether the workout already existed server-side. Reading `row.remote`
  // afterwards is no good — and neither is re-reading the row, which is what an
  // earlier attempt did: the DB was updated but the in-memory `row` still said
  // `name_dirty = 1`, so the PATCH went out anyway.
  const wasRemote = row.remote === 1;

  if (row.remote === 0) {
    await createWorkout(getToken, {
      id: row.id,
      name: row.name,
      sport: row.sport as Workout['sport'],
      goal: row.goal as Workout['goal'],
      visibility: row.visibility as Workout['visibility'],
    });
    await db.runAsync(`UPDATE workout_cache SET remote = 1 WHERE id = ? AND user_id = ?`,
      row.id, userID);
  }

  let items: WorkoutItem[] = [];
  try {
    items = JSON.parse(row.items_json) as WorkoutItem[];
  } catch {
    // A corrupt blob must not be pushed: replaceItems REPLACES the server's
    // list, so sending [] would turn a local read failure into permanent
    // remote deletion. Same guard sessions carry.
    throw new Error('This workout is corrupted on this device and was not synced.');
  }
  // Each call guarded by its own flag. An ordinary item edit must not also
  // PATCH the name (the extra request per debounced write `local_sessions`
  // learned to avoid), and — the one that actually loses data — a rename must
  // not PUT an item list it may hold a stale copy of.
  if (row.dirty === 1) {
    await replaceItems(getToken, row.id, items);
  }

  // The rename goes LAST, matching `pushRow` for sessions, whose ordering was
  // settled by a real incident. The first cut here did the opposite, reasoning
  // that a failed rename after a successful item push leaves "new items under
  // the old name". It does — but that state is transient, the row stays dirty,
  // and the next pass fixes it. Rename-first trades it for a worse one: a
  // PERMANENTLY refused name aborts the row before the items go out, so every
  // retry replays the same doomed request and the item edits never land at all.
  // That is not hypothetical — an app deployed ahead of the API gets 405 on
  // this route, which `isPermanentStatus` classifies as permanent.
  //
  // `wasRemote` matters: a workout created offline and renamed before its first
  // push is CREATED with the new name already, so a PATCH behind it re-sends the
  // same string. Sessions carry the identical guard.
  if (wasRemote && row.name_dirty === 1) {
    await renameWorkout(getToken, row.id, row.name);
  }

  await db.runAsync(
    `UPDATE workout_cache SET dirty = 0, name_dirty = 0 WHERE id = ? AND user_id = ?
     -- Only if nothing changed underneath us mid-push, or we would mark a
     -- newer edit as already sent and silently drop it.
     AND updated_at = ?`,
    row.id, userID, row.updated_at,
  );
}
