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
    -- This device holds a value the account has not heard.
    --
    -- Replaces the bespoke per-key OWED companion keys, which worked but did not
    -- generalise: every new syncable preference needed its own flag, its own
    -- read, and its own clear, and forgetting one meant a preference that
    -- silently reverted on the next profile fetch.
    dirty INTEGER NOT NULL DEFAULT 0,
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
    -- The outbox half, mirroring local_sessions exactly.
    --
    -- 0 = the server holds this; 1 = we owe it a push. 'remote' is 1 once the
    -- server has acknowledged the workout EXISTS, which is separate from its
    -- contents being current -- a plan can be dirty and remote at the same
    -- time, which is the ordinary state while you edit one.
    dirty INTEGER NOT NULL DEFAULT 0,
    remote INTEGER NOT NULL DEFAULT 1,
    -- 1 while this row's NAME has not reached the server.
    --
    -- Separate from 'dirty' because the two are cleared by different requests:
    -- 'dirty' is owed to PUT /items, this is owed to PATCH /workouts/{id}. One
    -- flag for both would make every item edit also PATCH the name, which is
    -- the extra request per debounced write that local_sessions already
    -- learned to avoid.
    name_dirty INTEGER NOT NULL DEFAULT 0,
    -- Set when deleted here; the row survives until the server agrees. Same
    -- tombstone rules as sessions, for the same reason: a hard delete leaves
    -- nothing carrying the intent when the push fails.
    deleted_at TEXT,
    -- Bumped on every local write. The push CASes on it, so an edit landing
    -- mid-push leaves the row dirty for the next pass instead of being
    -- marked as already sent.
    updated_at TEXT NOT NULL DEFAULT '',
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
    -- The whole exercise as the API sent it.
    --
    -- The typed columns above are what queries filter and sort on; this is
    -- what makes the cached copy the SAME OBJECT the network returns. Without
    -- it the cache was lossy in a way that only showed up offline: muscles,
    -- equipment and instructions were reconstructed as empty, so the Library
    -- rendered an exercise with no detail and no explanation of why.
    payload_json TEXT,
    cached_at TEXT NOT NULL
  );
`;

/**
 * The week's plan: what the athlete intends to train, and on which day.
 *
 * **An outbox, like every other table here** — as of v15. It shipped
 * local-only for one version, before `/v1/plans` existed; the columns that
 * make it syncable (`dirty`, `remote`, `deleted_at`, `updated_at`,
 * `last_error`) were added by that migration and mean the same things they do
 * on `local_sessions` and `workout_cache`.
 *
 * `day` is a local calendar date (`YYYY-MM-DD`), not a timestamp: "Tuesday's
 * session" is a claim about the athlete's calendar, and storing an instant
 * would slide the plan across a day boundary whenever they travel. The server
 * column is a DATE for the same reason, so the string goes over the wire
 * unchanged in both directions.
 *
 * `workout_id` is nullable so a day can be planned as a bare discipline —
 * "Tuesday is BJJ" is a complete plan, and the mat sessions this app is built
 * around have no template at all. `sport` is the required half, not the
 * workout.
 *
 * No foreign key to `workout_cache`: that cache is refilled from the server
 * and its rows come and go, so a constraint would delete the plan whenever the
 * cache was rebuilt. A plan pointing at a workout that is no longer cached
 * degrades to its sport alone rather than vanishing. (The *server* does have
 * that FK, which is why the push path defers a plan whose workout has not
 * landed yet — same dependency ordering sessions already have.)
 *
 * `updated_at` defaults to '' rather than a timestamp so the v15 backfill can
 * find rows that predate it with `WHERE updated_at = ''`. Every insert sets it
 * explicitly, so a fresh install never holds the empty string.
 */
const CREATE_PLANNED = `
  CREATE TABLE IF NOT EXISTS planned_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    sport TEXT NOT NULL,
    workout_id TEXT,
    -- N442: a plan scheduled from a coach's class plan instead of a workout
    -- template. Mutually exclusive with workout_id server-side, but NEVER
    -- written by this app — scheduling is web-only (see WeekPlanner.tsx's
    -- own comment on plannedClassPlanTarget), so this column only ever
    -- arrives via a sync pull. Nullable and untouched by every local write
    -- function for exactly that reason.
    class_plan_id TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT '',
    dirty INTEGER NOT NULL DEFAULT 1,
    remote INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    last_error TEXT
  );
`;

/**
 * Sequences captured on the phone, and the outbox that owes them to the server.
 *
 * WHY THIS TABLE EXISTS AT ALL, given the web builder already writes them:
 * the capture moment is the changing room after class, which is a gym
 * dead-spot more often than not. The backend shipped asserting there was "no
 * offline creation to make idempotent" — true of the desk builder and wrong
 * within a day. `id` is generated HERE for exactly that reason: it is what
 * makes the sync retry idempotent, same as activities and workouts.
 *
 * STEPS ARE ONE JSON COLUMN, not a child table. Locally a chain is written and
 * pushed whole and never queried step-wise, so a second table buys a join and
 * a second migration and nothing else. The ORDER inside that array is the
 * content — see the server's UNIQUE (sequence_id, sort_order) — so the array is
 * stored and pushed as-is rather than being re-sorted anywhere.
 *
 * `dirty`/`remote`/`last_error` follow planned_sessions rather than the older
 * `synced` flag: `remote = 0` means the server has never seen this row, which
 * is what tells a failed push apart from a row that was never pushed.
 */
const CREATE_SEQUENCES = `
  CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_position_id TEXT,
    steps_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1,
    remote INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
`;

/**
 * One logged item of food.
 *
 * Push-only, like `sequences`: the phone is where food is logged, and a day
 * corrected on web is rare enough that a pull would be machinery serving
 * almost nobody. If that changes, `workout_cache` is the shape to copy, not
 * this one.
 *
 * `eaten_on` is a LOCAL calendar date (`YYYY-MM-DD`), written by `dayString`
 * and never `toISOString().slice(0,10)` — the same rule `planned_sessions.day`
 * carries, and for a sharper reason here: west of Greenwich a 22:00 snack
 * would land on tomorrow, and the remaining figure would then be wrong on two
 * days at once.
 *
 * The macros are stored ABSOLUTE for the quantity logged, already multiplied
 * by `servings`. The server never scales, and neither does this table — which
 * is what lets the day screen render offline with no join, exactly as
 * `exercise_cache.payload_json` does for the catalog.
 */
const CREATE_FOOD_ENTRIES = `
  CREATE TABLE IF NOT EXISTS food_entries (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    eaten_on TEXT NOT NULL,
    meal TEXT NOT NULL,
    name TEXT NOT NULL,
    servings REAL NOT NULL DEFAULT 1,
    serving_label TEXT NOT NULL,
    kcal REAL NOT NULL,
    protein_g REAL NOT NULL DEFAULT 0,
    carb_g REAL NOT NULL DEFAULT 0,
    fat_g REAL NOT NULL DEFAULT 0,
    fibre_g REAL,
    saturated_fat_g REAL,
    sugar_g REAL,
    added_sugar_g REAL,
    sodium_mg REAL,
    cholesterol_mg REAL,
    source_food_id TEXT,
    -- N124/N113: a COPY from the catalog food this row was logged from, if
    -- any — the glyph derivation (N58/#375) draws from this and nothing else.
    -- Null for the ordinary case today (a saved food, an AI draft, a barcode
    -- scan), and null is the honest answer, not a gap — see Entry.category's
    -- own doc comment in nutrition.ts. (No backticks in here: this is inside
    -- a template literal.)
    category TEXT,
    notes TEXT NOT NULL DEFAULT '',
    logged_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1,
    remote INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    last_error TEXT
  );
`;

/**
 * The athlete's saved foods, cached.
 *
 * Pulls AND pushes, so this is `workout_cache`'s shape rather than
 * `sequences`': web authors recipes, the phone saves what it just ate, and
 * both have to survive the other. Hence `remote DEFAULT 1` (a row that arrived
 * from the server owes nothing), `deleted_at` tombstones, and `updated_at` for
 * the compare-and-swap that stops a push clearing an edit made while it was in
 * flight.
 *
 * `last_used_at` and `use_count` are DELIBERATELY LOCAL-ONLY and never pulled.
 * They are this device's reading of its own log, which is what makes the
 * quick-add list a single indexed read with no join and no network — and the
 * quick-add list being instant is the whole of the two-tap repeat.
 */
const CREATE_FOODS = `
  CREATE TABLE IF NOT EXISTS foods (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'food',
    name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    serving_label TEXT NOT NULL,
    serving_grams REAL,
    kcal REAL NOT NULL,
    protein_g REAL NOT NULL DEFAULT 0,
    carb_g REAL NOT NULL DEFAULT 0,
    fat_g REAL NOT NULL DEFAULT 0,
    fibre_g REAL,
    saturated_fat_g REAL,
    sugar_g REAL,
    added_sugar_g REAL,
    sodium_mg REAL,
    cholesterol_mg REAL,
    -- How this row was produced: 'user' for one the athlete typed, 'ai' for one
    -- saved from a draft they confirmed (N114). Pushed, unlike the two counters
    -- below — the server holds the same column and a phone is the only thing in
    -- a position to know which of the two a row is.
    --
    -- A default of 'user' rather than NULL, because an unknown provenance is
    -- not a state worth carrying: every row that predates this column was typed
    -- by hand, which is exactly what 'user' means.
    source TEXT NOT NULL DEFAULT 'user',
    -- N87: what makes this row a recipe. Null for a plain food, and the server
    -- refuses either half of the mismatch — a recipe without a yield and a food
    -- with one are both a 400.
    yield_servings REAL,
    -- A recipe's ingredients, as a JSON array, in entry order.
    --
    -- A blob rather than a "food_items" table, and it is the same call
    -- "local_sessions" makes about sets one screen over, for the same reason:
    -- "PUT /nutrition/foods/{id}" replaces the whole ordered list in one call
    -- and the editor edits it as one array, so no operation anywhere touches a
    -- single ingredient in isolation. Rows would buy a join and a
    -- reconciliation step and nothing else.
    --
    -- "'[]'" rather than NULL as the default, because a plain food having no
    -- ingredients is a FACT about it and not a question nobody has asked yet.
    -- Every read parses this, so a null here would make each caller invent its
    -- own answer to what the absence meant.
    items TEXT NOT NULL DEFAULT '[]',
    last_used_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT '',
    dirty INTEGER NOT NULL DEFAULT 0,
    remote INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    last_error TEXT,
    cached_at TEXT NOT NULL
  );
`;

/**
 * Foods a barcode has resolved to on this device.
 *
 * ## Its own table rather than a row in `foods`, for three reasons
 *
 * **Licensing.** A scan result can come from Open Food Facts, which is ODbL
 * and carries a share-alike obligation. Migration `000059`'s own comment says
 * that obligation "must never reach our own data", and the cheapest way to
 * keep that true is for the ODbL-derived rows to live somewhere that could be
 * emptied in one statement without touching anything we authored. Mixing them
 * into `foods` would make separating them later a query rather than a
 * `DELETE FROM`.
 *
 * **`foods` PUSHES.** Its rows carry `dirty`/`remote`/`deleted_at` and flush
 * through the outbox, so a scan result written there would upload itself as a
 * personal saved food the athlete never chose to save. A scan proposes; it
 * does not save, and it does not save a *food* either.
 *
 * **The quick-add list.** `foods` is what the two-tap repeat reads. Every
 * packet ever pointed at would accumulate in it, pushing the porridge an
 * athlete actually eats down the list.
 *
 * `cached_at` is what a future eviction would read. Nothing evicts today — a
 * product's macros change when the manufacturer reformulates, which is rare
 * and is not something a phone can detect — but a cache with no age on its
 * rows cannot grow one later without a migration.
 */
const CREATE_BARCODE_CACHE = `
  CREATE TABLE IF NOT EXISTS barcode_cache (
    user_id TEXT NOT NULL,
    -- The NORMALISED 13-digit GTIN, never the scanner's raw string. A US
    -- upc_a scan and an EU ean13 scan of the same box differ by a leading
    -- zero, and keying on the raw form would cache the same product twice and
    -- miss on the other symbology.
    barcode TEXT NOT NULL,
    name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    serving_label TEXT NOT NULL,
    serving_grams REAL,
    -- N117: the packet's OWN serving, additive to serving_label/serving_grams
    -- above (which stay "the amount the macros below represent", always
    -- "100 g"). Null when Open Food Facts states none in grams.
    packet_serving_label TEXT,
    packet_serving_grams REAL,
    kcal REAL NOT NULL,
    protein_g REAL NOT NULL DEFAULT 0,
    carb_g REAL NOT NULL DEFAULT 0,
    fat_g REAL NOT NULL DEFAULT 0,
    fibre_g REAL,
    saturated_fat_g REAL,
    sugar_g REAL,
    added_sugar_g REAL,
    sodium_mg REAL,
    cholesterol_mg REAL,
    -- 'catalog', 'off' or 'ai' -- the last being a food the athlete described
    -- because no catalog had the packet, kept distinct so a guess can never
    -- wear a fact's provenance. Kept at all because a purge of ODbL rows has to
    -- find exactly them: forgetOpenFoodFactsRows is scoped to source = 'off',
    -- so this comment being right is what that scoping depends on. It said
    -- "'catalog' or 'off'" while 'ai' was already being written; caught in
    -- review. (No backticks in here: this is inside a template literal, and
    -- one silently ends the string -- 40 suites went red.)
    source TEXT NOT NULL,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (user_id, barcode)
  );
`;

const CREATE_NUTRITION_TARGETS = `
  CREATE TABLE IF NOT EXISTS nutrition_targets (
    user_id TEXT NOT NULL,
    effective_on TEXT NOT NULL,
    kcal REAL NOT NULL,
    protein_g REAL NOT NULL,
    carb_g REAL NOT NULL,
    fat_g REAL NOT NULL,
    fibre_g REAL,
    PRIMARY KEY (user_id, effective_on)
  );
`;

/**
 * Daily trackers: the DEFINITIONS, pulled from the server and pushed back.
 *
 * `dirty 0 / remote 1` by default, the `workout_cache`/`foods` direction, and
 * that is deliberate. The server provisions water on first list, so a definition
 * this device has never heard of is one it should adopt, not one it owes.
 * Editing the target flips `dirty` and the outbox pushes it — so changing a
 * target works with no signal, which is the mobile-first half of this feature.
 *
 * The ENTRIES table below is the opposite direction and the offline-critical
 * one: a tap is written locally and owed to the server from the first moment.
 */
const CREATE_DAILY_TRACKERS = `
  CREATE TABLE IF NOT EXISTS daily_trackers (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    preset TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    color_key TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    increment REAL NOT NULL,
    -- NULL is a real state: a count with no goal. Not 0, which would render as
    -- "0 of 0" at somebody who asked for no target at all.
    target REAL,
    render_style TEXT NOT NULL DEFAULT 'auto',
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- The athlete's own word for one tap. Authored, never derived from the
    -- unit: 5 g of creatine is a dose and 5 g of fibre is a serving, and the
    -- unit cannot tell them apart. See lib/trackerModel.ts.
    count_noun TEXT NOT NULL DEFAULT '',
    -- Server-computed: would provisioning re-create this row if it were
    -- deleted? Cached so the archived screen can decide whether to offer a
    -- delete control with no network. See lib/trackerModel.ts.
    provisioned INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    -- Set when the athlete un-archived a tracker the SERVER still has archived,
    -- and cleared once the restore is pushed.
    --
    -- A separate flag rather than something inferred from archived_at IS NULL
    -- AND dirty = 1, because those two cannot distinguish "put this back" from
    -- "I edited an ordinary live tracker" — and the push has to know, since a
    -- PATCH on an archived row leaves it archived. Inferring it would mean
    -- calling restore on every definition push, which is a wasted request every
    -- time somebody changes a target.
    restore_pending INTEGER NOT NULL DEFAULT 0,
    -- A TOMBSTONE for a destroy this device owes the server, exactly as
    -- tracker_entries.deleted_at is for a tap. (No backticks anywhere in this
    -- template literal -- one silently ends it, which is the trap this file
    -- already records for the Go side and which cost a syntax error here.)
    --
    -- The row cannot simply be deleted locally: a destroy made in a dead spot
    -- would then have nothing left carrying the intent, and the next pull would
    -- hand the tracker back. It is hard-deleted once the server confirms.
    destroyed_at TEXT,
    -- Minutes since local midnight — a plain clock time, e.g. 960 for 16:00.
    -- NULL means no cutoff is configured, a real state distinct from midnight
    -- (0). Generic like target: nothing here says caffeine. See
    -- lib/trackerModel.ts's cutoffLine.
    cutoff_minutes INTEGER,
    updated_at TEXT NOT NULL DEFAULT '',
    dirty INTEGER NOT NULL DEFAULT 0,
    remote INTEGER NOT NULL DEFAULT 1,
    last_error TEXT
  );
`;

/**
 * Every tap, one row.
 *
 * `logged_on` is the LOCAL calendar day written by dayString -- never
 * toISOString().slice(0,10), which for anyone west of Greenwich files an
 * evening glass of water under tomorrow. The jest suite runs under
 * TZ=America/Los_Angeles so that bug is visible rather than invisible.
 *
 * `amount` is the tracker's increment AS IT WAS at the moment of the tap, so
 * moving from a 250 ml glass to a 500 ml bottle does not rewrite last week.
 */
const CREATE_TRACKER_ENTRIES = `
  CREATE TABLE IF NOT EXISTS tracker_entries (
    id TEXT PRIMARY KEY NOT NULL,
    tracker_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    logged_on TEXT NOT NULL,
    logged_at TEXT NOT NULL,
    amount REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT '',
    dirty INTEGER NOT NULL DEFAULT 1,
    remote INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    last_error TEXT
  );
`;

/**
 * N465: the local ledger of runs already imported from Apple HealthKit —
 * the SAME-DEVICE half of the dedup story. `lib/healthkitSync.ts` checks
 * this BEFORE creating any local session for a workout, so a repeat import
 * pass on this device never even reaches the point of retrying a push; the
 * server's per-user unique index on `running_session_detail.healthkit_uuid`
 * (backend migration 000087) is the OTHER half, for a reinstalled app or a
 * second device that has no ledger of its own to consult.
 *
 * A dedicated table rather than scanning every session's `running_json`
 * blob for a `healthkit_uuid`, so "have I imported this uuid" is one indexed
 * lookup rather than a full table scan and a JSON parse per row on every
 * foreground import pass.
 *
 * No `dirty`/`remote` flags — this table is never pushed. It exists only to
 * answer "have I seen this uuid", and the fact the SERVER has accepted the
 * session it names is exactly what `local_sessions.dirty` on that row
 * already tracks; duplicating that state here would be a second place for
 * the two to disagree.
 */
const CREATE_HEALTHKIT_IMPORTS = `
  CREATE TABLE IF NOT EXISTS healthkit_imports (
    user_id TEXT NOT NULL,
    healthkit_uuid TEXT NOT NULL,
    session_id TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (user_id, healthkit_uuid)
  );
`;

/**
 * N477/#822: the same-device ledger of sessions already offered to the
 * `biometric` module's heart-rate window read — the exact shape and
 * argument as `CREATE_HEALTHKIT_IMPORTS` above, one layer up. That table
 * answers "have I imported this HealthKit workout"; this one answers "have
 * I already read this SESSION's heart-rate window", which is a different
 * question with a different key (`session_id`, not a HealthKit uuid — a
 * session that never touched HealthKit at all, a strength or BJJ session
 * logged entirely by hand, still needs its window read exactly once).
 *
 * No `dirty`/`remote` — never pushed, and never removed once written: a
 * session whose window was checked and found empty (`hr_source: 'none'`)
 * must not be re-checked every foreground pass forever, so "checked" is
 * recorded regardless of whether anything was found. `lib/biometricSync.ts`
 * is the only reader/writer.
 */
const CREATE_BIOMETRIC_HR_SYNCED = `
  CREATE TABLE IF NOT EXISTS biometric_hr_synced (
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (user_id, session_id)
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
const SCHEMA_VERSION = 34;

/** Tables this file owns. Typed so a guard can't be pointed at a typo. */
type LocalTable =
  | 'activities'
  | 'nutrition_targets'
  | 'local_sessions'
  | 'prefs'
  | 'workout_cache'
  | 'exercise_cache'
  | 'planned_sessions'
  | 'sequences'
  | 'food_entries'
  | 'foods'
  | 'barcode_cache'
  | 'daily_trackers'
  | 'tracker_entries'
  | 'healthkit_imports'
  | 'biometric_hr_synced';

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

  // Every table, unconditionally, BEFORE any versioned ALTER runs.
  //
  // These are each also created inside the versioned block that introduced
  // them, which is where the explanation of why they exist lives. Repeating
  // them here is not redundancy: a later step that ALTERs one of these tables
  // crashes outright if the database is already past the block that creates
  // it, so every future migration would silently depend on nobody ever
  // reaching it that way. `IF NOT EXISTS` makes this a no-op on a real
  // device, and an existing table keeps its existing shape — so the ALTERs
  // below are still what upgrades it, and still what the tests exercise.
  await db.execAsync(CREATE_SESSIONS);
  await db.execAsync(CREATE_EXERCISE_CACHE);
  await db.execAsync(CREATE_WORKOUT_CACHE);
  await db.execAsync(CREATE_PREFS);
  await db.execAsync(CREATE_PLANNED);
  await db.execAsync(CREATE_SEQUENCES);
  await db.execAsync(CREATE_FOOD_ENTRIES);
  await db.execAsync(CREATE_FOODS);
  await db.execAsync(CREATE_NUTRITION_TARGETS);
  await db.execAsync(CREATE_BARCODE_CACHE);
  await db.execAsync(CREATE_DAILY_TRACKERS);
  await db.execAsync(CREATE_TRACKER_ENTRIES);
  await db.execAsync(CREATE_HEALTHKIT_IMPORTS);
  await db.execAsync(CREATE_BIOMETRIC_HR_SYNCED);
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
    // Backfill rather than leave NULL.
    //
    // Only `mine` lists are ever cached, and the server's `mine` is strictly
    // owner_user_id = $1 -- so every pre-v8 row is provably owned by the
    // user_id it is filed under. NULL would be the cautious default in
    // general, but here it is simply wrong for 100% of real rows, and it
    // would label every one of an upgrader's own workouts "VOLA template"
    // until a refresh succeeded. It is also a pair the server cannot
    // produce: an ownerless private workout is visible to nobody.
    await db.runAsync(
      `UPDATE workout_cache SET owner_user_id = user_id WHERE owner_user_id IS NULL`,
    );
  }

  if (current < 9) {
    // v8 -> v9: workouts become writable offline.
    //
    // Existing rows default to dirty = 0 / remote = 1, which is the truth for
    // them: everything cached so far arrived FROM the server, so none of it is
    // owed a push. Defaulting the other way would push every cached workout
    // back at the server on first launch after the upgrade.
    await addColumnIfMissing(db, 'workout_cache', 'dirty', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'workout_cache', 'remote', 'INTEGER NOT NULL DEFAULT 1');
    await addColumnIfMissing(db, 'workout_cache', 'deleted_at', 'TEXT');
    await addColumnIfMissing(db, 'workout_cache', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  }

  if (current < 10) {
    // v9 -> v10: the catalog stops being lossy, and prefs get an outbox.
    //
    // `payload_json` is deliberately NULLABLE with no backfill. There is
    // nothing to backfill FROM — the dropped fields were never stored — so a
    // default would be a fabricated exercise rather than a missing one.
    // `cachedExercises` treats NULL as "pre-v10 row, reconstruct what we can",
    // and the next catalog fetch fills it in properly.
    await addColumnIfMissing(db, 'exercise_cache', 'payload_json', 'TEXT');
    // Existing prefs are NOT owed: everything written so far either came from
    // the server or was pushed at the time. Defaulting to 1 would queue an
    // upgrader's entire preference set for a pointless replay.
    await addColumnIfMissing(db, 'prefs', 'dirty', 'INTEGER NOT NULL DEFAULT 0');
  }

  if (current < 11) {
    // v10 -> v11: a row that cannot sync says why.
    //
    // Until now a permanent rejection surfaced as one screen-level message
    // for the whole run, then vanished on the next attempt — so a session
    // the server will refuse forever looked identical to one that just
    // hadn't been tried yet, and there was nowhere to see WHICH row or WHAT
    // the server said. Stored per row so the answer survives a relaunch,
    // which is when someone actually goes looking.
    await addColumnIfMissing(db, 'local_sessions', 'last_error', 'TEXT');
    await addColumnIfMissing(db, 'workout_cache', 'last_error', 'TEXT');
  }

  if (current < 13) {
    // Which rows have an unsent name.
    //
    // Without it the push has to send the name on EVERY push of every synced
    // session, because it cannot tell a rename from a set edit — and pushRow
    // is shared with the strength flow, where a live session saves on every
    // debounced set. That turned one request into two on the hottest write
    // path in the app, in the place with the worst signal.
    await addColumnIfMissing(db, 'local_sessions', 'name_dirty', 'INTEGER NOT NULL DEFAULT 0');
  }

  if (current < 12) {
    // v11 -> v12: a BJJ session's reflection gets somewhere to live offline.
    //
    // The BJJ half of a session is to a mat session what `sets_json` is to a
    // barbell one — the discipline's own detail, pushed after the session
    // exists server-side, replaced wholesale rather than merged. Storing it
    // the same way means the existing outbox carries it for free: the same
    // tombstones, the same compare-and-swap, the same blocked-row repair
    // screen, with no second sync path to keep honest.
    //
    // Nullable rather than defaulted to '{}': "this is not a BJJ session"
    // and "this is a BJJ session with an empty reflection" are different
    // facts, and only the first should skip the detail push entirely.
    await addColumnIfMissing(db, 'local_sessions', 'bjj_json', 'TEXT');
  }

  if (current < 14) {
    // v13 -> v14: the week gets a plan.
    //
    // Indexed on (user_id, day) because every read is either "what is on this
    // day" or "what is in this week" — there is no query in `lib/plan.ts` that
    // wants a user's plans in any other order.
    await db.execAsync(CREATE_PLANNED);
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS planned_sessions_user_day_idx
         ON planned_sessions (user_id, day);`,
    );
  }

  if (current < 15) {
    // v14 -> v15: the week plan joins the outbox.
    //
    // v14 shipped `planned_sessions` as a local-only table — there was no
    // `/v1/plans` yet — so a plan made on the phone reached nothing. These are
    // the columns that make it syncable, and they mean exactly what they mean
    // on `local_sessions` and `workout_cache`.
    //
    // **The defaults are the opposite of the workout_cache v9 ALTERs, and
    // deliberately so.** Those rows had come FROM the server, so they defaulted
    // to `dirty = 0, remote = 1` — already there, nothing owed. Every v14 plan
    // was created locally and has never been sent anywhere, so the honest
    // default here is `dirty = 1, remote = 0`: owed, and unknown to the server.
    // Getting this backwards would silently strand every plan an early adopter
    // had already made, with nothing ever pushing them.
    // `notes` too: the server's plan carries it, so a local row without it
    // could not round-trip what the web app wrote.
    await addColumnIfMissing(db, 'planned_sessions', 'notes', `TEXT NOT NULL DEFAULT ''`);
    await addColumnIfMissing(db, 'planned_sessions', 'updated_at', `TEXT NOT NULL DEFAULT ''`);
    await addColumnIfMissing(db, 'planned_sessions', 'dirty', 'INTEGER NOT NULL DEFAULT 1');
    await addColumnIfMissing(db, 'planned_sessions', 'remote', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'planned_sessions', 'deleted_at', 'TEXT');
    await addColumnIfMissing(db, 'planned_sessions', 'last_error', 'TEXT');

    // Backfill, and independently idempotent — which the migration contract
    // above requires of any data step, because a fresh install runs this
    // branch too. `CREATE_PLANNED` defaults `updated_at` to '' and every
    // insert sets it explicitly, so on a fresh install this matches nothing.
    await db.execAsync(
      `UPDATE planned_sessions SET updated_at = created_at WHERE updated_at = '';`,
    );
  }

  if (current < 16) {
    // v15 -> v16: a workout template's name becomes editable.
    //
    // Until now the name was fixed at creation — the API had no verb for it
    // (`PUT /items`, `DELETE`, and nothing else), so a template named in a
    // hurry on the gym floor stayed that way and the only correction was to
    // rebuild it and lose every plan pointing at it.
    //
    // Defaults to 0, and that direction matters: every existing row's name is
    // whatever the server already holds, so none of them is owed a PATCH.
    // Defaulting to 1 would make the first sync after upgrade re-send every
    // cached template's name — including VOLA's own ownerless ones, which the
    // server would refuse with a 403 the outbox would then have to hold.
    await addColumnIfMissing(db, 'workout_cache', 'name_dirty', 'INTEGER NOT NULL DEFAULT 0');
  }

  if (current < 17) {
    // Sequences captured on the phone. A brand-new TABLE, so nothing here is
    // an ALTER and nothing can hit the duplicate-column trap the guard above
    // exists for — the unconditional `CREATE ... IF NOT EXISTS` earlier has
    // already made it, on every path. Kept as its own block anyway so the
    // version this arrived in is readable from `migrate()` rather than only
    // from git.
    await db.execAsync(CREATE_SEQUENCES);
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS sequences_user_idx ON sequences (user_id);`,
    );
  }

  if (current < 18) {
    // The food log. Two brand-new TABLES, so nothing here is an ALTER and
    // nothing can hit the duplicate-column trap — the unconditional
    // `CREATE ... IF NOT EXISTS` above has already made both, on every path.
    // Kept as its own block anyway so the version they arrived in is readable
    // from `migrate()` rather than only from git.
    await db.execAsync(CREATE_FOOD_ENTRIES);
    await db.execAsync(CREATE_FOODS);
    // The day screen's only query, and the outbox's.
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS food_entries_user_day_idx ON food_entries (user_id, eaten_on);`,
    );
    // Held for the foods pull and for a future "recently saved" listing.
    // NOTE it does not serve the quick-add list, which an earlier version of
    // this comment claimed: `recentsFor` groups over `food_entries` and never
    // orders by `last_used_at`. Recorded because an index believed to be load-
    // bearing is one nobody measures before relying on it.
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS foods_user_recent_idx ON foods (user_id, last_used_at DESC);`,
    );
  }

  if (current < 19) {
    // The day's calorie target, cached.
    //
    // A NEW VERSION rather than an extension of 18, even though 18 is unmerged
    // and has never shipped: `migrate()` returns early at
    // `current >= SCHEMA_VERSION`, so a device already stamped 18 never reaches
    // the unconditional CREATE block above and would simply not have this
    // table. Every dev machine that has run this branch is such a device.
    //
    // Note it is the BUMP that fixes that, not this branch — the branch is a
    // no-op against the unconditional CREATE, same as 18's. It is here so the
    // version the table arrived in is readable from `migrate()` rather than
    // only from git.
    await db.execAsync(CREATE_NUTRITION_TARGETS);
  }

  if (current < 20) {
    // Foods a barcode has resolved to, so a re-scan works with no signal.
    //
    // A no-op against the unconditional CREATE above, same as 18's and 19's
    // were; it is here so the version the table arrived in is readable from
    // `migrate()` rather than only from git. The BUMP is what makes a device
    // already stamped 19 reach the CREATE at all.
    await db.execAsync(CREATE_BARCODE_CACHE);
  }

  if (current < 21) {
    // Daily trackers and their entries.
    //
    // No-ops against the unconditional CREATEs above, same as 18/19/20's were;
    // they are here so the version the tables arrived in is readable from
    // `migrate()` rather than only from git. The BUMP is what makes a device
    // already stamped 20 reach the CREATEs at all.
    await db.execAsync(CREATE_DAILY_TRACKERS);
    await db.execAsync(CREATE_TRACKER_ENTRIES);
  }

  if (current < 22) {
    // N114: `foods.source`.
    //
    // **A real ALTER, unlike 19/20/21's no-ops**, and the difference matters.
    // Those three added whole TABLES, which the unconditional CREATEs above
    // already handle for any device that reaches them. A COLUMN on an existing
    // table has no such backstop: `CREATE TABLE IF NOT EXISTS` does nothing at
    // all when the table is there, so a device stamped 21 would keep a `foods`
    // table with no `source` column and every read of it would throw.
    //
    // Guarded on the column not already existing, because `migrate()` must be
    // safe to re-enter — a run that failed after this statement and before the
    // version stamp would otherwise hit `duplicate column name` forever, which
    // is the every-offline-feature-dead-on-arrival case this file warns about.
    const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(foods)`);
    if (!cols.some((c) => c.name === 'source')) {
      await db.execAsync(`ALTER TABLE foods ADD COLUMN source TEXT NOT NULL DEFAULT 'user';`);
    }
  }

  if (current < 23) {
    // N78: an athlete-authored tracker needs a word for one tap, and the
    // archive/restore/destroy lifecycle needs somewhere to hold what this
    // device owes the server.
    //
    // **23, not 22 — N114 took 22 while this branch was open.** Two different
    // v22 blocks is the local-schema form of a duplicate migration number: a
    // device stamped 22 by whichever landed first would never run the other's,
    // silently, with no error anywhere. Caught at rebase, which is the only
    // place it is visible.
    //
    // These are real ALTERs rather than no-ops against the CREATE above — a
    // device already stamped 22 HAS the table and will not re-run its CREATE —
    // which is exactly why `addColumnIfMissing` exists: a device creating the
    // table for the first time gets all three columns from the CREATE, and
    // these three statements must then do nothing rather than throwing and
    // wedging `getDb()` for the life of the install.
    await addColumnIfMissing(db, 'daily_trackers', 'count_noun', `TEXT NOT NULL DEFAULT ''`);
    await addColumnIfMissing(db, 'daily_trackers', 'restore_pending', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'daily_trackers', 'destroyed_at', 'TEXT');
    await addColumnIfMissing(db, 'daily_trackers', 'provisioned', 'INTEGER NOT NULL DEFAULT 0');
    // Seed it CONSERVATIVELY from what this device already knows: treat any
    // preset row as re-provisioned until the server says otherwise. That is the
    // pre-N78 behaviour, so an upgrade never briefly offers to delete somebody's
    // water; the first pull replaces the guess with the server's answer.
    await db.execAsync(
      `UPDATE daily_trackers SET provisioned = 1 WHERE preset <> '' AND provisioned = 0;`,
    );
    // Backfill the noun EXACTLY as the client used to derive it, so nobody's
    // existing water card loses its "cups" on upgrade. Scoped to rows that have
    // not already been given one by a fetch from a server that has the
    // count_noun migration — those are already right, and re-deriving would
    // overwrite an authored word with a guess.
    await db.execAsync(`
      UPDATE daily_trackers
         SET count_noun = CASE unit
             WHEN 'ml' THEN 'cup'
             WHEN 'cup' THEN 'cup'
             WHEN 'g' THEN 'dose'
             WHEN 'mg' THEN 'dose'
             WHEN 'dose' THEN 'dose'
             ELSE ''
         END
       WHERE count_noun = '';
    `);
  }

  if (current < 24) {
    // N87: `foods.yield_servings` and `foods.items` — what a recipe is.
    //
    // **24, not 23 — N78 took 23 while this branch was open**, exactly as N78's
    // own note above records N114 taking 22 from it. Two blocks guarded on the
    // same `current <` is the local-schema form of a duplicate migration
    // number: a device stamped 23 by whichever landed first would never run
    // the other's, silently, with no error anywhere. There is no check for
    // this — rebase is the only place it is visible.
    //
    // Real ALTERs, same shape as 22's and for the same reason: `CREATE TABLE IF
    // NOT EXISTS` is a no-op against the existing `foods` table, so a device
    // stamped 22 would keep a table without these and every read would throw.
    //
    // Routed through `addColumnIfMissing` rather than 22's hand-rolled
    // `table_info` check — same guarantee, and it is the helper this file's own
    // docblock says every `ADD COLUMN` must use. The guard is what makes
    // `migrate()` re-enterable: a run that failed between these two statements
    // and the version stamp would otherwise hit `duplicate column name` for the
    // life of the install.
    //
    // `items` is NOT NULL DEFAULT '[]', which is also what backfills every
    // pre-N87 row: SQLite writes the default into the existing rows as part of
    // the ALTER, so an old saved food reads back as "no ingredients" rather
    // than as a null every caller has to interpret.
    await addColumnIfMissing(db, 'foods', 'yield_servings', 'REAL');
    await addColumnIfMissing(db, 'foods', 'items', `TEXT NOT NULL DEFAULT '[]'`);
  }

  if (current < 25) {
    // N59: the wider N52 label macros — saturated fat, sugar, added sugar,
    // sodium, cholesterol — reach the nutrition panel, and the panel needs
    // them from the local cache exactly as it needs `fibre_g`, or the offline
    // path would silently drop them the moment the network wasn't there to
    // re-fetch. `nutrition_targets` is deliberately NOT touched: a target
    // never carried these fields even before this, and it still doesn't —
    // see `Target`'s own comment in `lib/nutrition.ts`.
    //
    // Real ALTERs on all three, same reason as 22/23/24: `CREATE TABLE IF NOT
    // EXISTS` is a no-op on a table that already exists, so a device already
    // stamped 24 would keep tables without these columns and every read
    // would throw the moment `Macros` requires them.
    for (const table of ['food_entries', 'foods', 'barcode_cache'] as const) {
      await addColumnIfMissing(db, table, 'saturated_fat_g', 'REAL');
      await addColumnIfMissing(db, table, 'sugar_g', 'REAL');
      await addColumnIfMissing(db, table, 'added_sugar_g', 'REAL');
      await addColumnIfMissing(db, table, 'sodium_mg', 'REAL');
      await addColumnIfMissing(db, table, 'cholesterol_mg', 'REAL');
    }
  }

  if (current < 26) {
    // N117: the packet's own serving — "2 pieces (25 g)" for a Kinder bar —
    // additive to `serving_label`/`serving_grams`, which stay exactly what
    // they always were ("100 g", the amount `kcal`/`protein_g`/etc. on this
    // row represent). Only `barcode_cache`: neither `foods` nor
    // `food_entries` is scanned from a packet, so neither has a "the packet
    // also said" to remember.
    await addColumnIfMissing(db, 'barcode_cache', 'packet_serving_label', 'TEXT');
    await addColumnIfMissing(db, 'barcode_cache', 'packet_serving_grams', 'REAL');
  }

  if (current < 27) {
    // N431: the caffeine tracker's cutoff — "no more after this clock time".
    // Real ALTER, same reason as every branch above: `CREATE TABLE IF NOT
    // EXISTS` is a no-op on a device already past this version, so it would
    // keep a `daily_trackers` table with no `cutoff_minutes` and every read
    // that selects it would throw.
    await addColumnIfMissing(db, 'daily_trackers', 'cutoff_minutes', 'INTEGER');
  }

  if (current < 28) {
    // N436: which rows have an unsent date correction.
    //
    // Same shape as `name_dirty` (v13) and for the identical reason: without
    // it the push would have to PATCH the schedule endpoint on EVERY push of
    // every already-synced session, because it cannot otherwise tell "the
    // athlete moved this to yesterday" from "a set got ticked" — and pushRow
    // is shared with the live strength flow, which pushes on every debounced
    // set. That would turn the hottest write path in the app into two
    // requests instead of one, for a field that changes rarely.
    await addColumnIfMissing(db, 'local_sessions', 'started_at_dirty', 'INTEGER NOT NULL DEFAULT 0');
  }

  if (current < 29) {
    // N442: a scheduled class is a plan referencing a coach's class plan
    // instead of a workout template. Real ALTER, same reason as every branch
    // above: `CREATE TABLE IF NOT EXISTS` is a no-op on a device already past
    // this version, so it would keep a `planned_sessions` table with no
    // `class_plan_id` and every pull that writes one would throw.
    //
    // Nullable, no default beyond SQLite's implicit NULL: unlike `dirty` (v15)
    // or `name_dirty` (v16) there is nothing to backfill and no outbox state
    // to get backwards, because this app never WRITES the column — see
    // CREATE_PLANNED's own comment. Every existing row simply has no class
    // plan until the next pull says otherwise.
    await addColumnIfMissing(db, 'planned_sessions', 'class_plan_id', 'TEXT');
  }

  if (current < 30) {
    // N124/N113: the meal-section glyph is derived from a food's CATEGORY, and
    // until now nothing this table stores has one. Real ALTER, same reason as
    // every branch above: `CREATE TABLE IF NOT EXISTS` is a no-op on a device
    // already past this version, so it would keep a `food_entries` table with
    // no `category` and every read that selects it would throw.
    //
    // Nullable, no backfill: every existing row predates this column and
    // genuinely has no category to give it — `glyphFor(null)` already
    // degrades to the neutral plate for exactly this reason, so leaving these
    // rows at null is the honest answer rather than a gap to paper over.
    await addColumnIfMissing(db, 'food_entries', 'category', 'TEXT');
  }

  if (current < 31) {
    // N460: a run's GPS track and splits get somewhere to live offline.
    //
    // Same shape as `bjj_json` (v12) and for the same reason: the running
    // half of a session is to a run what the BJJ reflection is to a mat
    // session — the discipline's own detail, pushed after the session
    // exists server-side, replaced wholesale rather than merged. Storing it
    // the same way means the existing outbox carries it for free, including
    // while the run is still in progress: the screen persists the growing
    // track into this column as points come in (not only at Finish), so a
    // dead zone or a killed app loses nothing already recorded — the row and
    // its `running_json` blob are ordinary SQLite state from the moment the
    // first point lands.
    //
    // Nullable, no backfill, same reasoning as `bjj_json`: "this is not a
    // running session" and "this is a running session with an empty detail"
    // are different facts, and only the first should skip the detail push
    // entirely.
    await addColumnIfMissing(db, 'local_sessions', 'running_json', 'TEXT');
  }

  if (current < 32) {
    // N465: the same-device half of "don't import a HealthKit run twice" —
    // see CREATE_HEALTHKIT_IMPORTS's own doc comment for the full argument
    // and why this is a dedicated table rather than a scan over every
    // session's `running_json`.
    await db.execAsync(CREATE_HEALTHKIT_IMPORTS);
  }

  if (current < 33) {
    // N474: what the athlete meant this session to be — see
    // SessionIntent's own doc comment in lib/sessions.ts. NOT NULL DEFAULT
    // 'normal', same reasoning as the server-side column: every session
    // recorded before this existed IS a normal session (there is nothing
    // else it could have meant), so a backfilled default is the honest
    // value here, unlike `category`/`bjj_json` above where NULL is the
    // honest answer for a fact nothing before this version ever asked.
    await addColumnIfMissing(db, 'local_sessions', 'intent', "TEXT NOT NULL DEFAULT 'normal'");
  }

  if (current < 34) {
    // N477/#822: see CREATE_BIOMETRIC_HR_SYNCED's own doc comment.
    await db.execAsync(CREATE_BIOMETRIC_HR_SYNCED);
  }

  // The day query the card runs on every render of Today.
  await db.execAsync(
    `CREATE INDEX IF NOT EXISTS tracker_entries_user_day_idx
       ON tracker_entries (user_id, logged_on);`,
  );

  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

/**
 * One transaction at a time, process-wide. **Use this, never
 * `db.withTransactionAsync` directly** — an eslint rule enforces it.
 *
 * `expo-sqlite` hands the whole app ONE connection, and its
 * `withTransactionAsync` is a bare `BEGIN` / task / `COMMIT` with a `ROLLBACK`
 * in the catch — its own doc comment says it "can be interrupted by other async
 * queries". So two overlapping calls on that shared connection do this:
 *
 *   A: BEGIN                     -- transaction open
 *   A: ...awaits, yielding...
 *   B: BEGIN                     -- throws "cannot start a transaction within
 *                                   a transaction"
 *   B: ROLLBACK  (its catch)     -- SUCCEEDS, and ends *A's* transaction,
 *                                   discarding everything A had written
 *   A: ...remaining writes...    -- now in autocommit, one txn per statement
 *   A: COMMIT                    -- "cannot commit - no transaction is active"
 *   A: ROLLBACK  (its catch)     -- "cannot rollback - no transaction is active"
 *
 * That last line is what the athlete saw: the Plan tab rendered
 * "cannot rollback - no transaction is active" where the week's plan goes,
 * because `cacheWorkouts` and `cacheExercises` overlap whenever Plan loads
 * while Library, a session screen or a sync is caching the catalog.
 *
 * The banner was the visible half. The quiet half is worse: B's rollback
 * discards A's reconcile, so a workout deleted on the server survives in the
 * cache — re-breaking, at random, the exact guarantee `cacheWorkouts`'
 * RECONCILE comment exists to provide.
 *
 * A JS-side queue is the right size of fix: JS here is single-threaded, so
 * nothing can slip between the `BEGIN` and the `COMMIT` once the bodies are
 * serialised. `withExclusiveTransactionAsync` was the alternative and is worse
 * — it opens a SECOND connection, and expo's own docs note that other async
 * writes then abort with `database is locked`, which trades a rare error for a
 * common one given how much of this app writes outside a transaction.
 *
 * Same shape as `syncSessions`' queue, including the `.catch` on the chain:
 * without it one failed transaction rejects every transaction queued behind it
 * forever.
 *
 * **What this does NOT fix.** Transactions no longer collide with each other,
 * but a plain `runAsync` from elsewhere can still land *between* a `BEGIN` and
 * its `COMMIT` and be swallowed into a transaction it knows nothing about — so
 * a failing `cacheWorkouts` would roll back an unrelated write that happened to
 * interleave. There is a second, rarer way in: if expo's own `ROLLBACK` throws
 * while a transaction is genuinely open (a `SQLITE_BUSY`-class failure, not the
 * bug above — there it throws precisely BECAUSE none is open), the transaction
 * leaks open, the next queued one fails to `BEGIN`, and its rollback discards
 * both. The queue recovers on the one after; the data does not come back.
 * Closing either means funnelling every write through this queue, which is a
 * much larger change than the bug on the table warranted.
 *
 * **Do not call this from inside a transaction body.** The inner call queues
 * behind an outer one that cannot finish until the inner resolves. That is not
 * a local hazard: `txChain` stays pending forever, so EVERY subsequent
 * transaction in the process hangs and no row is ever written again — a silent,
 * permanent, app-wide freeze. Nothing nests today. There is no cheap runtime
 * guard, because a nested call and a legitimately concurrent one are
 * indistinguishable without async-context tracking (React Native has none).
 */
let txChain: Promise<unknown> = Promise.resolve();

export function withTransaction(
  db: SQLite.SQLiteDatabase,
  task: () => Promise<void>,
): Promise<void> {
  const run = txChain.then(() => db.withTransactionAsync(task));
  txChain = run.catch(() => {});
  return run;
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
