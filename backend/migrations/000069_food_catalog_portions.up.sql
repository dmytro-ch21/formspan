-- Household portions: a food stops being only "100 g" (N89).
--
-- Every seeded row shipped by N88 is per 100 g, and `food_catalog` carries ONE
-- serving_label + serving_grams pair, so a food could only ever be measured one
-- way. seed.go recorded that as a known gap in as many words:
--
--   Household portions ("1 medium banana, 118 g") do exist in the source and
--   are deliberately not imported — a known gap, not an oversight.
--
-- The consequence on the phone was that tapping a catalog row logged 1 x 100 g
-- with no way to say otherwise, so an athlete eating one banana logged 100 g of
-- banana.
--
-- USDA carries this: 14,449 portions in SR Legacy and 22,194 in FNDDS. 30,966
-- of those are importable — see the exclusions in scripts/import_usda_foods.py.

SET lock_timeout = '3s';

-- A separate TABLE rather than more columns on food_catalog, because a food has
-- SEVERAL portions — 2.4 on average, up to 18. Columns would mean either one
-- portion per food (which is the limitation this migration exists to remove) or
-- eighteen sets of nullable columns.
CREATE TABLE food_catalog_portions (
    food_id TEXT NOT NULL REFERENCES food_catalog (id) ON DELETE CASCADE,

    -- USDA's own `sequenceNumber`, and it is the DISPLAY ORDER as well as half
    -- the key. Verified unique within a food across both datasets (0 duplicates
    -- in 30,966 rows), which is what makes it safe as a key component; max
    -- observed is 18.
    --
    -- Their order rather than ours on purpose: USDA lists the most
    -- representative portion first, and any ordering we invented — shortest
    -- label, smallest gram weight — would be a guess dressed as editorial
    -- judgement.
    seq SMALLINT NOT NULL CHECK (seq >= 0),

    -- What a person would say: "1 cup", "1 medium", "1 waffle, round".
    --
    -- Built differently per dataset, because the two describe portions in
    -- genuinely different shapes — SR Legacy has `amount` + `modifier` with
    -- `measureUnit` set to the literal string "undetermined" on all 14,449 of
    -- its portions, while FNDDS has a ready-made `portionDescription` and no
    -- `amount` at all. The composition happens in the importer; this column
    -- stores the finished phrase.
    --
    -- 120 rather than 80: the longest observed is 114 characters.
    label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),

    -- What the portion WEIGHS. NOT NULL and strictly positive, and that is the
    -- whole point of the table — a portion whose gram weight is unknown cannot
    -- be logged against a calorie target, and inventing one would make every
    -- total computed from it fictional.
    --
    -- FNDDS really does ship a portion with gramWeight 0 ("Milk, human",
    -- "Quantity not specified"). This CHECK is what stops it, and the importer
    -- drops it before it ever gets here.
    grams NUMERIC(9, 2) NOT NULL CHECK (grams > 0 AND grams < 100000),

    PRIMARY KEY (food_id, seq)
);

-- NO unique constraint on (food_id, label), deliberately.
--
-- 18 SR Legacy foods carry two portions with the SAME label and DIFFERENT gram
-- weights — the same words describing a different preparation. A unique
-- constraint would reject real data to enforce a tidiness nothing reads, which
-- is the same argument migration 000066 makes for not asserting
-- added_sugar_g <= sugar_g.

-- ON DELETE CASCADE above is the only foreign key behaviour that makes sense
-- here — a portion has no meaning without its food — but note the warning in
-- CLAUDE.md's test section: a CASCADE is more dangerous than a RESTRICT because
-- the constraint that blocks you is the one that tells you. Anything deleting
-- from food_catalog now silently takes portions with it.

COMMENT ON TABLE food_catalog_portions IS
    'Household portions per catalog food, from USDA foodPortions. seq is USDA''s '
    'own sequenceNumber and is the display order. 100 g is NOT stored here — it '
    'is always available from food_catalog.serving_grams.';

-- The read is always "every portion for this food", which the primary key's
-- leading column already serves. No second index.
