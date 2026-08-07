-- LOSSY, and it PUBLISHES rather than merely forgetting.
--
-- Dropping `status` erases which exercises were unfinished, and the public
-- catalog serves them to athletes immediately — a half-written exercise with a
-- name and no instructions, live, with nothing reporting a fault. Re-running
-- the up migration cannot recover the distinction: the default is 'published'.
--
-- Publish or delete the drafts first. `SELECT id, name FROM exercises WHERE
-- status = 'draft'` is the list.
ALTER TABLE exercises DROP COLUMN IF EXISTS status;
