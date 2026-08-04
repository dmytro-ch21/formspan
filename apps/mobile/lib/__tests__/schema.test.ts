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
  expect(row.user_version).toBe(16);
});

it('local_sessions has the tombstone column', async () => {
  const db = await migratedFixture();
  const cols = (db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toEqual(expect.arrayContaining(['deleted_at', 'dirty', 'remote', 'updated_at']));
});

it('local_sessions can hold a BJJ reflection', async () => {
  // v13. Nullable on purpose: the push path uses "is bjj_json null?" to
  // decide whether a session needs a detail PUT at all, so defaulting it to
  // '{}' would make every strength session attempt one.
  const db = await migratedFixture();
  const cols = db.raw.prepare('PRAGMA table_info(local_sessions)').all() as {
    name: string;
    notnull: number;
  }[];
  const bjj = cols.find((c) => c.name === 'bjj_json');
  expect(bjj).toBeDefined();
  expect(bjj?.notnull).toBe(0);
});

it('a v13 device gets the week-plan table', async () => {
  // The path a real upgrader takes, and the one that actually broke: while
  // this was being built, a hot reload re-ran `migrate()` after the version
  // was bumped but before the CREATE existed, so the device stamped v14 with
  // no table and every "Add" tapped into `no such table: planned_sessions`.
  // A shipped build cannot split those two edits — but nothing proved the
  // upgrade branch created the table until this did.
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 13');
  db.raw.exec('DROP TABLE planned_sessions');

  await migrate(db as never);

  const row = db.raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'planned_sessions'`)
    .get();
  expect(row).toEqual({ name: 'planned_sessions' });
});

it('a v14 plan is OWED to the server, not assumed to be there', async () => {
  // v14 shipped `planned_sessions` as a local-only table — there was no
  // /v1/plans yet — so every plan an early adopter made has never been sent
  // anywhere. `dirty = 1, remote = 0` is the honest default.
  //
  // Deliberately the OPPOSITE of the workout_cache v9 ALTERs, which default
  // `dirty = 0, remote = 1` because those rows came FROM the server. Getting
  // this backwards would strand every existing plan with nothing to push it —
  // the same class of mistake as the v9 note below, inverted.
  //
  // A v14-SHAPED table specifically: on a fresh install these columns come
  // from CREATE TABLE, so the fresh-install test cannot see a wrong ALTER
  // default at all.
  const db = openFixture();
  db.raw.exec(`
    CREATE TABLE planned_sessions (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
      sport TEXT NOT NULL, workout_id TEXT, created_at TEXT NOT NULL);
    INSERT INTO planned_sessions VALUES
      ('p1','u1','2026-08-05','strength',NULL,'2026-08-01T00:00:00Z');
    PRAGMA user_version = 14;
  `);

  await migrate(db as never);

  const row = db.raw
    .prepare('SELECT dirty, remote, deleted_at, notes, updated_at FROM planned_sessions')
    .get();
  expect(row).toEqual({
    dirty: 1,
    remote: 0,
    deleted_at: null,
    notes: '',
    // Backfilled from created_at, so the push-side compare-and-swap has
    // something to compare against rather than an empty string.
    updated_at: '2026-08-01T00:00:00Z',
  });
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 });
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 });
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 });
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

it('workout_cache carries name_dirty on a fresh install', async () => {
  const db = await migratedFixture();
  const cols = db.raw.prepare(`PRAGMA table_info(workout_cache)`).all() as { name: string }[];
  expect(cols.map((c) => c.name)).toContain('name_dirty');
});

it('upgrading an existing database does not mark every cached name as owed', async () => {
  // The direction matters and is easy to get backwards. Every row already in
  // `workout_cache` came FROM the server, so its name is what the server holds
  // and none of them owes a PATCH. Defaulting to 1 would make the first sync
  // after upgrade re-send every cached template's name — including VOLA's own
  // ownerless ones, which the server refuses with a 403 that the outbox would
  // then hold forever.
  const db = await openFixture();
  await migrate(db as never);
  db.raw
    .prepare(
      `INSERT INTO workout_cache (id, user_id, sport, name, items_json, cached_at)
       VALUES ('w1', 'u1', 'strength', 'Legs', '[]', '2026-08-04T00:00:00Z')`,
    )
    .run();
  const row = db.raw
    .prepare(`SELECT name_dirty FROM workout_cache WHERE id = 'w1'`)
    .get() as { name_dirty: number };
  expect(row.name_dirty).toBe(0);
});
