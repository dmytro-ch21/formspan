-- The extension stays: 000017 created it for the technique library and still
-- needs it. Dropping it here would take that index with it.
SET lock_timeout = '3s';

DROP INDEX IF EXISTS exercises_name_trgm_idx;
