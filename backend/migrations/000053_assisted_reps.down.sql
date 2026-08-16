-- The constraint goes with the column. Dropping this loses every record of
-- which reps were assisted; nothing else is affected, because `reps` always
-- held the full count and no other figure was derived from the split.
-- Same bound as the up. `DROP COLUMN` takes ACCESS EXCLUSIVE on the largest
-- table in the app, and without this it waits indefinitely behind whatever is
-- reading — failing fast is better than blocking every session write.
SET lock_timeout = '3s';

ALTER TABLE session_sets DROP CONSTRAINT IF EXISTS session_sets_assisted_within_reps;
ALTER TABLE session_sets DROP COLUMN IF EXISTS assisted_reps;
