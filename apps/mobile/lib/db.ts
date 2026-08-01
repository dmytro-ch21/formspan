import * as SQLite from 'expo-sqlite';

/**
 * Local SQLite store — the offline half of the offline-first sync design
 * (local write first, push to the API when connectivity allows).
 *
 * `synced` is the mutation-outbox flag: 0 = still owed to the server,
 * 1 = confirmed accepted. Rows are kept after syncing rather than deleted,
 * so the device retains its own history independent of the network.
 *
 * Every row carries `user_id`. On a shared device that isn't optional: an
 * unscoped outbox would show one account's history to the next person who
 * signs in, and would push their pending rows to the server under the new
 * account's token — a mistake idempotency makes permanent.
 *
 * The pre-VOLA `formspan.db` isn't reachable from here at all — the rename
 * changed the filename, so those rows are abandoned rather than migrated.
 * Deliberate: throwaway dev data, and no build ever shipped to anyone.
 */
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    notes TEXT,
    synced INTEGER NOT NULL DEFAULT 0
  );
`;

const CREATE_SESSIONS = `
  CREATE TABLE IF NOT EXISTS local_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    workout_id TEXT,
    sport TEXT NOT NULL,
    name TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    sets_json TEXT NOT NULL DEFAULT '[]',
    -- 0 = the server holds exactly this; 1 = we owe it a push. Same outbox
    -- flag as activities, named for what it means rather than for sync
    -- state, because a row can be dirty for reasons other than "never sent".
    dirty INTEGER NOT NULL DEFAULT 1,
    -- 1 once the server has acknowledged this session exists. Distinct from
    -- the dirty flag, which is about the contents being current: a session
    -- can be dirty forever while still being remote, and that is the common
    -- case during a workout.
    remote INTEGER NOT NULL DEFAULT 0,
    -- When the athlete deleted this, or NULL. A TOMBSTONE, not a hard delete.
    --
    -- Deleting the row outright is what made an offline delete undo itself:
    -- the row vanished locally, the server still held it, and the next pull
    -- fetched it straight back. Worse, with the row gone there was nothing
    -- left carrying "this needs deleting", so the delete was lost the moment
    -- the fire-and-forget DELETE failed — which offline it always does.
    --
    -- The row therefore stays, marked, until the server confirms. Then it is
    -- hard-deleted for real. Reads filter it out, so it is invisible from the
    -- moment the athlete taps Delete.
    deleted_at TEXT,
    updated_at TEXT NOT NULL
  );
`;

const CREATE_PREFS = `
  CREATE TABLE IF NOT EXISTS prefs (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
`;

const CREATE_WORKOUT_CACHE = `
  CREATE TABLE IF NOT EXISTS workout_cache (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    sport TEXT NOT NULL,
    name TEXT NOT NULL,
    goal TEXT,
    items_json TEXT NOT NULL DEFAULT '[]',
    -- WHO OWNS IT, and whether it is shared -- as the server says, not as the
    -- device assumes.
    --
    -- The cache used to return the reading athlete's own id and a hardcoded
    -- "private". workout/[id].tsx derives canEdit from exactly that field, so
    -- offline EVERY cached workout looked editable -- including VOLA's own
    -- ownerless templates and other athletes' public ones. The Save button
    -- appeared for things the server refuses, and the "VOLA template" label
    -- vanished because nothing was ever null.
    --
    -- NB no backticks in this comment: the whole block is a JS template
    -- literal, and one would end it. That has now cost two debugging rounds.
    --
    -- Nullable because a VOLA template genuinely has no owner. Distinct from
    -- user_id above, which records whose device-cache row this is.
    owner_user_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private',
    cached_at TEXT NOT NULL
  );
`;

const CREATE_EXERCISE_CACHE = `
  CREATE TABLE IF NOT EXISTS exercise_cache (
    id TEXT PRIMARY KEY NOT NULL,
    sport TEXT NOT NULL,
    name TEXT NOT NULL,
    movement_pattern TEXT NOT NULL,
    load_type TEXT NOT NULL,
    is_unilateral INTEGER NOT NULL DEFAULT 0,
    thumbnail_url TEXT,
    cached_at TEXT NOT NULL
  );
`;

/**
 * Current local schema version. Bump this and add a matching `if` in
 * `migrate()` whenever the local table shape changes.
 *
 * SQLite's own `PRAGMA user_version` holds what the device is actually on.
 * This replaces an earlier column-sniffing guard (`does user_id exist?`),
 * which had a subtle problem: it only ever asked about one specific column,
 * so the *next* column added would have sailed straight past it and hit the
 * "no such column" crash the guard was supposed to prevent. A version number
 * can't develop that blind spot.
 *
 * **The invariant every version branch must hold.** The `CREATE TABLE`
 * statements above are maintained at the *current* shape, and a device at
 * version 0 runs **every** branch in order. So each branch must be a no-op
 * against a table that was just created at the current shape — otherwise it
 * fires on fresh installs, where it was never meant to run.
 *
 * Concretely: **route every `ADD COLUMN` through `addColumnIfMissing`**, never
 * a bare `ALTER`. Ignoring this is what shipped `duplicate column name: remote`
 * in v5 and bricked every new install until it was found on a real phone —
 * `migrate()` threw, the version was never stamped, and `getDb()` failed for
 * the life of the install.
 *
 * The guard only covers `ADD COLUMN`. A future `RENAME COLUMN`, `DROP COLUMN`,
 * or data backfill has the same hazard and no guard — it would run against a
 * current-shape table on a fresh install and fail. If one is needed, either
 * make it independently idempotent or freeze the `CREATE` statements at their
 * historical shapes from that version onward.
 */
const SCHEMA_VERSION = 8;

/** Tables this file owns. Typed so a guard can't be pointed at a typo. */
type LocalTable =
  | 'activities'
  | 'local_sessions'
  | 'prefs'
  | 'workout_cache'
  | 'exercise_cache';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Adds a column only if the table doesn't already have it.
 *
 * Necessary because the `CREATE TABLE` statements above are kept at the
 * *current* schema shape rather than frozen at the version that introduced
 * them. A device creating a table for the first time therefore receives every
 * column at once — including ones a later `ALTER` step also tries to add.
 * SQLite rejects the duplicate, the migration throws, `user_version` is never
 * stamped, and `getDb()` then fails for the life of the install. That is not a
 * degraded mode: it is every offline feature dead on arrival, on exactly the
 * path a new user takes.
 *
 * This is not a return to the column-sniffing the version counter replaced.
 * That guard asked "does `user_id` exist?" to decide whether to run *any*
 * migration, so it went blind the moment a second column was added. This asks
 * about precisely the column it is about to add — a question that cannot go
 * stale as the schema grows.
 *
 * `table` is a `LocalTable`, and `column`/`definition` are literals from this
 * file — never user input. Identifiers cannot be bound as parameters in DDL
 * anyway, so the `ALTER` has to interpolate regardless; the type is what keeps
 * that honest.
 *
 * Note that `table_info` returns zero rows for a table that doesn't exist
 * rather than erroring, so a missing table reads here as "column missing" and
 * then fails loudly on the `ALTER` with "no such table". Unreachable from
 * `migrate()`, where the `CREATE`s always precede the `ALTER`s, but worth
 * knowing before calling this from anywhere else.
 */
async function addColumnIfMissing(
  db: SQLite.SQLiteDatabase,
  table: LocalTable,
  column: string,
  definition: string,
): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table});`);
  if (cols.some((c) => c.name === column)) return;
  await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

/**
 * Exported for the SQLite test fixture, which runs the real migrations against
 * a real database rather than asserting on query text. Not for app use —
 * `getDb` is the only thing that should call this in production, exactly once.
 */
export async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>(`PRAGMA user_version`);
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  // v0 -> v1. `IF NOT EXISTS` keeps this safe on a device that already has
  // the v1 shape but never had its version stamped (any build from before
  // this versioning existed).
  await db.execAsync(CREATE_TABLE);
  await db.execAsync(
    `CREATE INDEX IF NOT EXISTS activities_user_id_idx ON activities (user_id);`,
  );

  if (current < 2) {
    // v1 -> v2: sessions become offline-first too.
    //
    // Sets live as a JSON blob rather than their own table, deliberately.
    // The API replaces a session's whole ordered list in one call, and the
    // UI edits it as one array, so there is no operation anywhere that
    // touches a single set in isolation. Rows would buy a join and a
    // reconciliation step and nothing else.
    await db.execAsync(CREATE_SESSIONS);
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS local_sessions_user_idx
         ON local_sessions (user_id, started_at DESC);`,
    );
    // The catalog cache is what makes a session *readable* offline. Without
    // it the screen has set rows and no idea what exercise they belong to,
    // which measures to render, or what to call them — a log you can write
    // but not read is not offline support.
    await db.execAsync(CREATE_EXERCISE_CACHE);
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS exercise_cache_sport_idx ON exercise_cache (sport);`,
    );
  }

  if (current < 3) {
    // v2 -> v3. Caching sessions and the exercise catalog but not the
    // *plans* left the worst possible offline state: the start screen said
    // "no workouts yet" and offered to create one, which is a lie told at
    // precisely the moment someone is standing in a gym about to train.
    await db.execAsync(CREATE_WORKOUT_CACHE);
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS workout_cache_user_sport_idx
         ON workout_cache (user_id, sport);`,
    );
  }

  if (current < 4) {
    // A tiny key/value table for preferences, keyed by user because a shared
    // device must not hand one account's settings to the next person.
    //
    // Two kinds live here for two different reasons. The unit system is a
    // *cache* of the server's copy, so the session screen can render in the
    // right units with no signal. The last-used filters are genuinely local
    // — where you are in the UI is a property of this device, not of you.
    await db.execAsync(CREATE_PREFS);
  }

  if (current < 5) {
    // v4 -> v5: remember which sessions the server already knows about.
    //
    // Without this the outbox re-sent `POST /v1/sessions` on every single
    // save, forever. The create is idempotent so it was harmless, but it
    // doubled the request cost of typing a weight and made the server
    // re-validate the workout template each time.
    //
    // Existing rows default to 0, which costs exactly one redundant create
    // each and then corrects itself — no backfill needed.
    //
    // Guarded: a device that created `local_sessions` at v2 or later got this
    // column from CREATE_SESSIONS already, and the bare ALTER would fail with
    // "duplicate column name: remote".
    await addColumnIfMissing(
      db,
      'local_sessions',
      'remote',
      'INTEGER NOT NULL DEFAULT 0',
    );
  }

  if (current < 6) {
    // v5 -> v6: cache the workout's goal alongside the plan.
    //
    // The goal picks the rep range the progression rule works inside, so a
    // cached workout without one starts an offline session on the general 5-8
    // range that the session screen — once it has signal — re-derives on 3-5.
    // Nothing errors; the two just quietly disagree about what the athlete is
    // doing, which is the failure this whole feature is built to avoid.
    //
    // Existing rows get NULL, which is exactly what they already reported, and
    // they self-correct on the next `cacheWorkouts`.
    //
    // Guarded for the same reason as `remote` above. The original comment here
    // claimed "a device at v5 by definition lacks the column" — true of a v5
    // device, but the fresh-install path runs *every* branch from v0, and its
    // CREATE_WORKOUT_CACHE already declared `goal`. `IF NOT EXISTS` is not
    // available for ADD COLUMN in this SQLite build, hence the explicit check.
    await addColumnIfMissing(db, 'workout_cache', 'goal', 'TEXT');
  }

  if (current < 7) {
    // v6 -> v7: tombstones, so an offline delete stops resurrecting.
    //
    // Guarded rather than a bare ALTER, for the reason spelled out on the
    // `goal` column above: the fresh-install path runs *every* branch from
    // v0, and its CREATE_SESSIONS already declares `deleted_at`.
    await addColumnIfMissing(db, 'local_sessions', 'deleted_at', 'TEXT');
  }

  if (current < 8) {
    // v7 -> v8: the workout cache stops lying about ownership.
    await addColumnIfMissing(db, 'workout_cache', 'owner_user_id', 'TEXT');
    await addColumnIfMissing(
      db,
      'workout_cache',
      'visibility',
      "TEXT NOT NULL DEFAULT 'private'",
    );
  }

  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('vola.db');
      await db.execAsync(`PRAGMA journal_mode = WAL;`);
      await migrate(db);
      return db;
    })().catch((err) => {
      // Without this reset, one failed open leaves a permanently rejected
      // promise cached here, so every later getDb() fails for the lifetime
      // of the process with no way back — a transient failure would present
      // as the database being gone for good.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}
