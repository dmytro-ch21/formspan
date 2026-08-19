-- Dropping the column discards every authored note.
--
-- Recoverable in principle — notes reach `exercises.json` through
-- `cmd/exportcontent`, so anything exported and committed is still in git — but
-- a note authored in the console and not yet exported has no other copy.
ALTER TABLE exercises DROP COLUMN note;
