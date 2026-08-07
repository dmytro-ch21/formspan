-- Destroys the audit trail and every restorable version. There is no other
-- copy: the console is the only writer of this content, so what is dropped here
-- is not recoverable from git, a re-seed, or a backup of anything else.
--
-- `cmd/exportcontent` writes the CURRENT state of each exercise into the seed
-- JSON and captures none of the history — the closest thing to a rescue this
-- leaves you.
DROP TABLE IF EXISTS exercise_revisions;
