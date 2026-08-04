-- IRREVERSIBLY LOSSY, despite reading like a clean inverse.
--
-- Dropping `source` erases which rows were authored in the console. Re-running
-- the up migration marks every one of them 'seed', and the next deploy's
-- re-seed then overwrites or orphans them. There is no SQL that can undo that,
-- so export admin content before rolling this back.
DROP INDEX IF EXISTS exercises_source_idx;
DROP INDEX IF EXISTS techniques_source_idx;
ALTER TABLE exercises DROP COLUMN IF EXISTS source;
ALTER TABLE techniques DROP COLUMN IF EXISTS source;
