-- N465: dedup key for a run imported from Apple HealthKit.
--
-- Nullable — every phone-GPS and manual run has no HealthKit workout behind
-- it, and that is not a gap to backfill, the same stance every other nullable
-- column on this table already takes (see 000085).
--
-- The unique index is scoped PER USER, not global: two athletes' watches can
-- never produce colliding HealthKit UUIDs in practice (Apple mints them),
-- but scoping to the owner is free and matches this table's existing
-- ownership stance rather than trusting a third party's uniqueness globally.
-- It is PARTIAL (`WHERE healthkit_uuid IS NOT NULL`) so the many phone-GPS
-- and manual rows with no UUID never collide with each other or count
-- against the index.
--
-- This is the BACKSTOP, not the primary dedup mechanism — the mobile import
-- flow (lib/healthkitSync.ts) checks its own local ledger before ever
-- creating a session, so a repeat import on the SAME device never reaches
-- this index at all. What this catches is a reinstalled app or a second
-- device with no local ledger of its own: PutDetail's upsert is keyed on
-- session_id, so without this index a second device re-importing the same
-- watch-recorded run would attach a SECOND detail row to it.
--
-- This index refuses that detail row, no more — it says nothing about the
-- generic `sessions` row a client creates BEFORE reaching this endpoint,
-- which by the time this fires already exists server-side. What makes the
-- end-to-end guarantee "no duplicate RUN in history" hold is the mobile
-- client's own handling of the 409 this produces: it deletes the session it
-- just created rather than leaving it an orphaned, detail-less duplicate —
-- see running.ErrAlreadyExists's doc comment and
-- apps/mobile/lib/sessionStore.ts's abandonDuplicateHealthKitImport.

SET lock_timeout = '3s';

ALTER TABLE running_session_detail ADD COLUMN healthkit_uuid TEXT;

CREATE UNIQUE INDEX running_session_detail_healthkit_uuid_per_user
    ON running_session_detail (user_id, healthkit_uuid)
    WHERE healthkit_uuid IS NOT NULL;
