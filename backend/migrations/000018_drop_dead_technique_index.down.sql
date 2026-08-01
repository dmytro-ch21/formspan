-- Recreated for symmetry only; see the up migration for why it earns nothing.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS techniques_name_trgm_idx
    ON techniques USING GIN (name gin_trgm_ops);
