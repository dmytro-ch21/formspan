SET lock_timeout = '3s';

-- Narrowing the CHECK back would fail on any row already written as 'ai', so
-- those are returned to 'user' first. That is lossy — the whole point of the
-- value is that an AI-drafted food stays distinguishable — which is the honest
-- behaviour for a down migration: it says what it costs rather than erroring
-- halfway and leaving the constraint dropped.
UPDATE nutrition_foods SET source = 'user' WHERE source = 'ai';

ALTER TABLE nutrition_foods DROP CONSTRAINT nutrition_foods_source_check;
ALTER TABLE nutrition_foods ADD CONSTRAINT nutrition_foods_source_check
    CHECK (source IN ('user', 'seed', 'usda', 'off'));

DROP TABLE IF EXISTS food_barcode_cache;
DROP TABLE IF EXISTS food_catalog;
