import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../../db';

/**
 * A real SQLite database, wearing expo-sqlite's interface.
 *
 * **Why this exists.** The tombstone suite mocked `lib/db` with an in-memory
 * array and matched SQL with regexes. It covered the *decisions* and not the
 * SQL — a limit named honestly in three commits, but a limit that cost real
 * confidence: two guards had to be pinned by asserting on query *text*
 * (`WHERE deleted_at IS NULL` on the upsert), which proves a clause is present
 * and not that SQLite honours it. Worse, an array mock can *supply* the
 * behaviour under test — it did exactly that once, setting `dirty = 1`
 * unconditionally so the assertion that deletes are pushable passed with the
 * production `dirty = 1` deleted.
 *
 * `expo-sqlite` itself cannot run here: jest-expo stubs the native module
 * (`NativeDatabase is not a constructor`). Node 22+ ships `node:sqlite`, which
 * is the same engine with a synchronous API and **no new dependency** — so
 * this is a thin async shim over it rather than a second database.
 *
 * What that buys, beyond "the SQL runs": the **migrations run too**. A schema
 * mistake, a missing column, a botched `ALTER` guard — the class of bug the
 * fresh-install-runs-every-branch comment in `db.ts` exists to warn about — is
 * now caught by any test that opens a fixture, rather than by a device.
 */

/** The subset of expo-sqlite's surface this app actually uses. */
export type FixtureDb = {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<void>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
  /** Escape hatch for arranging state a test needs but the app can't create. */
  raw: DatabaseSync;
};

/**
 * `null` and `undefined` are interchangeable in expo-sqlite's binder; node's
 * is stricter and rejects `undefined`. Normalising here keeps call sites
 * identical to the app's, which is the whole point of the shim.
 */
function bind(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

/**
 * A migrated database, ready to use.
 *
 * Runs the app's OWN `migrate()` — so the schema under test is the schema that
 * ships, and a botched `ALTER` guard or a column missing from a fresh install
 * fails here rather than on a device. That is the class of bug `db.ts`'s
 * fresh-install-runs-every-branch comment exists to warn about, and until now
 * nothing exercised it.
 */
export async function migratedFixture(): Promise<FixtureDb> {
  const db = openFixture();
  await migrate(db as unknown as Parameters<typeof migrate>[0]);
  return db;
}

export function openFixture(): FixtureDb {
  const db = new DatabaseSync(':memory:');
  return {
    async execAsync(sql) {
      db.exec(sql);
    },
    async runAsync(sql, ...params) {
      db.prepare(sql).run(...(bind(params) as never[]));
    },
    async getFirstAsync<T>(sql: string, ...params: unknown[]) {
      return (db.prepare(sql).get(...(bind(params) as never[])) as T) ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...(bind(params) as never[])) as T[];
    },
    async withTransactionAsync(fn) {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    raw: db,
  };
}
