DROP INDEX IF EXISTS techniques_position_function_idx;

ALTER TABLE techniques
    DROP COLUMN IF EXISTS function;
