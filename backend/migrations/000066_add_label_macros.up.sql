-- The rest of what is on a nutrition label.
--
-- Five tables gain five columns: saturated fat, total sugars, added sugars,
-- sodium and cholesterol. The catalog carried kcal/protein/carb/fat/fibre,
-- which is four macros and a footnote — the athlete asked for "all other that
-- are important", and the panel they showed names Total Fat, Sat Fat,
-- Cholesterol, Sodium, Total Carbs, Fiber, Sugars, Protein.
--
-- # The set was MEASURED against both sources, not assumed from a label
--
-- A column nothing can populate is worse than one omitted, so both sources were
-- queried live before this was written:
--
--                   USDA SR Legacy     Open Food Facts      unit
--   saturated fat    3.802 g            9 g / 10.6 g         g / g
--   sugars (total)   4.35 g             1 g / 56.3 g         g / g
--   added sugars     ABSENT             0 g / 52.13 g        — / g
--   sodium           1.0 mg             0.536 g / 0.0428 g   mg / g   <-- !!
--   cholesterol      0.0 mg             ABSENT on both       mg / —
--
-- Two consequences are load-bearing and both look like bugs to whoever meets
-- them first:
--
--   * **cholesterol will be NULL for most scanned products.** Open Food Facts
--     did not carry it on either product tested. That is correct — the panel
--     renders `n/a` — and it is written down here so nobody "fixes" it.
--   * **added sugars will be NULL for every seeded generic food.** SR Legacy
--     does not carry it at all; OFF does, so scans populate it. It is included
--     rather than deferred because adding a column later is a migration and
--     because it has been mandatory on US labels since 2020 — the athletes most
--     likely to look at sugar are the ones holding a packet that states it.
--
-- # SODIUM IS STORED IN MILLIGRAMS, AND THIS IS THE TRAP
--
-- USDA reports sodium in **mg**; Open Food Facts reports it in **GRAMS**.
-- Storing whichever arrived would put a 1000x error into the one field an
-- athlete watching blood pressure actually reads — and `0.536` sitting where
-- `536` belongs is not visibly wrong on a screen. It is in range, it is
-- plausible, and no test written against one source would ever see the other's
-- unit.
--
-- mg wins because it is the US label convention, the USDA convention, and what
-- the athlete's own reference panel shows (`Sodium … 629mg`). The conversion
-- lives at the Open Food Facts boundary and has a test in the failing
-- direction; see `barcode.go`.
--
-- # Salt is NOT stored, and that is deliberate
--
-- Open Food Facts returns both. Measured on two real products, `salt_100g` is
-- **exactly** `sodium_100g x 2.5` (0.536 -> 1.34, and 0.0428 -> 0.107). It is
-- therefore derivable, and two stored numbers that can disagree is strictly
-- worse than one plus a formula. If a region ever needs salt on a label, derive
-- it — do not add a column.
--
-- # Every column is NULLABLE, and that is the whole point
--
-- Absence is a fact about what we know, not a fact about the food. A zero says
-- "this food contains no sodium"; NULL says "nobody told us". Defaulting these
-- to 0 would be the absence-reads-as-an-answer failure this codebase has
-- shipped more often than any other, on the exact panel the athlete showed us.
-- Clients render `n/a`.
--
-- `nutrition_targets` is deliberately NOT widened. A target is a goal, and
-- nobody has asked to set a saturated-fat goal; the design N53 works from shows
-- rings for protein, carbs and fat only. Adding goal columns nothing sets would
-- be inventing an intention.

-- The shared catalog: seeded from USDA, so sat fat / sugar / sodium /
-- cholesterol populate and added sugar does not.
ALTER TABLE food_catalog
    ADD COLUMN saturated_fat_g NUMERIC(7, 2) CHECK (saturated_fat_g IS NULL OR (saturated_fat_g >= 0 AND saturated_fat_g < 2000)),
    ADD COLUMN sugar_g         NUMERIC(7, 2) CHECK (sugar_g         IS NULL OR (sugar_g         >= 0 AND sugar_g         < 2000)),
    ADD COLUMN added_sugar_g   NUMERIC(7, 2) CHECK (added_sugar_g   IS NULL OR (added_sugar_g   >= 0 AND added_sugar_g   < 2000)),
    ADD COLUMN sodium_mg       NUMERIC(9, 2) CHECK (sodium_mg       IS NULL OR (sodium_mg       >= 0 AND sodium_mg       < 100000)),
    ADD COLUMN cholesterol_mg  NUMERIC(9, 2) CHECK (cholesterol_mg  IS NULL OR (cholesterol_mg  >= 0 AND cholesterol_mg  < 100000));

-- The Open Food Facts cache: sat fat / sugar / added sugar / sodium populate,
-- cholesterol usually does not.
ALTER TABLE food_barcode_cache
    ADD COLUMN saturated_fat_g NUMERIC(7, 2) CHECK (saturated_fat_g IS NULL OR (saturated_fat_g >= 0 AND saturated_fat_g < 2000)),
    ADD COLUMN sugar_g         NUMERIC(7, 2) CHECK (sugar_g         IS NULL OR (sugar_g         >= 0 AND sugar_g         < 2000)),
    ADD COLUMN added_sugar_g   NUMERIC(7, 2) CHECK (added_sugar_g   IS NULL OR (added_sugar_g   >= 0 AND added_sugar_g   < 2000)),
    ADD COLUMN sodium_mg       NUMERIC(9, 2) CHECK (sodium_mg       IS NULL OR (sodium_mg       >= 0 AND sodium_mg       < 100000)),
    ADD COLUMN cholesterol_mg  NUMERIC(9, 2) CHECK (cholesterol_mg  IS NULL OR (cholesterol_mg  >= 0 AND cholesterol_mg  < 100000));

-- The athlete's own saved foods.
ALTER TABLE nutrition_foods
    ADD COLUMN saturated_fat_g NUMERIC(7, 2) CHECK (saturated_fat_g IS NULL OR (saturated_fat_g >= 0 AND saturated_fat_g < 2000)),
    ADD COLUMN sugar_g         NUMERIC(7, 2) CHECK (sugar_g         IS NULL OR (sugar_g         >= 0 AND sugar_g         < 2000)),
    ADD COLUMN added_sugar_g   NUMERIC(7, 2) CHECK (added_sugar_g   IS NULL OR (added_sugar_g   >= 0 AND added_sugar_g   < 2000)),
    ADD COLUMN sodium_mg       NUMERIC(9, 2) CHECK (sodium_mg       IS NULL OR (sodium_mg       >= 0 AND sodium_mg       < 100000)),
    ADD COLUMN cholesterol_mg  NUMERIC(9, 2) CHECK (cholesterol_mg  IS NULL OR (cholesterol_mg  >= 0 AND cholesterol_mg  < 100000));

-- Recipe components and logged entries OWN their numbers — neither follows
-- `source_food_id` for nutrition, deliberately, so that correcting a saved food
-- cannot rewrite what somebody already logged. That means the new fields have
-- to live here too, or a logged meal could never show its sodium.
ALTER TABLE nutrition_recipe_items
    ADD COLUMN saturated_fat_g NUMERIC(7, 2) CHECK (saturated_fat_g IS NULL OR (saturated_fat_g >= 0 AND saturated_fat_g < 2000)),
    ADD COLUMN sugar_g         NUMERIC(7, 2) CHECK (sugar_g         IS NULL OR (sugar_g         >= 0 AND sugar_g         < 2000)),
    ADD COLUMN added_sugar_g   NUMERIC(7, 2) CHECK (added_sugar_g   IS NULL OR (added_sugar_g   >= 0 AND added_sugar_g   < 2000)),
    ADD COLUMN sodium_mg       NUMERIC(9, 2) CHECK (sodium_mg       IS NULL OR (sodium_mg       >= 0 AND sodium_mg       < 100000)),
    ADD COLUMN cholesterol_mg  NUMERIC(9, 2) CHECK (cholesterol_mg  IS NULL OR (cholesterol_mg  >= 0 AND cholesterol_mg  < 100000));

ALTER TABLE nutrition_entries
    ADD COLUMN saturated_fat_g NUMERIC(7, 2) CHECK (saturated_fat_g IS NULL OR (saturated_fat_g >= 0 AND saturated_fat_g < 2000)),
    ADD COLUMN sugar_g         NUMERIC(7, 2) CHECK (sugar_g         IS NULL OR (sugar_g         >= 0 AND sugar_g         < 2000)),
    ADD COLUMN added_sugar_g   NUMERIC(7, 2) CHECK (added_sugar_g   IS NULL OR (added_sugar_g   >= 0 AND added_sugar_g   < 2000)),
    ADD COLUMN sodium_mg       NUMERIC(9, 2) CHECK (sodium_mg       IS NULL OR (sodium_mg       >= 0 AND sodium_mg       < 100000)),
    ADD COLUMN cholesterol_mg  NUMERIC(9, 2) CHECK (cholesterol_mg  IS NULL OR (cholesterol_mg  >= 0 AND cholesterol_mg  < 100000));

-- No CHECK asserting added_sugar_g <= sugar_g, though it is a real invariant.
-- Both numbers come from a source that rounds them independently, so a product
-- legitimately reporting 12.0 total and 12.04 added would be REJECTED — the
-- constraint would reject real data to enforce an arithmetic tidiness nothing
-- downstream depends on. A reader that needs the relationship can compare.
