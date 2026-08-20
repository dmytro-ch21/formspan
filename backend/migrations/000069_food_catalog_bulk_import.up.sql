-- The catalog stops being 177 hand-picked foods (N88).
--
-- `scripts/import_usda_foods.py` used to read the whole SR Legacy dump and
-- discard almost all of it, because its SPEC list was an inclusion filter. It
-- now imports SR Legacy AND FNDDS in full — 12,651 rows, of which 177 are the
-- same curated foods as before. FNDDS is the half the catalog never had: cooked
-- and mixed dishes, which is what an athlete logging dinner is actually eating.
--
-- Two columns change, and both are consequences of the row count rather than
-- new features.

SET lock_timeout = '3s';


-- # rank_tier — which rows win when hundreds match
--
-- **This column is the only thing standing between a curated food and the 803
-- rows that match "chicken".** Measured on the source data: 394 SR Legacy rows
-- and 409 FNDDS rows contain the word.
--
-- At 177 rows the search's existing two signals were enough. `SearchRank`
-- orders by the earliest position a typed word appears in the name, then by
-- trigram similarity — the reasoning is written out at length in search.go, and
-- the case it was built for is USDA ranking "Lunchmeat, chicken breast, sliced"
-- above chicken breast. Neither signal separates a curated row from a bulk one,
-- because both lead with the same word: "Chicken breast" and "Chicken breast,
-- fried, coated, skin / coating eaten, from pre-cooked" tie on lead position,
-- and similarity then rewards whichever string is shorter, which is not the
-- same question as which food the athlete meant.
--
-- So provenance becomes the primary sort key. 0 is the curated set — foods a
-- human named, gave aliases to, and resolved to one specific USDA row. 1 is
-- everything imported in bulk.
--
-- **A SMALLINT rather than a boolean**, because the next distinction is already
-- visible: Foundation Foods, branded products and console-authored rows all
-- have a defensible claim to a tier of their own, and `curated BOOLEAN` would
-- make each of those a migration. Nothing sorts on values above 1 today.
--
-- DEFAULT 1 is deliberate and is the safe direction: a row that arrives without
-- an opinion — a console-authored one, or a future importer that forgets — sorts
-- with the bulk catalog rather than ahead of the curated set. Getting this
-- backwards would let any new row outrank every food a human picked.
ALTER TABLE food_catalog
    ADD COLUMN rank_tier SMALLINT NOT NULL DEFAULT 1 CHECK (rank_tier >= 0);

COMMENT ON COLUMN food_catalog.rank_tier IS
    'Search precedence, lowest first. 0 = hand-curated, 1 = bulk USDA import. '
    'Primary sort key of the catalog search; see internal/modules/food/search.go.';

-- The seeded curated set. Scoped to source = 'seed' for the same reason the
-- seeder's own upsert is: a console edit takes ownership of a row, and a
-- migration that ignored that would undo an admin's work as surely as a deploy
-- would.
UPDATE food_catalog
   SET rank_tier = 0
 WHERE source = 'seed'
   AND id NOT LIKE 'usda-%';

-- No index on rank_tier, deliberately.
--
-- It is a sort key, not a filter — every catalog search reads every tier — and
-- a two-value column is the textbook case where an index earns nothing. The
-- ordering is computed above the scan either way. Migration 000062 kept an
-- unused trigram index as headroom because writes there are rare; that argument
-- does not extend to an index that could never be selective. Measure before
-- adding one.


-- # name — 120 characters was set when every row was hand-written
--
-- The curated names are things like "Chicken breast" and "Greek yogurt, plain,
-- nonfat", so 120 was generous. USDA descriptions are not written that way:
--
--   "Pork, fresh, composite of trimmed leg, loin, shoulder, and spareribs,
--    (includes cuts to be cured), separable lean and fat, raw"        126 chars
--   "Chicken or turkey, potatoes, and vegetables including carrots, broccoli,
--    and/or dark-green leafy; cream sauce, white sauce, or mushroom sauce" 141
--
-- Measured across both datasets: 72 rows exceed 120 characters (56 SR Legacy,
-- 16 FNDDS), longest 184. That is 0.5% of the catalog.
--
-- **Truncating was the obvious alternative and is the wrong one.** The part
-- that overflows is the part that distinguishes the row — "separable lean only,
-- trimmed to 0" fat, choice, cooked, grilled" is the difference between four
-- otherwise identical beef entries. A truncated name is also a worse search
-- target, since the tokens that would disambiguate it are the ones cut off.
--
-- 200 rather than unbounded: a length cap is still worth having as a guard on
-- console-authored input, and 200 clears the measured maximum with room for a
-- future release to lengthen a description without needing another migration.
--
-- This works against N58 ("Food search results should be scannable, not a wall
-- of names"), and that tension is real. It is a rendering problem and belongs in
-- rendering — shortening the stored name to make a list fit would be discarding
-- data to fix a layout.
ALTER TABLE food_catalog DROP CONSTRAINT food_catalog_name_check;
ALTER TABLE food_catalog ADD CONSTRAINT food_catalog_name_check
    CHECK (length(btrim(name)) BETWEEN 1 AND 200);
