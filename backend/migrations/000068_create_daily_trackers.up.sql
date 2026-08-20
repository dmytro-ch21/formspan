-- Daily trackers: one generic model, of which water is an instance.
--
-- The shape of this table is the point of the ticket, not the water card that
-- sits on top of it. Three trackers were asked for — water (N76), coffee (N77)
-- and whatever the athlete names (N78, "creatine, 5 g, once a day") — and the
-- cheap thing to do is three tables and three cards. This repo already knows
-- what that costs: `exercise`'s updateWithin blanked authored data three times
-- because one write path grew a column three times, and #392 exists because two
-- image paths each learned the same downscale independently.
--
-- So there is one table of DEFINITIONS and one of ENTRIES, and everything that
-- distinguishes water from coffee from creatine is a value in a column:
--
--   water    ml,  increment 250, target 2000, glyphs, colour 'water'
--   coffee   cup, increment   1, target NULL, glyphs, colour 'coffee'
--   creatine g,   increment   5, target    5, dose,   colour <picked>
--
-- Adding the second and third is a row in `presets.go`, not a migration.
--
-- ## Why amounts are stored on the ENTRY as well as the definition
--
-- `increment` is what a tap adds *today*. An athlete who switches from a 250 ml
-- glass to a 500 ml bottle changes the definition, and every cup they logged
-- last week must keep meaning 250 ml. Recomputing history from the current
-- definition is the same class of mistake as deriving a local day from a UTC
-- timestamp: it silently rewrites the past.
--
-- ## Why DOUBLE PRECISION and not NUMERIC
--
-- These are dosages and glassfuls, not money. NUMERIC needs pgtype.Numeric on
-- the Go side, which buys exactness nothing here depends on and costs a scan
-- path that is easy to get subtly wrong.

SET lock_timeout = '3s';

CREATE TABLE daily_trackers (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,

    -- Which seeded preset this row was provisioned from, or '' for one the
    -- athlete invented. NOT a discriminator anything branches on: it exists so
    -- provisioning is idempotent (see the partial unique index below) and so
    -- the console can tell "the water everyone gets" from "a tracker somebody
    -- made". Every field below is equally editable either way — a preset is a
    -- set of defaults, never a privileged built-in.
    preset       TEXT NOT NULL DEFAULT '',

    name         TEXT NOT NULL CHECK (name <> ''),
    icon         TEXT NOT NULL DEFAULT '',

    -- A KEY into the client palette, never a hex. A free colour picker lets an
    -- athlete choose something that fails contrast on `surface`, and
    -- `scripts/validate_palette.mjs` cannot run at authoring time. Validated
    -- here only for shape; membership is enforced where the palette lives.
    color_key    TEXT NOT NULL CHECK (color_key <> ''),

    -- The canonical unit amounts are stored in: 'ml', 'g', 'mg', 'cup',
    -- 'dose', 'count', or ''. Display conversion (ml -> fl oz) is the client's
    -- job and the athlete's preference, exactly as kilograms are.
    unit         TEXT NOT NULL DEFAULT '',

    increment    DOUBLE PRECISION NOT NULL CHECK (increment > 0),

    -- NULL is a real state and not a missing value: coffee is a count with no
    -- goal, and rendering "0 of 0" at an athlete who did not ask for a ceiling
    -- is the thing N77 exists to avoid.
    target       DOUBLE PRECISION CHECK (target IS NULL OR target > 0),

    render_style TEXT NOT NULL DEFAULT 'auto'
                 CHECK (render_style IN ('auto', 'glyphs', 'bar', 'dose')),

    sort_order   INTEGER NOT NULL DEFAULT 0,

    -- Archived, never deleted. "A tracker you stop is not a tracker whose past
    -- disappears" — and the entries hang off this row, so a DELETE would take
    -- the history with it.
    archived_at  TIMESTAMPTZ,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per preset per athlete. This is what makes provisioning an
-- ON CONFLICT DO NOTHING rather than a "have I done this yet" flag somewhere:
-- two devices, or two concurrent list calls, converge on one water card.
--
-- Partial, because custom trackers all carry preset = '' and an athlete may
-- have any number of them.
CREATE UNIQUE INDEX daily_trackers_user_preset_idx
    ON daily_trackers (user_id, preset)
    WHERE preset <> '';

CREATE INDEX daily_trackers_user_idx
    ON daily_trackers (user_id, sort_order, created_at);

CREATE TABLE tracker_entries (
    -- Client-generated, so a sync retry is idempotent and a tap made in a
    -- kitchen with no signal keeps its identity all the way to the server.
    id         TEXT PRIMARY KEY,
    tracker_id TEXT NOT NULL REFERENCES daily_trackers (id) ON DELETE CASCADE,

    -- Denormalised from the tracker so every read is owner-scoped without a
    -- join. The same rule the rest of this schema follows: an id is provenance,
    -- never a capability.
    user_id    TEXT NOT NULL,

    -- The athlete's LOCAL calendar day, supplied by the client. Never derived
    -- from logged_at server-side: west of Greenwich a 23:58 glass of water
    -- lands on tomorrow, and then two days are wrong at once.
    logged_on  DATE NOT NULL,

    -- The moment, for "last at 16:40" (N77). Separate from logged_on because
    -- they answer different questions and only one of them survives a timezone.
    logged_at  TIMESTAMPTZ NOT NULL,

    -- The increment AS IT WAS when this was logged. See the header.
    amount     DOUBLE PRECISION NOT NULL CHECK (amount > 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tracker_entries_user_day_idx
    ON tracker_entries (user_id, logged_on);

-- The card reads one tracker's day, and the coffee card additionally wants the
-- newest entry's time. Both are this index, backwards.
CREATE INDEX tracker_entries_tracker_day_idx
    ON tracker_entries (tracker_id, logged_on, logged_at);

COMMENT ON COLUMN daily_trackers.preset IS
    'Seeded preset key, or empty for an athlete-authored tracker. Provisioning '
    'key only — nothing branches on it, and every column is editable either way.';

COMMENT ON COLUMN daily_trackers.target IS
    'NULL means the athlete wants a count with no goal (N77 coffee). Distinct '
    'from 0, which the CHECK forbids precisely so the two cannot be confused.';

COMMENT ON COLUMN tracker_entries.amount IS
    'The tracker increment at the moment of logging, in the tracker unit. Kept '
    'per-entry so changing the increment does not rewrite last week.';
