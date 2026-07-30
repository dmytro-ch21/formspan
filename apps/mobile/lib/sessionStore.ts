import { randomUUID } from 'expo-crypto';

import { getDb } from './db';
import type { Exercise } from './exercises';
import type { Workout, WorkoutItem } from './workouts';
import {
  finishSession as pushFinish,
  getSession as pullSession,
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
  updated_at: string;
};

function toSession(r: Row): LocalSession {
  let sets: LoggedSet[] = [];
  try {
    sets = JSON.parse(r.sets_json) as LoggedSet[];
  } catch {
    // A corrupt blob must not make the session unopenable — an empty list
    // loses the sets, but a throw here would lose the whole workout.
    sets = [];
  }
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

async function upsert(s: LocalSession, userID: string, dirty: boolean): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workout_id = excluded.workout_id,
       sport      = excluded.sport,
       name       = excluded.name,
       started_at = excluded.started_at,
       ended_at   = excluded.ended_at,
       notes      = excluded.notes,
       sets_json  = excluded.sets_json,
       dirty      = excluded.dirty,
       updated_at = excluded.updated_at`,
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
  await upsert(session, userID, true);
  return session;
}

export async function readLocalSession(
  userID: string,
  id: string,
): Promise<LocalSession | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>(
    `SELECT * FROM local_sessions WHERE id = ? AND user_id = ?`,
    id,
    userID,
  );
  return row ? toSession(row) : null;
}

export async function listLocalSessions(userID: string, limit = 20): Promise<LocalSession[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT * FROM local_sessions WHERE user_id = ?
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

export async function deleteLocalSession(userID: string, id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM local_sessions WHERE id = ? AND user_id = ?`, id, userID);
}

export async function countPendingSessions(userID: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM local_sessions WHERE user_id = ? AND dirty = 1`,
    userID,
  );
  return row?.n ?? 0;
}

export type SessionSyncResult = { pushed: number; pulled: number; failed: number; error?: string };

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
export async function syncSessions(
  userID: string,
  getToken: () => Promise<string | null>,
): Promise<SessionSyncResult> {
  const db = await getDb();
  const result: SessionSyncResult = { pushed: 0, pulled: 0, failed: 0 };

  const dirty = await db.getAllAsync<Row>(
    `SELECT * FROM local_sessions WHERE user_id = ? AND dirty = 1 ORDER BY started_at`,
    userID,
  );

  for (const row of dirty) {
    const s = toSession(row);
    try {
      await pushCreate(getToken, {
        id: s.id,
        sport: s.sport,
        name: s.name,
        workout_id: s.workout_id,
        started_at: s.started_at,
        sets: s.sets,
      });
      // Always, not just on replay: it's one extra request and it removes
      // the need to know which branch the create took.
      await pushSets(getToken, s.id, s.sets);
      if (s.ended_at) await pushFinish(getToken, s.id, s.ended_at);

      await db.runAsync(
        `UPDATE local_sessions SET dirty = 0 WHERE id = ? AND user_id = ?
         -- Only if nothing changed underneath us mid-push, or we'd mark a
         -- newer edit as already sent and silently drop it.
         AND updated_at = ?`,
        s.id,
        userID,
        row.updated_at,
      );
      result.pushed++;
    } catch (err) {
      result.failed++;
      result.error = err instanceof Error ? err.message : String(err);
    }
  }

  // Pull only what we don't hold dirty — the server is authoritative for
  // everything the device isn't currently editing.
  try {
    const remote = await pullSessions(getToken, { limit: 20 });
    for (const r of remote) {
      const local = await db.getFirstAsync<{ dirty: number }>(
        `SELECT dirty FROM local_sessions WHERE id = ? AND user_id = ?`,
        r.id,
        userID,
      );
      if (local?.dirty === 1) continue;
      await upsert({ ...r, dirty: false }, userID, false);
      result.pulled++;
    }
  } catch (err) {
    if (result.failed === 0) {
      result.failed++;
      result.error = err instanceof Error ? err.message : String(err);
    }
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
  getToken: () => Promise<string | null>,
): Promise<LocalSession | null> {
  try {
    const { session } = await pullSession(getToken, id);
    await upsert({ ...session, dirty: false }, userID, false);
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
        `INSERT INTO workout_cache (id, user_id, sport, name, items_json, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sport = excluded.sport, name = excluded.name,
           items_json = excluded.items_json, cached_at = excluded.cached_at`,
        w.id,
        userID,
        w.sport,
        w.name,
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
      goal: null,
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
export async function cachedExercises(sport: string): Promise<Exercise[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    sport: string;
    name: string;
    movement_pattern: string;
    load_type: string;
    is_unilateral: number;
    thumbnail_url: string | null;
  }>(`SELECT * FROM exercise_cache WHERE sport = ? ORDER BY name`, sport);

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
