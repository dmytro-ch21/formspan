SET lock_timeout = '3s';

-- A unique, claimable handle — the lookup key the sharing design needs.
--
-- `display_name` cannot serve: it is nullable, non-unique, and free prose.
-- The social design (docs/decisions/history.md, 2026-08-06 sequences entry)
-- settled on usernames over invite codes, accepting the enumeration surface
-- that comes with a searchable handle. This column is that decision's schema.
--
-- NULLABLE, because claiming is opt-in until sharing ships. Every existing
-- account has none, and forcing a claim at migration time would mean the
-- migration inventing names — the one thing a handle must never be.
ALTER TABLE profiles
    ADD COLUMN username TEXT;

-- Uniqueness is CASE-INSENSITIVE, enforced on lower(username) rather than the
-- column, and this is defence in depth rather than the primary rule: Go
-- validation only admits [a-z0-9_], so a mixed-case value should never reach
-- the table. The expression index is what makes that "should" safe — if a
-- future writer bypasses validation, "Dmytro" still cannot coexist with
-- "dmytro". Two handles that differ only in case are one handle to every
-- human who types them.
--
-- No CHECK constraint on the format, per the convention migration 000021
-- established: an enumerated or patterned vocabulary is validated in Go,
-- where changing it is a code change rather than a migration. The reserved
-- list especially will grow, and a CHECK would freeze it in schema.
CREATE UNIQUE INDEX profiles_username_unique
    ON profiles (lower(username))
    WHERE username IS NOT NULL;
