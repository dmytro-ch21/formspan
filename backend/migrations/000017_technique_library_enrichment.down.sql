-- Drop the FK column before the table it references, or the DROP TABLE fails.
DROP INDEX IF EXISTS techniques_name_trgm_idx;
DROP INDEX IF EXISTS techniques_ibjjf_ruleset_id_idx;

ALTER TABLE techniques
    DROP COLUMN IF EXISTS ibjjf_ruleset_id,
    DROP COLUMN IF EXISTS source_notes,
    DROP COLUMN IF EXISTS video_reference,
    DROP COLUMN IF EXISTS common_next_moves,
    DROP COLUMN IF EXISTS when_to_use;

DROP TABLE IF EXISTS ibjjf_rulesets;

-- pg_trgm is deliberately NOT dropped. It is database-wide and something else
-- may have started using it; dropping an extension another index depends on
-- takes that index with it.
