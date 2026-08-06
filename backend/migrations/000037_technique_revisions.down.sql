-- Destroys the audit trail and every restorable version. There is no other
-- copy: the console is the only writer of this content, so what is dropped here
-- is not recoverable from git, a re-seed, or a backup of anything else.
--
-- Export anything worth keeping first — `cmd/exportcontent` writes the CURRENT
-- state of each technique into the seed JSON, which is the closest thing to a
-- rescue this leaves you, and it captures none of the history.
DROP TABLE IF EXISTS technique_revisions;
