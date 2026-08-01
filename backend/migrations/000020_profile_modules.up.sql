-- Per-user module enablement as ROWS, replacing four boolean columns.
--
-- WHY: `profiles` carried bjj_enabled / strength_enabled / nutrition_enabled /
-- running_enabled as literal columns. Adding a fifth discipline meant a
-- migration plus ~13 Go/SQL edits, three of them explicit column lists and one
-- a positional-placeholder args slice that nothing type-checks — insert a
-- column in the middle of profile/postgres.go's UPDATE and `unit_system`
-- silently shifts from $9 to $10, failing at runtime as a pgx type error.
--
-- As rows, adding a discipline needs NO migration and no change to this table
-- at all. That is the whole point: the registry
-- (internal/platform/discipline) owns the list, and this table only records
-- what a given user chose.
--
-- NO CHECK CONSTRAINT ON module_key, deliberately. A CHECK would put us
-- straight back to a migration per discipline — the exact cost being removed.
-- The registry validates on write; an unknown key in this table is inert
-- because nothing enumerates it (reads go registry-first, joining to these
-- rows), so the failure mode of a stale row is "ignored", not "breaks".
CREATE TABLE profile_modules (
    user_id    TEXT        NOT NULL REFERENCES profiles (user_id) ON DELETE CASCADE,
    module_key TEXT        NOT NULL,
    enabled    BOOLEAN     NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, module_key)
);

-- Backfill from the columns, so nobody's existing choices are lost.
INSERT INTO profile_modules (user_id, module_key, enabled)
SELECT user_id, 'strength',  strength_enabled  FROM profiles
UNION ALL
SELECT user_id, 'bjj',       bjj_enabled       FROM profiles
UNION ALL
SELECT user_id, 'running',   running_enabled   FROM profiles
UNION ALL
SELECT user_id, 'nutrition', nutrition_enabled FROM profiles
ON CONFLICT (user_id, module_key) DO NOTHING;

-- The four columns are LEFT IN PLACE and stop being read.
--
-- Dropping them here would make this migration unrecoverable: roll the api
-- back and the old binary reads columns that no longer exist. Left standing,
-- a rollback reads stale-but-present values — wrong, but not a crash. A
-- follow-up migration drops them once nothing references them.
--
-- Known consequence, written down rather than discovered: between this
-- migration and that one, the columns and these rows can diverge, because only
-- the rows are written. Nothing reads the columns in that window.
