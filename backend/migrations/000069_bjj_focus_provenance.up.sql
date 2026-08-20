-- Why a focus row is there, and therefore who is allowed to take it away.
--
-- THE BUG THIS CLOSES. Activating a roadmap writes its techniques into
-- bjj_focus, where they render as one-tap chips in the reflection wizard.
-- Deactivating it left them behind, and the athlete's reading was the correct
-- one: I turned this off, why is it still here. The reason it was never fixed
-- is in 000031 -- the table records WHAT is in focus and never why, so
-- "remove what that roadmap added" was not a question it could answer. It got
-- answered the only way an unanswerable question can be.
--
-- The obvious fix is a data-loss bug wearing a fix's clothes. Clearing focus on
-- deactivation destroys whatever the athlete chose by hand, and the client-side
-- half of this loop (roadmapFocus.ts) already refuses to evict those when it
-- WRITES -- "the roadmap is not entitled to it". Un-enrolment has to be at
-- least as careful, and that takes a stored fact rather than a convention.

SET lock_timeout = '3s';

-- Three values, TWO behaviours. The third is not redundant: it is the
-- difference between recording that we do not know and recording a guess.
--
--   'athlete' -- the athlete put this here. SOVEREIGN. No roadmap may ever
--                remove it, and that is the safety property the whole feature
--                rests on.
--   'roadmap' -- a roadmap put this here. Removed when the last roadmap still
--                asking for it lets go; see bjj_focus_sources below.
--   'unknown' -- written before this migration. WE DO NOT KNOW, so it behaves
--                exactly like 'athlete' and nothing deletes it.
--
-- WHY EXISTING ROWS BECOME 'unknown' AND NOT 'roadmap'. Backfilling 'roadmap'
-- would fix the reported bug for everybody currently living with it, and would
-- also delete, on the next deactivation, every technique those athletes picked
-- by hand -- because the two are indistinguishable in the data as it stands.
-- A migration that guesses wrong here destroys an athlete's intentions and
-- leaves no trace that it was a guess. So the safe direction is chosen
-- deliberately: existing rows are never removed by a deactivation, which means
-- an athlete already carrying stale roadmap techniques keeps them until they
-- clear them by hand (one tap, on a list capped at five). Wrong-and-recoverable
-- beats right-and-destructive.
--
-- The DEFAULT stays 'unknown' rather than being dropped after this migration,
-- and that is also the safe direction: an insert that forgets to state
-- provenance produces a row nothing will ever delete, instead of one silently
-- owned by whoever asks first.
--
-- Note ADD COLUMN with a non-volatile DEFAULT does not rewrite the table on
-- PG11+, so this is cheap regardless of how many rows exist.
ALTER TABLE bjj_focus
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown'
        CONSTRAINT bjj_focus_origin_known CHECK (origin IN ('athlete', 'roadmap', 'unknown'));

-- Which roadmaps are currently asking for a focus row. A SET, not a column.
--
-- A single source_curriculum_id would answer "who added this" and get the
-- SECOND question wrong: two syllabuses genuinely can both want the armbar, and
-- on a list capped at five, two enrolled roadmaps overlapping is the ordinary
-- case rather than the exotic one. With one column the first roadmap owns the
-- row, and deactivating it takes the technique away from the roadmap still
-- working it -- a fix that breaks the thing next to what it fixed.
CREATE TABLE IF NOT EXISTS bjj_focus_sources
(
    user_id       TEXT NOT NULL,
    technique_id  TEXT NOT NULL,

    -- CASCADE: if the curriculum itself is deleted, its claim dies with it and
    -- the focus row is left with one fewer reason to be there. It cannot strand
    -- a row in practice -- curriculum_enrollments' ON DELETE RESTRICT means a
    -- curriculum anybody is enrolled in cannot be deleted at all, and only an
    -- enrolment can have placed these rows -- but a dangling id would be worse
    -- than an over-cautious constraint.
    curriculum_id TEXT NOT NULL REFERENCES curricula (id) ON DELETE CASCADE,

    PRIMARY KEY (user_id, technique_id, curriculum_id),

    -- The composite FK is what guarantees a claim can never outlive the row it
    -- is about: drop a technique from focus by hand and every roadmap's claim on
    -- it goes too, so re-adding it later starts from a clean provenance rather
    -- than inheriting a stale one.
    FOREIGN KEY (user_id, technique_id)
        REFERENCES bjj_focus (user_id, technique_id) ON DELETE CASCADE
);

-- The release path's only read: one athlete's rows for one curriculum. The
-- primary key leads on user_id and cannot serve this, since curriculum_id is
-- its third column.
CREATE INDEX IF NOT EXISTS bjj_focus_sources_user_curriculum_idx
    ON bjj_focus_sources (user_id, curriculum_id);
