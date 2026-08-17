-- The constraint goes with the column. Dropping this loses every record of how
-- a set was held; nothing else is affected, because no figure is derived from
-- grip — it is recorded and displayed, never summed.
--
-- Same bound as the up. `DROP COLUMN` takes ACCESS EXCLUSIVE on the largest
-- table in the app, and without this it waits indefinitely behind whatever is
-- reading — failing fast is better than blocking every session write.
SET lock_timeout = '3s';

ALTER TABLE session_sets DROP CONSTRAINT IF EXISTS session_sets_grip_valid;
ALTER TABLE session_sets DROP COLUMN IF EXISTS grip;
