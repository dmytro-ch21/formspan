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
const SCHEMA_VERSION = 1;

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
