-- The shared, searchable food catalog, and the barcode cache beside it.
--
-- THREE tables are involved and the split is the whole design, so it is worth
-- stating before the DDL:
--
--   food_catalog        ours. Seeded from USDA (public domain), console-
--                       editable. No owner — one row per food for everybody.
--   food_barcode_cache  Open Food Facts answers, cached. ODbL, so it lives
--                       apart from everything we authored.
--   nutrition_foods     unchanged. An athlete's PERSONAL foods, private by
--                       default, already exists since migration 000059.
--
-- Why the catalog is not just more rows in `nutrition_foods`: that table is
-- `user_id NOT NULL` with client-generated UUIDs written by an offline outbox.
-- It is a personal store. Giving it a nullable `user_id` so it could also hold
-- shared rows would mean re-auditing every existing nutrition query for rows it
-- was never written to expect.
--
-- Why the barcode cache is not just more rows in `food_catalog`: migration
-- 000059 says an Open Food Facts row's share-alike obligation "must never reach
-- our own data". A separate table is the mechanical form of that promise — if
-- we ever had to stop using OFF, it is one TRUNCATE and our catalog is
-- untouched. Note SEPARABLE is not the same as private: this cache is shared,
-- so one athlete's scan warms it for everyone. Those two goals only looked
-- opposed while the choice was framed as two tables instead of three.

SET lock_timeout = '3s';

CREATE TABLE food_catalog (
    -- A slug, like exercises and techniques — 'chicken-breast'. NOT a UUID:
    -- these rows are authored content that a seed file has to name stably
    -- across deploys and environments.
    id       TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),

    name     TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    brand    TEXT NOT NULL DEFAULT '' CHECK (length(brand) <= 80),
    -- The coarse food group. Carries real weight here beyond filtering: it is
    -- what the coverage endpoint counts, so an athlete can be told "we hold 24
    -- vegetables and 4 prepared meals" rather than being left to infer the
    -- shape of the catalog from a search that found nothing.
    category TEXT NOT NULL CHECK (length(btrim(category)) BETWEEN 1 AND 40),

    -- Other names for THIS food — 'aubergine' on the eggplant row, 'ahi' on
    -- yellowfin tuna. An array rather than a joined string on purpose: search
    -- unnests it so a single typed word can never match across the boundary
    -- between two unrelated aliases. That is the defect that made `arm bar`
    -- return nothing in the technique library (see search.go).
    aliases  TEXT[] NOT NULL DEFAULT '{}',

    -- What ONE serving is, as a person would say it. Every seeded row is
    -- '100 g' because that is the unit USDA states its values in; the label is
    -- never parsed and never multiplied by, exactly as on nutrition_foods.
    serving_label TEXT NOT NULL CHECK (length(btrim(serving_label)) BETWEEN 1 AND 40),
    -- Nullable for the same reason as on nutrition_foods: an egg has no honest
    -- gram weight, and inventing one makes every gram-based total fictional.
    serving_grams NUMERIC(9, 2) CHECK (serving_grams IS NULL OR serving_grams > 0),

    -- PER ONE SERVING. Same bounds as nutrition_foods so a catalog row can be
    -- copied into a personal one without a value that fits here failing there.
    kcal      NUMERIC(8, 2) NOT NULL CHECK (kcal      >= 0 AND kcal      < 20000),
    protein_g NUMERIC(7, 2) NOT NULL CHECK (protein_g >= 0 AND protein_g < 2000),
    carb_g    NUMERIC(7, 2) NOT NULL CHECK (carb_g    >= 0 AND carb_g    < 2000),
    fat_g     NUMERIC(7, 2) NOT NULL CHECK (fat_g     >= 0 AND fat_g     < 2000),
    -- Nullable, and it is NOT the same statement as zero: a source that does
    -- not state fibre is not claiming there is none. 4 of the 173 seeded rows
    -- are genuinely null here.
    fibre_g   NUMERIC(7, 2) CHECK (fibre_g IS NULL OR (fibre_g >= 0 AND fibre_g < 500)),

    -- Which region's food supply this row describes.
    --
    -- A COLUMN rather than a global assumption, and that is the point. The
    -- athletes are US-primarily and USDA is a US dataset, so every seeded row
    -- is 'us' — but the moment somebody searches for skyr, "we do not stock
    -- that food" and "we do not cover your region" are different answers and
    -- only one of them is the athlete's to fix. Without this column they are
    -- indistinguishable, and making them distinguishable later would be a
    -- migration plus a backfill.
    market   TEXT NOT NULL DEFAULT 'us' CHECK (length(btrim(market)) BETWEEN 2 AND 16),

    -- Deploy-managed or human-edited. The same provenance split the exercise
    -- and technique catalogs use, and it does the same job: the seeder's
    -- upsert is scoped `WHERE source = 'seed'`, so a console edit takes
    -- ownership of the row and the next deploy leaves it alone.
    --
    -- NOTE this is a different question from nutrition_foods.source
    -- ('user'|'seed'|'usda'|'off'|'ai'), which records how an ATHLETE's row was
    -- produced. This one records who owns this catalog row's content.
    source   TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'admin')),

    -- Which upstream row the numbers came from, so any figure in this catalog
    -- can be checked against its origin. For the seeded set this is the USDA
    -- FoodData Central id and 'usda'.
    external_id     TEXT,
    external_source TEXT CHECK (external_source IS NULL OR external_source IN ('usda', 'off')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the ILIKE predicates the search generates (NOT the similarity
-- ordering — GIN has no ordered scans, so `ORDER BY similarity(...)` is always
-- computed per row above the scan). Exactly the same reasoning as
-- exercises_name_trgm_idx in migration 000055; read that comment for the long
-- version.
--
-- `pg_trgm` is NOT created here: migration 000017 installed it for the
-- technique library. Creating an extension twice in two migrations is how it
-- ends up owned by whichever one is rolled back first.
--
-- Measured as unused at 173 rows, and kept anyway, for the same reason as the
-- exercise one: the cost falls on a table written only by a seeder and a
-- console, never on the read path it exists for.
CREATE INDEX food_catalog_name_trgm_idx ON food_catalog USING gin (name gin_trgm_ops);

COMMENT ON INDEX food_catalog_name_trgm_idx IS
    'Serves the ILIKE predicates of the catalog search, NOT the similarity '
    'ordering. Unused at the current catalog size; kept as headroom. See '
    'internal/modules/food/search.go.';

-- The coverage endpoint groups by both of these, and the market filter uses
-- the second. Small table, but these are the two queries it exists to answer.
CREATE INDEX food_catalog_category_idx ON food_catalog (category);
CREATE INDEX food_catalog_market_idx ON food_catalog (market);

-- One catalog row per upstream row, so a re-import updates rather than
-- duplicating. Partial because console-authored rows have no external id.
CREATE UNIQUE INDEX food_catalog_external_idx
    ON food_catalog (external_source, external_id)
    WHERE external_id IS NOT NULL;


-- Open Food Facts barcode resolutions.
--
-- SEPARATE from food_catalog because it is ODbL and migration 000059's rule is
-- that the obligation must never reach data we authored. Shared rather than
-- per-athlete, because separability is about which table a row sits in, not
-- about how many people may read it — and a per-athlete cache would make every
-- athlete re-fetch the same box of cereal.
CREATE TABLE food_barcode_cache (
    -- EAN-13, UPC-A and friends. Stored as TEXT because a barcode is a string
    -- of digits, not a number: leading zeros are significant and 13 digits
    -- overflows int32.
    barcode  TEXT PRIMARY KEY CHECK (barcode ~ '^[0-9]{6,14}$'),

    -- Who answered. Recorded per row rather than assumed, because ODbL
    -- attribution is not optional and support needs to know where a wrong
    -- number came from.
    provider TEXT NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 40),

    name     TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    brand    TEXT NOT NULL DEFAULT '' CHECK (length(brand) <= 80),

    serving_label TEXT NOT NULL CHECK (length(btrim(serving_label)) BETWEEN 1 AND 40),
    serving_grams NUMERIC(9, 2) CHECK (serving_grams IS NULL OR serving_grams > 0),

    kcal      NUMERIC(8, 2) NOT NULL CHECK (kcal      >= 0 AND kcal      < 20000),
    protein_g NUMERIC(7, 2) NOT NULL CHECK (protein_g >= 0 AND protein_g < 2000),
    carb_g    NUMERIC(7, 2) NOT NULL CHECK (carb_g    >= 0 AND carb_g    < 2000),
    fat_g     NUMERIC(7, 2) NOT NULL CHECK (fat_g     >= 0 AND fat_g     < 2000),
    fibre_g   NUMERIC(7, 2) CHECK (fibre_g IS NULL OR (fibre_g >= 0 AND fibre_g < 500)),

    -- The provider's own identifier for the product, kept so a row can be
    -- re-checked upstream.
    external_id TEXT,

    -- When we asked. There is no expiry rule yet and that is deliberate —
    -- see the history entry — but a cache with no timestamp can never grow
    -- one without a backfill.
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NOTHING IS CACHED FOR A BARCODE THE PROVIDER DOES NOT KNOW, and that
-- absence is deliberate rather than an omission. A negative cache would
-- convert "Open Food Facts has not been told about this packet yet" into a
-- permanent "this food does not exist", which is precisely the
-- absence-reads-as-an-answer failure this whole feature is built to avoid.
-- Products get added upstream every day; a miss must stay re-askable.


-- The fifth value on nutrition_foods.source: a food an AI drafted.
--
-- Its own value rather than folded into 'user', and N40 (#313) is the whole
-- argument. Put through a real photograph, the estimator invented one item and
-- DOUBLED a quantity — and it flagged the invention three separate ways while
-- flagging the miscount not at all. A model cannot reliably tell you which of
-- its own numbers to distrust, so an AI-drafted food has to stay permanently
-- distinguishable from a USDA-measured one. Fold them together and nothing
-- downstream — including N27's kcal adjustments — can ever weight them
-- differently, and there is no way to find them again to re-verify when a
-- better model lands.
--
-- Added now, while a migration is already being written, for the reason the
-- original comment on this column gives: "adding a value to a CHECK later is a
-- migration where declaring it now costs nothing."
ALTER TABLE nutrition_foods DROP CONSTRAINT nutrition_foods_source_check;
ALTER TABLE nutrition_foods ADD CONSTRAINT nutrition_foods_source_check
    CHECK (source IN ('user', 'seed', 'usda', 'off', 'ai'));
