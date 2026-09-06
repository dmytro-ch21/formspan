-- N490: a real "when this set actually happened" timestamp, so heart rate
-- can be windowed per EXERCISE rather than only per whole session.
--
-- `created_at` cannot serve this: `ReplaceSets` (session/postgres.go) does
-- `DELETE FROM session_sets WHERE session_id = $1` and reinserts the whole
-- list on every save, so every set's `created_at` reads as "the last time
-- this session was saved" — identical across the entire session, never
-- "when set 3 of squats was actually racked". See session.Set.PerformedAt's
-- own doc comment and docs/decisions/history.md's N490 entry for the full
-- argument.
--
-- NULLABLE, and always will be — never backfilled and never defaulted to
-- now(): every set logged before this shipped, and any set a client saves
-- without live-toggling completion (a reflection entered well after the
-- fact, or an older app build), has no true completion moment to record.
-- NULL says exactly that, which is the honest answer — inventing one from
-- save time would just be the old `created_at` lie with extra steps.
ALTER TABLE session_sets
    ADD COLUMN performed_at TIMESTAMPTZ;
