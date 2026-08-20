SET lock_timeout = '3s';

DROP INDEX IF EXISTS nutrition_estimates_user_window_idx;

-- Lossy, and there is no honest way not to be: these are measurements, and
-- dropping the columns discards them. Nothing derives from them yet, so the
-- cost is the history rather than any behaviour.
ALTER TABLE nutrition_estimates
    DROP COLUMN IF EXISTS input_tokens,
    DROP COLUMN IF EXISTS output_tokens,
    DROP COLUMN IF EXISTS cached_input_tokens,
    DROP COLUMN IF EXISTS reasoning_tokens,
    DROP COLUMN IF EXISTS image_tokens;
