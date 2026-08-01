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
  expect(row.user_version).toBe(11);
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
});

it('an upgraded row is backfilled as owned by the athlete it is filed under', async () => {
  // NOT null. Only `mine` lists are ever cached, and the server's `mine` is
  // strictly owner_user_id = $1 — so every pre-v8 row is provably owned by
  // its user_id. NULL would be cautious in general and simply wrong here: it
  // would label every one of an upgrader's own workouts "VOLA template"
  // until a refresh landed, and an ownerless private workout is a pair the
  // server cannot even produce.
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
  expect(row).toEqual({ owner_user_id: 'u1', visibility: 'private' });
});

it('an upgraded row is NOT owed to the server', async () => {
  // The v9 ALTERs default `dirty = 0, remote = 1` — the rows came FROM the
  // server, so they are already there. Getting this backwards is not a
  // cosmetic mistake: every upgrading device would treat its whole cached
  // plan list as an outbox and `replaceItems` its stale cached items over
  // whatever the athlete has since edited on the web.
  //
  // This needs a v8-SHAPED database specifically. `migratedFixture()` builds
  // a fresh one, where these columns come from CREATE TABLE and not from the
  // ALTERs — so the fresh-install test cannot see a wrong ALTER default at
  // all, and passed while this path was unguarded.
  const db = openFixture();
  db.raw.exec(`
    CREATE TABLE workout_cache (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, sport TEXT NOT NULL,
      name TEXT NOT NULL, goal TEXT, items_json TEXT NOT NULL DEFAULT '[]',
      owner_user_id TEXT, visibility TEXT NOT NULL DEFAULT 'private',
      cached_at TEXT NOT NULL);
    INSERT INTO workout_cache VALUES
      ('w1','u1','strength','Legs',NULL,'[]','u1','private','2026-08-01T00:00:00Z');
    PRAGMA user_version = 8;
  `);

  await migrate(db as never);

  const row = db.raw.prepare('SELECT dirty, remote, deleted_at FROM workout_cache').get();
  expect(row).toEqual({ dirty: 0, remote: 1, deleted_at: null });
});

it('an upgraded pref is NOT owed, and an upgraded exercise has no fabricated payload', async () => {
  // A v9-SHAPED database specifically. `migratedFixture()` builds a fresh one
  // where these columns come from CREATE TABLE, so it cannot see a wrong
  // ALTER default at all — the same blind spot a reviewer caught for
  // workout_cache in PR4b, which is why this is written the hard way.
  //
  // dirty must default to 0: everything already stored either came from the
  // server or was pushed at the time, so defaulting the other way would queue
  // an upgrader's entire preference set for a pointless replay — and, worse,
  // replay stale values over newer ones set on the web.
  //
  // payload_json must be NULL, not an empty object: there is nothing to
  // backfill from, and a default would be a FABRICATED exercise (no muscles,
  // no equipment, no instructions) that reads as real and never gets
  // refreshed, instead of a missing one that the next fetch fills in.
  const db = openFixture();
  db.raw.exec(`
    CREATE TABLE prefs (
      user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (user_id, key));
    CREATE TABLE exercise_cache (
      id TEXT PRIMARY KEY NOT NULL, sport TEXT NOT NULL, name TEXT NOT NULL,
      movement_pattern TEXT NOT NULL, load_type TEXT NOT NULL,
      is_unilateral INTEGER NOT NULL DEFAULT 0, thumbnail_url TEXT,
      cached_at TEXT NOT NULL);
    INSERT INTO prefs VALUES ('u1','unit_system','imperial');
    INSERT INTO exercise_cache VALUES
      ('e1','strength','Back Squat','squat','weight_reps',0,NULL,'2026-08-01T00:00:00Z');
    PRAGMA user_version = 9;
  `);

  await migrate(db as never);

  expect(db.raw.prepare('SELECT dirty FROM prefs').get()).toEqual({ dirty: 0 });
  expect(db.raw.prepare('SELECT payload_json FROM exercise_cache').get()).toEqual({
    payload_json: null,
  });
});
