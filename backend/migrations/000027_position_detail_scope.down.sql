ALTER TABLE positions
    DROP COLUMN IF EXISTS detail_includes,
    DROP COLUMN IF EXISTS detail_excludes;
