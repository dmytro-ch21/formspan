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
    items_json TEXT NOT NULL DEFAULT '[]',
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
 */
const SCHEMA_VERSION = 4;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
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
