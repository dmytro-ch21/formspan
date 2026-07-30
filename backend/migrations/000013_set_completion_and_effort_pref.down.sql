-- Completion flags are unrecoverable: dropping the column loses which sets
-- were actually performed. Re-running the up migration afterwards backfills
-- *every* row to true, which would silently mark planned-but-skipped sets as
-- done — inflating past volume and feeding phantom history to the
-- progression rule. Restore from a dump rather than cycling this migration.
ALTER TABLE profiles DROP COLUMN track_effort;
ALTER TABLE session_sets DROP COLUMN completed;
