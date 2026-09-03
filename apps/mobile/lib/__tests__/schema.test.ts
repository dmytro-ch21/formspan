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
  expect(row.user_version).toBe(33);
});

it('a fresh install has the sequences outbox', async () => {
  // The version bump on its own proves nothing — it is a number in a file.
  // This is what the bump was FOR, and it also covers the shape the push loop
  // depends on: without `dirty` the outbox has no way to know what it owes,
  // and without `user_id` a shared phone pushes one athlete's captures under
  // the next one's token.
  const db = await migratedFixture();
  const cols = (db.raw.prepare('PRAGMA table_info(sequences)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toEqual(
    expect.arrayContaining(['id', 'user_id', 'name', 'steps_json', 'dirty', 'remote', 'last_error']),
  );
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
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
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
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

it('upgrading a v15-shaped database does not mark every cached name as owed', async () => {
  // The DIRECTION is the whole risk, and this has to take the real upgrade
  // path to prove anything. An earlier version of this test used
  // `openFixture()` + `migrate()` — a blank database at v0, i.e. a FRESH
  // INSTALL — so it only ever exercised the CREATE statement, which already
  // declares the column. Deleting the entire `if (current < 16)` branch left
  // it green, which is exactly the "passes for the wrong reason" this suite
  // exists to catch. A review found it; the v6/v7 tests above had the right
  // idiom all along.
  //
  // The full v15 shape, not just the table under test: a real device at v15
  // has every earlier table, and `migrate` skips the branches that created
  // them, so a one-table fixture makes a later `addColumnIfMissing` throw
  // "no such table" for a reason no device could hit.
  const db = openFixture();
  db.raw.exec(`
    CREATE TABLE local_sessions (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, workout_id TEXT,
      sport TEXT NOT NULL, name TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, notes TEXT NOT NULL DEFAULT '',
      sets_json TEXT NOT NULL DEFAULT '[]', dirty INTEGER NOT NULL DEFAULT 1,
      remote INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
      updated_at TEXT NOT NULL, name_dirty INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, bjj_json TEXT);
    CREATE TABLE workout_cache (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, sport TEXT NOT NULL,
      name TEXT NOT NULL, goal TEXT, items_json TEXT NOT NULL DEFAULT '[]',
      owner_user_id TEXT, visibility TEXT NOT NULL DEFAULT 'private',
      dirty INTEGER NOT NULL DEFAULT 0, remote INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT, updated_at TEXT NOT NULL DEFAULT '',
      last_error TEXT, cached_at TEXT NOT NULL);
    PRAGMA user_version = 15;
  `);
  // A row that came FROM the server, which is what every v15 row is.
  db.raw
    .prepare(
      `INSERT INTO workout_cache (id, user_id, sport, name, items_json, cached_at)
       VALUES ('w1', 'u1', 'strength', 'Legs', '[]', '2026-08-04T00:00:00Z')`,
    )
    .run();

  await migrate(db as never);

  const cols = (db.raw.prepare('PRAGMA table_info(workout_cache)').all() as { name: string }[])
    .map((c) => c.name);
  expect(cols).toContain('name_dirty');
  // 0, not 1. Its name is whatever the server already holds, so it owes no
  // PATCH. Defaulting to 1 would make the first sync after upgrade re-send
  // every cached template's name — including VOLA's ownerless ones, which the
  // server refuses with a 403 the outbox would then hold forever.
  const row = db.raw
    .prepare(`SELECT name_dirty FROM workout_cache WHERE id = 'w1'`)
    .get() as { name_dirty: number };
  expect(row.name_dirty).toBe(0);
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
});

it('a fresh install has the food log', async () => {
  // The version bump on its own proves nothing — it is a number in a file.
  // This is what the bump was FOR, and it covers the shape the outbox depends
  // on: without `dirty` there is no way to know what is owed, and without
  // `deleted_at` a delete made offline is indistinguishable from one that
  // never happened.
  const db = await migratedFixture();

  const entries = (
    db.raw.prepare('PRAGMA table_info(food_entries)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(entries).toEqual(
    expect.arrayContaining([
      'id',
      'user_id',
      'eaten_on',
      'meal',
      'name',
      'servings',
      'serving_label',
      'kcal',
      'protein_g',
      'source_food_id',
      'dirty',
      'remote',
      'deleted_at',
      'last_error',
      'updated_at',
    ]),
  );

  const foods = (db.raw.prepare('PRAGMA table_info(foods)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(foods).toEqual(
    expect.arrayContaining([
      'id',
      'user_id',
      'kind',
      'name',
      'serving_label',
      'kcal',
      // Pushed and pulled: how the row was produced (N114). `ai` marks a food
      // saved from a draft nobody measured, and it has to stay tellable apart
      // from one the athlete typed.
      'source',
      // Local-only and never pulled. This pair is what makes the quick-add
      // list a single indexed read rather than a network round trip, which is
      // the whole of the two-tap repeat.
      'last_used_at',
      'use_count',
      'dirty',
      'remote',
      'deleted_at',
      'cached_at',
    ]),
  );
});

it('upgrades a v17-shaped database by adding the food log', async () => {
  // The path a real device takes: a v17 database, upgraded in place.
  //
  // BE HONEST ABOUT WHAT THIS COVERS. Deleting the whole `if (current < 18)`
  // block leaves this test GREEN, because the unconditional
  // `CREATE TABLE IF NOT EXISTS` section above the versioned branches recreates
  // both tables on every call — which is `db.ts`'s documented contract, not a
  // bug. What that block uniquely contributes is the two INDEXES, so the index
  // test below is the one that actually fails when it goes missing.
  //
  // This test still earns its place: it proves the upgrade path reaches v18 at
  // all and does not throw part-way, which is how a half-applied migration
  // would present.
  const db = await migratedFixture();
  db.raw.exec('DROP TABLE food_entries; DROP TABLE foods; PRAGMA user_version = 17;');

  await migrate(db as never);

  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
  const tables = (
    db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(tables).toEqual(expect.arrayContaining(['food_entries', 'foods']));
});

it('upgrades a v18-shaped database by adding the target cache', async () => {
  // The case that made this a NEW version rather than an extension of 18.
  // `migrate()` returns early at `current >= SCHEMA_VERSION`, so a device
  // already stamped 18 — every dev machine that has run this branch — would
  // never reach the unconditional CREATE section and would simply not have the
  // table.
  //
  // BE HONEST ABOUT WHAT THIS COVERS, exactly as the v17 test above is. The
  // load-bearing thing is the VERSION BUMP, not the `if (current < 19)` block:
  // deleting that block leaves this green, because the unconditional section
  // recreates the table once the early return is no longer taken. Reverting
  // SCHEMA_VERSION to 18 is the mutation this catches — verified, and it takes
  // four tests in this file red with it.
  const db = await migratedFixture();
  db.raw.exec('DROP TABLE nutrition_targets; PRAGMA user_version = 18;');

  await migrate(db as never);

  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
  const tables = (
    db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(tables).toContain('nutrition_targets');
});

it('upgrades a v19-shaped database by adding the barcode cache', async () => {
  // Same shape as the v18 case above, and the same honesty about what it
  // covers: the load-bearing thing is the VERSION BUMP, not the
  // `if (current < 20)` block. Deleting that block leaves this green, because
  // the unconditional CREATE section recreates the table once the early return
  // is no longer taken. Reverting SCHEMA_VERSION to 19 is what this catches —
  // a device already stamped 19 would return early, never reach the
  // unconditional section, and simply not have the table, so every barcode
  // scan on it would fail to cache with no error anywhere.
  const db = await migratedFixture();
  db.raw.exec('DROP TABLE barcode_cache; PRAGMA user_version = 19;');

  await migrate(db as never);

  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
  const tables = (
    db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(tables).toContain('barcode_cache');
});

it('the food log is indexed on the two reads that matter', async () => {
  // Not decoration: the day screen queries (user_id, eaten_on) on every focus,
  // and the foods pull upserts the whole catalog on every sync. A missing index
  // here is a scan on the tables expected to grow fastest.
  const db = await migratedFixture();
  const idx = (
    db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as { name: string }[]
  ).map((i) => i.name);
  expect(idx).toEqual(
    expect.arrayContaining(['food_entries_user_day_idx', 'foods_user_recent_idx']),
  );
});

it('a fresh install has both daily-tracker tables, with the outbox columns', async () => {
  // The version bump on its own proves nothing — it is a number in a file.
  // This is what the bump was FOR. Both shapes matter to the push loop:
  // without `dirty` the outbox cannot know what it owes, without `deleted_at`
  // an offline delete undoes itself on the next pull, and without `user_id` a
  // shared phone pushes one athlete's water under the next one's token.
  const db = await migratedFixture();
  const cols = (t: string) =>
    (db.raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

  expect(cols('daily_trackers')).toEqual(
    expect.arrayContaining([
      'id', 'user_id', 'preset', 'name', 'icon', 'color_key', 'unit',
      'increment', 'target', 'render_style', 'sort_order', 'archived_at',
      'updated_at', 'dirty', 'remote', 'last_error',
    ]),
  );
  expect(cols('tracker_entries')).toEqual(
    expect.arrayContaining([
      'id', 'tracker_id', 'user_id', 'logged_on', 'logged_at', 'amount',
      'updated_at', 'dirty', 'remote', 'deleted_at', 'last_error',
    ]),
  );
});

it('a device already stamped 20 reaches the tracker tables', async () => {
  // The upgrade path, which is what the version bump exists for: every dev
  // machine and every installed build is stamped 20, and `migrate()` returns
  // early at `current >= SCHEMA_VERSION`. Reverting SCHEMA_VERSION to 20 is
  // what this catches — those devices would simply not have the tables, and
  // every tap would fail with no error anywhere.
  const db = await migratedFixture();
  db.raw.exec('DROP TABLE tracker_entries; DROP TABLE daily_trackers; PRAGMA user_version = 20;');

  await migrate(db as never);

  const tables = (
    db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(tables).toContain('daily_trackers');
  expect(tables).toContain('tracker_entries');
});

it('a device already stamped 21 gains foods.source', async () => {
  // **The first upgrade in this file that is a real ALTER rather than a
  // re-runnable CREATE**, and that is why it needs its own test. Versions
  // 19/20/21 each added a whole TABLE, so the unconditional `CREATE TABLE IF
  // NOT EXISTS` block above already covers any device that reaches it — those
  // branches are no-ops and the BUMP is the whole fix.
  //
  // A COLUMN has no such backstop: `CREATE TABLE IF NOT EXISTS foods` does
  // nothing at all on a device that already has the table, so a stamped-21
  // device without this branch keeps a `foods` table with no `source` column
  // and every read of it throws — which is every quick-add, every recents list
  // and every food push, with no error anywhere saying why.
  const db = await migratedFixture();
  db.raw.exec('ALTER TABLE foods DROP COLUMN source; PRAGMA user_version = 21;');

  await migrate(db as never);

  const cols = (db.raw.prepare('PRAGMA table_info(foods)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toContain('source');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
});

it('re-running the source migration is not an error', async () => {
  // `migrate()` must be safe to re-enter: a run that failed after the ALTER and
  // before the version stamp would otherwise hit `duplicate column name`
  // forever, and this file's own comment calls that "every offline feature dead
  // on arrival, on exactly the path a new user takes".
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 21;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (db.raw.prepare('PRAGMA table_info(foods)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols.filter((c) => c === 'source')).toHaveLength(1);
});

it('a device already stamped 23 gains the recipe columns', async () => {
  // Same class as `foods.source` above — a real ALTER with no `CREATE TABLE IF
  // NOT EXISTS` backstop — and the failure is quieter than that one was. A
  // stamped-22 device without this branch keeps a `foods` table with no `items`
  // column, so every read of a saved food throws: the quick-add sheet, the
  // recents list and the outbox push all at once.
  const db = await migratedFixture();
  db.raw.exec(
    'ALTER TABLE foods DROP COLUMN yield_servings;'
    + ' ALTER TABLE foods DROP COLUMN items;'
    + ' PRAGMA user_version = 23;',
  );

  await migrate(db as never);

  const cols = (db.raw.prepare('PRAGMA table_info(foods)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toContain('yield_servings');
  expect(cols).toContain('items');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
});

it('backfills a pre-existing food with an empty ingredient list, not a null', async () => {
  // The empty-vs-unknown collapse, at the one moment it would be introduced.
  // A food saved before N87 has no ingredients — that is a FACT about it, not a
  // question nobody asked — so the upgrade has to leave a value every reader
  // can act on. A nullable column here would make `hydrate` and every future
  // caller invent their own answer, and the honest-looking one ("we don't know
  // yet") is wrong for every row this backfill touches.
  const db = await migratedFixture();
  db.raw.exec(
    'ALTER TABLE foods DROP COLUMN yield_servings;'
    + ' ALTER TABLE foods DROP COLUMN items;'
    + ' PRAGMA user_version = 23;',
  );
  db.raw
    .prepare(
      `INSERT INTO foods (id, user_id, kind, name, brand, serving_label,
         kcal, protein_g, carb_g, fat_g, created_at, updated_at, cached_at)
       VALUES ('old', 'u', 'food', 'Skyr', '', '100 g', 63, 11, 4, 0.2, '', '', '')`,
    )
    .run();

  await migrate(db as never);

  const row = db.raw.prepare(`SELECT yield_servings, items FROM foods WHERE id = 'old'`).get() as {
    yield_servings: number | null;
    items: string;
  };
  expect(row.yield_servings).toBeNull();
  expect(row.items).toBe('[]');
});

it('re-running the recipe migration is not an error', async () => {
  // Same re-entrancy guarantee the `source` migration has, and the reason this
  // one routes through `addColumnIfMissing` rather than a hand-rolled check.
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 23;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (db.raw.prepare('PRAGMA table_info(foods)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols.filter((c) => c === 'items')).toHaveLength(1);
  expect(cols.filter((c) => c === 'yield_servings')).toHaveLength(1);
});

const N52_COLS = ['saturated_fat_g', 'sugar_g', 'added_sugar_g', 'sodium_mg', 'cholesterol_mg'];

it('a device already stamped 24 gains the N52 label macros on all three tables', async () => {
  // Same class as `foods.source` and the recipe columns above — real ALTERs
  // with no `CREATE TABLE IF NOT EXISTS` backstop. A stamped-24 device
  // without this branch keeps `food_entries`, `foods` and `barcode_cache`
  // without these columns, and the moment `Macros` requires them every read
  // of any of the three throws.
  const db = await migratedFixture();
  db.raw.exec(
    N52_COLS.map((c) => `ALTER TABLE food_entries DROP COLUMN ${c};`).join(' ')
      + N52_COLS.map((c) => `ALTER TABLE foods DROP COLUMN ${c};`).join(' ')
      + N52_COLS.map((c) => `ALTER TABLE barcode_cache DROP COLUMN ${c};`).join(' ')
      + ' PRAGMA user_version = 24;',
  );

  await migrate(db as never);

  for (const table of ['food_entries', 'foods', 'barcode_cache']) {
    const cols = (db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const c of N52_COLS) expect(cols).toContain(c);
  }
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
});

it('re-running the N52 label-macro migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 24;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (db.raw.prepare('PRAGMA table_info(foods)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  for (const c of N52_COLS) expect(cols.filter((name) => name === c)).toHaveLength(1);
});

const N117_COLS = ['packet_serving_label', 'packet_serving_grams'];

it('a device already stamped 25 gains the packet-serving columns on barcode_cache (N117)', async () => {
  // Same class as the N52 columns above — a real ALTER with no `CREATE TABLE
  // IF NOT EXISTS` backstop. A stamped-25 device without this branch keeps
  // `barcode_cache` without these two, and the moment `ScannedFood` requires
  // them every read throws.
  //
  // ONLY `barcode_cache` — deliberately, unlike the N52 loop above which
  // touched three tables. Neither `foods` nor `food_entries` is scanned from
  // a packet, so neither has a "the packet also said" to remember.
  const db = await migratedFixture();
  db.raw.exec(
    N117_COLS.map((c) => `ALTER TABLE barcode_cache DROP COLUMN ${c};`).join(' ')
      + ' PRAGMA user_version = 25;',
  );

  await migrate(db as never);

  const cols = (
    db.raw.prepare('PRAGMA table_info(barcode_cache)').all() as { name: string }[]
  ).map((c) => c.name);
  for (const c of N117_COLS) expect(cols).toContain(c);
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
});

it('re-running the N117 packet-serving migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 25;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (
    db.raw.prepare('PRAGMA table_info(barcode_cache)').all() as { name: string }[]
  ).map((c) => c.name);
  for (const c of N117_COLS) expect(cols.filter((name) => name === c)).toHaveLength(1);
});

it("a tracker's target may be NULL, because a count with no goal is a real state", async () => {
  // Not a formality: a NOT NULL here would make N77's coffee card impossible to
  // express, and the tempting fix at that point is a sentinel 0 — which then
  // renders as "0 of 0" at an athlete who asked for no target at all.
  const db = await migratedFixture();
  await db.runAsync(
    `INSERT INTO daily_trackers (id, user_id, name, color_key, increment, target)
     VALUES ('t1', 'u1', 'Coffee', 'coffee', 1, NULL)`,
  );
  const row = await db.getFirstAsync<{ target: number | null }>(
    `SELECT target FROM daily_trackers WHERE id = 't1'`,
  );
  expect(row?.target).toBeNull();
});

it('the tracker entries are indexed on the read the card runs', async () => {
  // The day query runs on every focus of Today AND of Food, for every tracker.
  // A missing index here is a scan on the table expected to grow fastest —
  // several rows a day, forever.
  const db = await migratedFixture();
  const idx = (
    db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
  ).map((i) => i.name);
  expect(idx).toContain('tracker_entries_user_day_idx');
});


it('upgrades a pre-N78 database by adding the tracker columns', async () => {
  // Stamped 21 so BOTH later blocks run — N114's `foods.source` at 22 and
  // N78's tracker columns at 23. The version this branch adds moved from 22 to
  // 23 during a rebase, because N114 took 22 while it was open.
  //
  // **A REAL ALTER, unlike the v18/v19/v20 cases above.** Those are no-ops
  // against the unconditional CREATE section and only the version bump is
  // load-bearing. This one is not: a device already stamped 21 HAS
  // `daily_trackers`, so its CREATE IF NOT EXISTS does nothing and the three
  // columns can only arrive through `addColumnIfMissing`.
  //
  // Which means this is also the test that covers the fresh-install hazard that
  // helper exists for — a fresh database gets all three from the CREATE, and
  // the ALTERs must then do nothing rather than throwing and leaving
  // `user_version` unstamped, which wedges `getDb()` for the life of the
  // install. Every other test in this file reaching version 22 is that half.
  const db = await migratedFixture();
  db.raw.exec(`
    DROP TABLE daily_trackers;
    CREATE TABLE daily_trackers (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      preset TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      color_key TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      increment REAL NOT NULL,
      target REAL,
      render_style TEXT NOT NULL DEFAULT 'auto',
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      dirty INTEGER NOT NULL DEFAULT 0,
      remote INTEGER NOT NULL DEFAULT 1,
      last_error TEXT
    );
    PRAGMA user_version = 21;
  `);
  // Three rows in the v21 shape, one per backfill branch: the water every
  // athlete already has, a gram tracker, and one that counts bare.
  db.raw.exec(`
    INSERT INTO daily_trackers (id, user_id, preset, name, color_key, unit, increment)
    VALUES ('t_w', 'u1', 'water', 'Water', 'water', 'ml', 250),
           ('c1', 'u1', '', 'Creatine', 'water', 'g', 5),
           ('c2', 'u1', '', 'Cold showers', 'water', '', 1);
  `);

  await migrate(db as never);

  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
  const cols = (
    db.raw.prepare('PRAGMA table_info(daily_trackers)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining(['count_noun', 'restore_pending', 'destroyed_at']));

  // The BACKFILL, which is the half a column check cannot see. Without it every
  // existing card silently loses its noun on upgrade — water's "4 of 8 cups"
  // becomes "4 of 8" — because the noun is read off the row now rather than
  // derived at render time. The bare-count row must stay empty, so this cannot
  // pass by filling everything in.
  const nouns = Object.fromEntries(
    (
      db.raw
        .prepare('SELECT id, count_noun FROM daily_trackers ORDER BY id')
        .all() as { id: string; count_noun: string }[]
    ).map((r) => [r.id, r.count_noun]),
  );
  expect(nouns).toEqual({ t_w: 'cup', c1: 'dose', c2: '' });
});

it('a device already stamped 26 gains cutoff_minutes on daily_trackers (N431)', async () => {
  // Same class as the N117 packet-serving columns above: a real ALTER with no
  // `CREATE TABLE IF NOT EXISTS` backstop, so a stamped-26 device without this
  // branch keeps `daily_trackers` with no `cutoff_minutes` and every read that
  // selects it — `toTracker` in `lib/trackers.ts` does, unconditionally —
  // throws "no such column".
  const db = await migratedFixture();
  db.raw.exec(`
    ALTER TABLE daily_trackers DROP COLUMN cutoff_minutes;
    INSERT INTO daily_trackers (id, user_id, preset, name, color_key, unit, increment)
    VALUES ('t_w', 'u1', 'water', 'Water', 'water', 'ml', 250);
    PRAGMA user_version = 26;
  `);

  await migrate(db as never);

  const cols = (
    db.raw.prepare('PRAGMA table_info(daily_trackers)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toContain('cutoff_minutes');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });

  // No backfill to check — unlike count_noun above, NULL ("no cutoff
  // configured") is exactly the right value for every row that predates the
  // column, not a placeholder that needs deriving.
  const row = db.raw
    .prepare("SELECT cutoff_minutes FROM daily_trackers WHERE id = 't_w'")
    .get() as { cutoff_minutes: number | null };
  expect(row.cutoff_minutes).toBeNull();
});

it('re-running the N431 cutoff migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 26;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (
    db.raw.prepare('PRAGMA table_info(daily_trackers)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols.filter((name) => name === 'cutoff_minutes')).toHaveLength(1);
});

it('a device already stamped 27 gains started_at_dirty on local_sessions (N436)', async () => {
  // Same class as N431's cutoff_minutes above: a real ALTER with no
  // `CREATE TABLE IF NOT EXISTS` backstop, so a stamped-27 device without
  // this branch keeps `local_sessions` with no `started_at_dirty` and
  // `pushRow`'s SELECT * — every push of every session — throws "no such
  // column" the moment this ships.
  const db = await migratedFixture();
  db.raw.exec(`
    ALTER TABLE local_sessions DROP COLUMN started_at_dirty;
    INSERT INTO local_sessions
      (id, user_id, sport, name, started_at, notes, sets_json, dirty, remote, updated_at)
    VALUES ('s1', 'u1', 'bjj', 'Class', '2026-08-01T09:00:00Z', '', '[]', 0, 1, '2026-08-01T09:00:00Z');
    PRAGMA user_version = 27;
  `);

  await migrate(db as never);

  const cols = (
    db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toContain('started_at_dirty');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });

  // No backfill to check: an existing row has never had a LOCAL date
  // correction pending, so 0 ("nothing owed") is exactly right, not a
  // placeholder needing derivation — same posture as N431's cutoff_minutes.
  const row = db.raw
    .prepare("SELECT started_at_dirty FROM local_sessions WHERE id = 's1'")
    .get() as { started_at_dirty: number };
  expect(row.started_at_dirty).toBe(0);
});

it('re-running the N436 started_at_dirty migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 27;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (
    db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols.filter((name) => name === 'started_at_dirty')).toHaveLength(1);
});

it('a device already stamped 28 gains class_plan_id on planned_sessions (N442)', async () => {
  // Same class as N431's cutoff_minutes and N436's started_at_dirty above: a
  // real ALTER with no `CREATE TABLE IF NOT EXISTS` backstop, so a
  // stamped-28 device without this branch keeps `planned_sessions` with no
  // `class_plan_id` and the sync pull's INSERT — which always names the
  // column — throws "table planned_sessions has no column named
  // class_plan_id" the moment this ships.
  const db = await migratedFixture();
  db.raw.exec(`
    ALTER TABLE planned_sessions DROP COLUMN class_plan_id;
    INSERT INTO planned_sessions
      (id, user_id, day, sport, workout_id, notes, created_at, updated_at, dirty, remote)
    VALUES ('p1', 'u1', '2026-08-05', 'bjj', NULL, '', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 0, 1);
    PRAGMA user_version = 28;
  `);

  await migrate(db as never);

  const cols = (
    db.raw.prepare('PRAGMA table_info(planned_sessions)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toContain('class_plan_id');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });

  // No backfill to check, and deliberately so: this app never WRITES the
  // column (see CREATE_PLANNED's own comment), so an existing row simply has
  // no class plan until the next pull says otherwise — NULL is exactly
  // right, not a placeholder needing derivation.
  const row = db.raw
    .prepare("SELECT class_plan_id FROM planned_sessions WHERE id = 'p1'")
    .get() as { class_plan_id: string | null };
  expect(row.class_plan_id).toBeNull();
});

it('re-running the N442 class_plan_id migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 28;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (
    db.raw.prepare('PRAGMA table_info(planned_sessions)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols.filter((name) => name === 'class_plan_id')).toHaveLength(1);
});

it('a device already stamped 29 gains category on food_entries (N124/N113)', async () => {
  // Same class as N442's class_plan_id above: a real ALTER with no
  // `CREATE TABLE IF NOT EXISTS` backstop. A stamped-29 device without this
  // branch keeps `food_entries` with no `category`, and the glyph derivation
  // (N58/#375) that reads it throws the moment this ships.
  const db = await migratedFixture();
  db.raw.exec(`
    ALTER TABLE food_entries DROP COLUMN category;
    INSERT INTO food_entries
      (id, user_id, eaten_on, meal, name, servings, serving_label, kcal,
       protein_g, carb_g, fat_g, notes, logged_at, updated_at, dirty, remote)
    VALUES ('e1', 'u1', '2026-08-05', 'lunch', 'Chicken thigh', 1, '100 g', 180,
            25, 0, 8, '', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 0, 1);
    PRAGMA user_version = 29;
  `);

  await migrate(db as never);

  const cols = (
    db.raw.prepare('PRAGMA table_info(food_entries)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toContain('category');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });

  // No backfill, and deliberately so — an existing entry predates the column
  // entirely and genuinely has no category to give it. NULL is the honest
  // answer, exactly as it is for a fresh row with no catalog source; see
  // `Entry.category`'s own doc comment.
  const row = db.raw
    .prepare("SELECT category FROM food_entries WHERE id = 'e1'")
    .get() as { category: string | null };
  expect(row.category).toBeNull();
});

it('re-running the N124/N113 category migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 29;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (
    db.raw.prepare('PRAGMA table_info(food_entries)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols.filter((name) => name === 'category')).toHaveLength(1);
});

it('local_sessions can hold a running track (N460)', async () => {
  // v31. Nullable on purpose, same reasoning as bjj_json (v13): the push
  // path uses "is running_json null?" to decide whether a session needs a
  // running detail PUT at all, so defaulting it to '{}' would make every
  // strength or BJJ session attempt one.
  const db = await migratedFixture();
  const cols = db.raw.prepare('PRAGMA table_info(local_sessions)').all() as {
    name: string;
    notnull: number;
  }[];
  const running = cols.find((c) => c.name === 'running_json');
  expect(running).toBeDefined();
  expect(running?.notnull).toBe(0);
});

it('a device already stamped 30 gains running_json on local_sessions (N460)', async () => {
  // Real ALTER, same class as N442's class_plan_id and N124/N113's category
  // above: a stamped-30 device without this branch keeps `local_sessions`
  // with no `running_json`, and the live-tracking screen's push path
  // throws the moment it tries to save a track.
  const db = await migratedFixture();
  db.raw.exec(`
    ALTER TABLE local_sessions DROP COLUMN running_json;
    PRAGMA user_version = 30;
  `);

  await migrate(db as never);

  const cols = (
    db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toContain('running_json');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
});

it('re-running the N460 running_json migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 30;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (
    db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols.filter((name) => name === 'running_json')).toHaveLength(1);
});

it('a fresh install has the healthkit_imports ledger (N465)', async () => {
  // v32. The local half of "don't import a HealthKit run twice" — see
  // CREATE_HEALTHKIT_IMPORTS's own doc comment in db.ts for why this is a
  // dedicated table rather than a scan over every session's running_json.
  const db = await migratedFixture();
  const cols = (
    db.raw.prepare('PRAGMA table_info(healthkit_imports)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toEqual(
    expect.arrayContaining(['user_id', 'healthkit_uuid', 'session_id', 'imported_at']),
  );
});

it('a device already stamped 31 gains the healthkit_imports table (N465)', async () => {
  // Same class as "a device already stamped 20 reaches the tracker tables"
  // above: every dev machine and every installed build is stamped 31 as of
  // this ticket, and `migrate()` returns early at `current >= SCHEMA_VERSION`
  // — reverting SCHEMA_VERSION to 31 is what this catches. Without the
  // table, importHealthKitRuns's ledger reads/writes would throw the moment
  // the toggle was ever turned on.
  const db = await migratedFixture();
  db.raw.exec('DROP TABLE healthkit_imports; PRAGMA user_version = 31;');

  await migrate(db as never);

  const tables = (
    db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(tables).toContain('healthkit_imports');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });
});

it('re-running the N465 healthkit_imports migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 31;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const tables = (
    db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(tables.filter((name) => name === 'healthkit_imports')).toHaveLength(1);
});

it('a fresh install has intent on local_sessions, defaulted to normal (N474)', async () => {
  // v33. NOT NULL DEFAULT 'normal' — see the migration block's own comment in
  // db.ts for why a default is the honest value here, unlike category/bjj_json
  // above where NULL is the honest answer for a fact nothing before them ever
  // asked. `upsert`'s INSERT relies on every row having a real value; a
  // nullable column here would need every read site to fall back to 'normal'
  // itself instead of the database doing it once.
  const db = await migratedFixture();
  const cols = db.raw.prepare('PRAGMA table_info(local_sessions)').all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const intent = cols.find((c) => c.name === 'intent');
  expect(intent).toBeDefined();
  expect(intent?.notnull).toBe(1);
  expect(intent?.dflt_value).toBe("'normal'");
});

it('a device already stamped 32 gains intent on local_sessions, backfilled to normal (N474)', async () => {
  // Same class as N460/N465 above: every dev machine and every installed
  // build predating this ticket is stamped 32, and `migrate()` returns early
  // at `current >= SCHEMA_VERSION` — reverting SCHEMA_VERSION to 32 is what
  // this catches. Without the column, `startLocalSession` and `upsert`'s
  // INSERT both throw the moment either runs on an un-migrated device.
  const db = await migratedFixture();
  db.raw.exec(`
    ALTER TABLE local_sessions DROP COLUMN intent;
    PRAGMA user_version = 32;
  `);

  await migrate(db as never);

  const cols = (
    db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toContain('intent');
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 });

  // A row that existed before the column did is backfilled, not left NULL —
  // it really was a normal session, there is nothing else it could have
  // meant. Sessions started after this migration get 'normal' from
  // startLocalSession itself; this checks the column's own default covers a
  // row nothing in the app wrote it for.
  db.raw.exec(
    `INSERT INTO local_sessions (id, user_id, workout_id, sport, name, started_at, ended_at, notes, sets_json, dirty, remote, updated_at)
     VALUES ('s1', 'u1', NULL, 'strength', 'Back', '2026-08-01T10:00:00Z', NULL, '', '[]', 0, 1, '2026-08-01T10:00:00Z')`,
  );
  const row = db.raw
    .prepare(`SELECT intent FROM local_sessions WHERE id = 's1'`)
    .get() as { intent: string };
  expect(row.intent).toBe('normal');
});

it('re-running the N474 intent migration is not an error', async () => {
  const db = await migratedFixture();
  db.raw.exec('PRAGMA user_version = 32;');

  await expect(migrate(db as never)).resolves.toBeUndefined();

  const cols = (
    db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols.filter((name) => name === 'intent')).toHaveLength(1);
});
