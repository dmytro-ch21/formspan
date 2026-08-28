-- Matching 000034 and 000035, which both take an FK onto the hot `techniques`
-- catalog: a lock wait behind a long-running read should fail fast rather
-- than queue behind it and block every writer that arrives after.
SET lock_timeout = '3s';

-- A CLASS PLAN is a coach's schedule for one class: an ordered list of
-- blocks — warmup, technique drilling, live rounds, notes — each with a
-- duration. It exists so a coach who teaches four classes a week can write
-- the shape down once and reuse it, and can see at a glance how a planned
-- hour actually divides up.
--
-- WHY NOT `bjj_sequences` OR `curriculum_items`, WHICH ARE ALSO ORDERED
-- LISTS POINTING INTO `techniques`: because the order means a third thing
-- here. A sequence's order is CAUSAL (this move puts you where the next one
-- starts); a curriculum's is PEDAGOGICAL (learn this before that, over
-- months); a class plan's is a SCHEDULE (ten minutes of this, then fifteen
-- of that). Only `technique_drill` blocks even reference the catalog —
-- `warmup`, `live_rounds` and `notes` blocks are plain schedule entries with
-- a duration and, optionally, a note. Reusing either table's shape would
-- force this domain's blocks to carry columns (mastery criteria, causal
-- destinations) that mean nothing here, or force theirs to grow an
-- unrelated fourth meaning for "order".
--
-- NO SHARING AND NO VOLA-AUTHORED ROWS, unlike `bjj_sequences` and
-- `curricula` — deliberately, and unlike either of them. A class plan is
-- one coach's private answer to "what am I teaching tonight"; there is no
-- reference content to publish. `owner_user_id` is therefore `NOT NULL`
-- rather than nullable-meaning-VOLA-authored, which is what lets every read
-- and every write in this module collapse "not yours" and "does not exist"
-- into the identical answer — see classplan.go's comment on the absent
-- ErrForbidden for the consequence that has on the Go side.
CREATE TABLE class_plans (
    -- CLIENT-SUPPLIABLE, unlike curricula and bjj_sequences (server-only) and
    -- matching bjj_sequences' OWN client-id support for offline capture: a
    -- coach jotting a plan down on the mat between classes is exactly the
    -- gym dead-spot that needs a stable id for an offline create's sync
    -- retry to be idempotent.
    id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

    -- NOT NULL. No ownerless row exists in this table at all — see the
    -- comment above. Deliberately NOT a foreign key onto `profiles`: most
    -- per-user tables in this schema (bjj_sequences, curricula, workouts,
    -- activities among them) store the caller's id as plain TEXT rather than
    -- referencing `profiles(user_id)`, because a Clerk-authenticated caller
    -- is not guaranteed to have created a profile row yet, and this table
    -- should not gate class-plan creation on that having happened.
    owner_user_id TEXT        NOT NULL,

    name          TEXT        NOT NULL,
    description   TEXT        NOT NULL DEFAULT '',

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only read path this table has: "my class plans". No public-browse
-- index, because there is no public browse.
CREATE INDEX class_plans_owner_idx ON class_plans (owner_user_id);


-- The blocks, in schedule order.
CREATE TABLE class_plan_blocks (
    id              BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    class_plan_id   TEXT    NOT NULL REFERENCES class_plans (id) ON DELETE CASCADE,

    -- `sort_order`, NOT `position` — 000034's and 000035's warning applies
    -- verbatim: elsewhere in this schema `position` means a grappling
    -- position ("Guard - Bottom"), and a column meaning an ordinal here
    -- would sit in the same statement as one meaning a place there.
    sort_order      INTEGER NOT NULL,

    -- ENUMERATED IN GO, NOT HERE. `classplan.validBlockType` is the source
    -- of truth for the legal set (warmup | technique_drill | live_rounds |
    -- notes) — matching profile.go's ValidActivityLevel/ValidUnitSystem
    -- convention referenced there via migration 000021. Adding a block type
    -- is then a code change, not a migration, and every existing row stays
    -- valid the moment it ships.
    type            TEXT    NOT NULL,

    duration_minutes INTEGER NOT NULL,

    -- ON DELETE CASCADE, matching `bjj_sequence_steps.technique_id`: a block
    -- that cannot say what to drill names nothing, so losing the technique
    -- takes the block with it rather than leaving a dangling reference.
    -- Applies to `technique_drill` blocks only — see the CHECK below, and
    -- classplan.go's ValidateBlocks for the Go-side half of the same rule.
    technique_id    TEXT    REFERENCES techniques (id) ON DELETE CASCADE,

    -- The other half of the technique_drill XOR: free text when the coach's
    -- drill has no catalog entry ("hip escape to underhook, coach's own
    -- variant"). See the CHECK below for why exactly one of these two may be
    -- set, and only for a technique_drill block.
    free_text       TEXT,

    -- "the way our coach runs it", "emphasize grip fighting first" — for a
    -- `notes` block this IS the block's content; for every other type it is
    -- supplementary detail. Mirrors `bjj_sequence_steps.notes`'s role.
    notes           TEXT    NOT NULL DEFAULT '',

    -- Two blocks cannot share a slot in one plan's schedule — the order IS
    -- the content, exactly as `bjj_sequence_steps_unique_slot` argues, and
    -- the replace-all write path makes a duplicate cheap to introduce by
    -- accident without this.
    CONSTRAINT class_plan_blocks_unique_slot UNIQUE (class_plan_id, sort_order),

    -- Defence in depth alongside classplan.ValidateBlocks, not a replacement
    -- for it: the Go validator is what lets an error name a specific field
    -- to the client, this is what stops a bug in the Go layer (or a second,
    -- future caller of this table) from ever writing a block that
    -- contradicts itself. Exactly one of technique_id/free_text when the
    -- block is a technique_drill; neither otherwise.
    CONSTRAINT class_plan_blocks_technique_fields_valid CHECK (
        CASE WHEN type = 'technique_drill'
             THEN (technique_id IS NOT NULL) <> (free_text IS NOT NULL)
             ELSE technique_id IS NULL AND free_text IS NULL
        END
    ),
    CONSTRAINT class_plan_blocks_duration_positive CHECK (
        duration_minutes BETWEEN 1 AND 180
    )
);

-- NO EXPLICIT INDEX on (class_plan_id, sort_order): the UNIQUE constraint
-- above is already backed by a btree over exactly those columns in that
-- order, matching 000035's identical note about `bjj_sequence_steps`. A
-- second CREATE INDEX over the same pair would be pure upkeep cost.
