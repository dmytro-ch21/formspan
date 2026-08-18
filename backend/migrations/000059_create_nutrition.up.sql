-- What the athlete is trying to eat, and what they actually ate.
--
-- Four tables, one migration. One pair of files rather than four because a
-- migration number is a contended resource — two branches picking the same one
-- is something golang-migrate refuses to start on, and it is invisible in
-- `git diff origin/main...HEAD` because a three-dot diff uses the merge base.
-- Four numbers would be four chances to collide instead of one.
--
-- THE RULE THIS SCHEMA EXISTS TO PROTECT: a logged row owns its numbers.
-- nutrition_entries and nutrition_recipe_items both COPY the macros they were
-- created with. `source_food_id` is provenance — it answers "log this again" —
-- and no query that returns nutrition may follow it. The join is shorter, it
-- compiles, and it passes every test, because the damage is invisible:
-- correcting a saved food would silently rewrite every entry ever logged from
-- it, along with every average an athlete was using to learn something. There
-- would be nothing left to compare against, so nothing would go red. Same
-- reasoning that keeps `plans` free of a `completed` flag.

-- The target that was live from a date.
--
-- The DATE IS THE IDENTITY. "Set my target from today" is therefore an
-- idempotent upsert — the same contract body_checkins uses for a day — and
-- "what was I eating to in March" is the newest row on or before that day.
-- A single mutable current_target column cannot express the second question at
-- all: it would silently re-judge every past week against today's number.
CREATE TABLE nutrition_targets (
    user_id       TEXT NOT NULL,
    effective_on  DATE NOT NULL,

    -- Integers, not numerics. Nobody eats to a tenth of a gram, and a target
    -- printed to three decimal places implies a precision this whole chain does
    -- not have. The derivation rounds macros to 5 g and kcal to 10 before it
    -- gets here.
    kcal       INTEGER NOT NULL CHECK (kcal      BETWEEN 800 AND 8000),
    protein_g  INTEGER NOT NULL CHECK (protein_g BETWEEN 0 AND 500),
    carb_g     INTEGER NOT NULL CHECK (carb_g    BETWEEN 0 AND 1200),
    fat_g      INTEGER NOT NULL CHECK (fat_g     BETWEEN 0 AND 400),
    -- Advisory, and nullable because a target set before fibre was modelled is
    -- not claiming zero fibre.
    fibre_g    INTEGER CHECK (fibre_g IS NULL OR fibre_g BETWEEN 0 AND 120),

    -- 'derived' came from the wizard and carries a basis; 'manual' was typed
    -- and has no arithmetic to show; 'adjustment' is a weekly proposal the
    -- athlete accepted. The last two are distinguished because an adjustment
    -- can be explained and a typed number cannot.
    source     TEXT NOT NULL CHECK (source IN ('derived', 'manual', 'adjustment')),

    -- The arithmetic that produced this target, FROZEN at the moment it was
    -- accepted.
    --
    -- Deliberately not recomputed on read. Weight, height and the live phase
    -- all move, so a "live" explanation is a confident lie about a past
    -- decision — the same class of error as the copied-macros rule above, one
    -- level up. JSONB rather than columns because it is rendered as a block and
    -- never filtered on, and because its shape will grow as the derivation
    -- does. NULL for a manual target.
    basis      JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, effective_on)
);
-- No second index, matching body_checkins' reasoning: the primary key already
-- orders (user_id, effective_on), which serves both the window scan and the
-- backward "live on this date" scan. A covering index here would be a second
-- structure to keep warm for no query that exists.

-- A saved food, or a recipe.
--
-- One table keyed by `kind` rather than two, because from the client's side
-- logging either is the same action — pick a thing, scale it, copy its numbers
-- — and two tables would force the picker to merge two lists and keep them
-- sorted together.
CREATE TABLE nutrition_foods (
    -- Client-generated, like every offline-created row in this schema: it is
    -- the idempotency key that lets a phone create a food with no signal and
    -- push it later without risking a duplicate.
    id       UUID PRIMARY KEY,
    user_id  TEXT NOT NULL,
    kind     TEXT NOT NULL CHECK (kind IN ('food', 'recipe')),

    name     TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    brand    TEXT NOT NULL DEFAULT '' CHECK (length(brand) <= 80),

    -- What ONE serving is, as the athlete would say it: '100 g', '1 scoop
    -- (30 g)', '1 egg'. A label rather than a quantity-and-unit pair because
    -- the server never parses it and never multiplies by it — the client sends
    -- absolute macros. That is what keeps unit conversion out of this schema
    -- entirely.
    serving_label TEXT NOT NULL CHECK (length(btrim(serving_label)) BETWEEN 1 AND 40),
    -- Nullable on purpose: an egg has no honest gram weight, and inventing one
    -- would make every gram-based total quietly fictional.
    serving_grams NUMERIC(9, 2) CHECK (serving_grams IS NULL OR serving_grams > 0),

    -- PER ONE SERVING. For a recipe these are derived from its items at write
    -- time (sum ÷ yield_servings) and STORED, not joined — the picker lists
    -- dozens of rows and would otherwise fan out one query per recipe.
    kcal      NUMERIC(8, 2) NOT NULL CHECK (kcal      >= 0 AND kcal      < 20000),
    protein_g NUMERIC(7, 2) NOT NULL CHECK (protein_g >= 0 AND protein_g < 2000),
    carb_g    NUMERIC(7, 2) NOT NULL CHECK (carb_g    >= 0 AND carb_g    < 2000),
    fat_g     NUMERIC(7, 2) NOT NULL CHECK (fat_g     >= 0 AND fat_g     < 2000),
    -- Nullable, and it is not the same statement as zero: a label that does not
    -- state fibre is not claiming there is none, and averaging unstated as zero
    -- drags every fibre figure down.
    fibre_g   NUMERIC(7, 2) CHECK (fibre_g IS NULL OR (fibre_g >= 0 AND fibre_g < 500)),

    -- 'this makes 6 portions'. Recipes only; the biconditional is enforced
    -- below so a food cannot carry a yield and a recipe cannot omit one.
    yield_servings NUMERIC(6, 2) CHECK (yield_servings IS NULL OR (yield_servings > 0 AND yield_servings < 1000)),
    CHECK ((kind = 'recipe') = (yield_servings IS NOT NULL)),

    -- Where the row came from. 'usda' and 'off' are declared now and unused:
    -- they are the two integrations already decided on, and adding a value to a
    -- CHECK later is a migration where declaring it now costs nothing. Open
    -- Food Facts rows must additionally stay SEPARABLE from ones we authored —
    -- it is ODbL, and its share-alike obligation must never reach our own data.
    source      TEXT NOT NULL DEFAULT 'user'
                CHECK (source IN ('user', 'seed', 'usda', 'off')),
    external_id TEXT,
    barcode     TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The picker's only query: this user's foods, by name.
CREATE INDEX nutrition_foods_user_name_idx ON nutrition_foods (user_id, lower(name));

-- DELIBERATELY NOT UNIQUE on (user_id, name). Two 'Chicken breast' rows from
-- two brands is a real state, not a mistake — and a 409 raised while an offline
-- outbox is flushing a batch is a worse failure than a duplicate row the
-- athlete can delete in one swipe.

-- One external row per source, so a re-import updates rather than duplicates.
CREATE UNIQUE INDEX nutrition_foods_external_idx
    ON nutrition_foods (source, external_id) WHERE external_id IS NOT NULL;

-- A recipe's components.
--
-- Their nutrition is copied here too, for the reason at the top of this file:
-- correcting 'chicken thigh' must not rewrite a recipe built last month.
CREATE TABLE nutrition_recipe_items (
    food_id  UUID NOT NULL REFERENCES nutrition_foods (id) ON DELETE CASCADE,
    position SMALLINT NOT NULL CHECK (position >= 0 AND position < 100),

    name          TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    quantity      NUMERIC(9, 2) NOT NULL CHECK (quantity > 0 AND quantity < 10000),
    serving_label TEXT NOT NULL CHECK (length(btrim(serving_label)) BETWEEN 1 AND 40),

    kcal      NUMERIC(8, 2) NOT NULL CHECK (kcal      >= 0 AND kcal      < 20000),
    protein_g NUMERIC(7, 2) NOT NULL CHECK (protein_g >= 0 AND protein_g < 2000),
    carb_g    NUMERIC(7, 2) NOT NULL CHECK (carb_g    >= 0 AND carb_g    < 2000),
    fat_g     NUMERIC(7, 2) NOT NULL CHECK (fat_g     >= 0 AND fat_g     < 2000),
    fibre_g   NUMERIC(7, 2) CHECK (fibre_g IS NULL OR (fibre_g >= 0 AND fibre_g < 500)),

    -- Provenance only, never read for nutrition. SET NULL rather than CASCADE
    -- so deleting a favourite cannot silently remove an ingredient from a
    -- recipe that still contains it.
    source_food_id UUID REFERENCES nutrition_foods (id) ON DELETE SET NULL,

    PRIMARY KEY (food_id, position)
);

-- One logged item.
CREATE TABLE nutrition_entries (
    id       UUID PRIMARY KEY,
    user_id  TEXT NOT NULL,

    -- The LOCAL calendar day. Never derived from a UTC timestamp: west of
    -- Greenwich a 22:00 snack lands on tomorrow, and the remaining figure is
    -- then wrong on two days at once. The clients use their own dayString()
    -- helper for exactly this; `toISOString().slice(0,10)` is banned repo-wide.
    eaten_on DATE NOT NULL,

    -- Assigned from the wall clock at log time and STORED, never re-derived on
    -- read. A dinner logged at 23:00 is dinner; a rule that recomputed it from
    -- the timestamp would quietly move it to 'snack' the next time anybody
    -- looked at the day.
    meal     TEXT NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'dinner', 'snack')),

    name          TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    -- How many of serving_label were eaten — 1.5 x '100 g'. Multiples of a
    -- canonical serving rather than grams-as-primary, because a gram keypad on
    -- every log is what makes these apps slow enough to abandon.
    servings      NUMERIC(9, 2) NOT NULL CHECK (servings > 0 AND servings < 10000),
    serving_label TEXT NOT NULL CHECK (length(btrim(serving_label)) BETWEEN 1 AND 40),

    -- ABSOLUTE for the quantity logged, already multiplied by servings. The
    -- server never scales and never converts a unit.
    kcal      NUMERIC(8, 2) NOT NULL CHECK (kcal      >= 0 AND kcal      < 20000),
    protein_g NUMERIC(7, 2) NOT NULL CHECK (protein_g >= 0 AND protein_g < 2000),
    carb_g    NUMERIC(7, 2) NOT NULL CHECK (carb_g    >= 0 AND carb_g    < 2000),
    fat_g     NUMERIC(7, 2) NOT NULL CHECK (fat_g     >= 0 AND fat_g     < 2000),
    fibre_g   NUMERIC(7, 2) CHECK (fibre_g IS NULL OR (fibre_g >= 0 AND fibre_g < 500)),

    source_food_id UUID REFERENCES nutrition_foods (id) ON DELETE SET NULL,

    notes      TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read of this table is one user's window of days.
CREATE INDEX nutrition_entries_user_day_idx ON nutrition_entries (user_id, eaten_on);

-- THERE IS DELIBERATELY NO CHECK RECONCILING kcal AGAINST 4P + 4C + 9F.
--
-- Real labels do not reconcile. Rounding, fibre, sugar alcohols and Atwater's
-- own approximations put them 5-10% apart routinely, so a constraint here would
-- reject correct data read straight off a packet — the single most common way
-- an entry is created. kcal is authoritative, the API contract says so, and a
-- client that "fixes" the discrepancy by recomputing kcal from the macros is
-- discarding the number the manufacturer measured in favour of an estimate.
