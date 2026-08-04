DROP INDEX IF EXISTS exercises_source_idx;
DROP INDEX IF EXISTS techniques_source_idx;
ALTER TABLE exercises DROP COLUMN IF EXISTS source;
ALTER TABLE techniques DROP COLUMN IF EXISTS source;
