-- The constraint goes with the column. Dropping this loses every record of
-- which reps were assisted; nothing else is affected, because `reps` always
-- held the full count and no other figure was derived from the split.
ALTER TABLE session_sets DROP CONSTRAINT IF EXISTS session_sets_assisted_within_reps;
ALTER TABLE session_sets DROP COLUMN IF EXISTS assisted_reps;
