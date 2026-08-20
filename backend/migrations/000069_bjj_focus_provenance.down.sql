-- The table first: its composite FK points at bjj_focus, and dropping the
-- column out from under it is not something Postgres will do quietly.
DROP TABLE IF EXISTS bjj_focus_sources;

ALTER TABLE bjj_focus DROP COLUMN IF EXISTS origin;
