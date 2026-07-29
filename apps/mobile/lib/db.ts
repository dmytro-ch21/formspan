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

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('vola.db');
      await db.execAsync(`PRAGMA journal_mode = WAL;`);
      await db.execAsync(CREATE_TABLE);

      // A dev build that ran an older schema already has an `activities`
      // table, so CREATE TABLE IF NOT EXISTS above is a no-op for it and any
      // newer column is still missing. Check before touching anything that
      // depends on one — including the index below, which would otherwise
      // throw "no such column: user_id" on every launch.
      //
      // Rather than guess who orphaned rows belonged to, drop them: they're
      // one person's local test data, and mis-attributing them to whoever
      // signs in next is worse than losing them.
      //
      // Note the pre-VOLA `formspan.db` isn't reachable from here at all —
      // the rename changed the filename, so those rows are simply abandoned
      // rather than migrated. Deliberate: it was throwaway dev data, and no
      // build has shipped to anyone.
      const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(activities)`);
      if (!cols.some((c) => c.name === 'user_id')) {
        await db.execAsync(`DROP TABLE activities;`);
        await db.execAsync(CREATE_TABLE);
      }

      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS activities_user_id_idx ON activities (user_id);`,
      );

      return db;
    })();
  }
  return dbPromise;
}
