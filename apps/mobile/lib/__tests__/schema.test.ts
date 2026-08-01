import { migrate } from '../db';
import { migratedFixture, openFixture } from './support/sqlite';

/**
 * The migrations, run for real.
 *
 * `db.ts` carries a hard-won comment: the fresh-install path runs **every**
 * branch from v0, which is why each `ADD COLUMN` is guarded — a v5-shaped
 * assumption once produced an ALTER that failed on a fresh install. Nothing
 * exercised that until this fixture existed.
 */

it('a fresh install ends up at the current schema version', async () => {
  const db = await migratedFixture();
  const row = db.raw.prepare('PRAGMA user_version').get() as { user_version: number };
  expect(row.user_version).toBe(8);
});

it('local_sessions has the tombstone column', async () => {
  const db = await migratedFixture();
  const cols = (db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toEqual(expect.arrayContaining(['deleted_at', 'dirty', 'remote', 'updated_at']));
});

it('re-running migrate on the SAME database is idempotent', async () => {
  // The scenario this guards is a crash between DDL and the version stamp:
  // same database, old `user_version`, branches replayed against a schema
  // that already has the changes. The first version of this test called
  // `migratedFixture()` twice — two brand-new databases — so it ran the
  // fresh path twice under a different name, and `migrate()` short-circuits
  // on `current >= SCHEMA_VERSION` anyway. It could not have failed.
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 0');

  await expect(migrate(db as never)).resolves.toBeUndefined();
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
});

it('upgrades a v6-shaped database by adding the column', async () => {
  // The path a real device takes. Every fixture otherwise starts at v0 with
  // CREATE statements at the CURRENT shape, so `addColumnIfMissing`'s ALTER
  // never fires — delete the whole `if (current < 7)` branch and the rest of
  // this file stays green. Hand-building the historical shape is legitimate:
  // those CREATEs no longer exist in the code.
  // The FULL v6 shape, not just the table under test. A real device at v6 has
  // every earlier table, and `migrate` skips the branches that created them —
  // so a fixture with only one table makes a later `addColumnIfMissing` throw
  // "no such table" for a reason that could never happen on a device. My first
  // version of this made exactly that mistake.
  const db = openFixture();
  db.raw.exec(`
    CREATE TABLE local_sessions (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, workout_id TEXT,
      sport TEXT NOT NULL, name TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, notes TEXT NOT NULL DEFAULT '',
      sets_json TEXT NOT NULL DEFAULT '[]', dirty INTEGER NOT NULL DEFAULT 1,
      remote INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE workout_cache (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, sport TEXT NOT NULL,
      name TEXT NOT NULL, goal TEXT, items_json TEXT NOT NULL DEFAULT '[]',
      cached_at TEXT NOT NULL);
    PRAGMA user_version = 6;
  `);

  await migrate(db as never);

  const cols = (db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[])
    .map((c) => c.name);
  expect(cols).toContain('deleted_at');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
});

it('upgrades a v7-shaped database by adding the ownership columns', async () => {
  // The workout cache used to report the reading athlete as the owner of
  // every row. A device upgrading from v7 has the old shape; this is the
  // path it takes.
  const db = openFixture();
  db.raw.exec(`
    CREATE TABLE workout_cache (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, sport TEXT NOT NULL,
      name TEXT NOT NULL, goal TEXT, items_json TEXT NOT NULL DEFAULT '[]',
      cached_at TEXT NOT NULL);
    PRAGMA user_version = 7;
  `);

  await migrate(db as never);

  const cols = (db.raw.prepare('PRAGMA table_info(workout_cache)').all() as { name: string }[])
    .map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining(['owner_user_id', 'visibility']));
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
});

it('an upgraded row defaults to NOT owned by the reader', async () => {
  // The failure mode this whole column exists for: an existing cached row
  // must not silently claim the reader owns it. NULL is the honest default —
  // it reads as "VOLA template" until the next refresh tells the truth.
  const db = openFixture();
  db.raw.exec(`
    CREATE TABLE workout_cache (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, sport TEXT NOT NULL,
      name TEXT NOT NULL, goal TEXT, items_json TEXT NOT NULL DEFAULT '[]',
      cached_at TEXT NOT NULL);
    INSERT INTO workout_cache VALUES ('w1','u1','strength','Legs',NULL,'[]','2026-08-01T00:00:00Z');
    PRAGMA user_version = 7;
  `);

  await migrate(db as never);

  const row = db.raw.prepare('SELECT owner_user_id, visibility FROM workout_cache').get();
  expect(row).toEqual({ owner_user_id: null, visibility: 'private' });
});
