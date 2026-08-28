SET lock_timeout = '3s';

DROP INDEX IF EXISTS food_catalog_aliases_text_trgm_idx;
ALTER TABLE food_catalog DROP COLUMN IF EXISTS aliases_text;
DROP FUNCTION IF EXISTS food_catalog_aliases_text(text[]);
