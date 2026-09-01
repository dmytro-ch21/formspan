-- Matching every migration that touches curriculum_items: this is read on
-- every curriculum request, so a lock wait behind a long-running read should
-- fail fast rather than queue behind it and block every writer that arrives
-- after.
SET lock_timeout = '3s';

-- N123: "read and understood" — an athlete's own claim about a CONCEPT item,
-- and the third thing this feature area has, next to the two 000034 and 000051
-- already protect.
--
--   * A TECHNIQUE's progress is DERIVED from bjj_session_tags. 000034 is
--     explicit that there is deliberately no way to mark one mastered by hand,
--     not in any struct, not in the schema, not on any endpoint.
--   * A CONCEPT carries no criteria and therefore no progress at all. 000051
--     is explicit that this is by design: "position before submission" has no
--     evidence stream that could measure it.
--
-- Before this migration a concept therefore had NO STATE WHATSOEVER — you
-- could not even record that you had read it. Purple and brown belts are
-- majority concept (brown carries 48 of them), so those roadmaps were largely
-- items that could never move in any sense, including the harmless one of
-- "I looked at this."
--
-- THIS TABLE DOES NOT REOPEN EITHER GUARD. It does not let a technique be
-- marked complete by hand — curriculum_item_reads_concept_only_trg below
-- refuses any row whose item is not kind = 'concept', enforced at the
-- database level so an application bug or a future endpoint cannot bypass it
-- by skipping a Go-side check. And it carries no completion semantics for a
-- concept either: "read and understood" is the athlete's own attestation, not
-- a derived claim, and Item.Read() in curriculum.go is a separate method from
-- Item.Mastered() precisely so the two are never rendered through one field,
-- one endpoint, or one UI control. Whether read concepts count toward a
-- belt's percentage is a client decision made in the open — see
-- Curriculum.ReadConcepts's doc comment — and the answer chosen is "shown
-- separately, never blended into countable_items/mastered_items".
CREATE TABLE curriculum_item_reads (
    user_id            TEXT        NOT NULL,

    -- The stable identity curriculum_items already has
    -- (`id BIGINT GENERATED ALWAYS AS IDENTITY`, from 000034) — the natural
    -- foreign key. A composite key on (curriculum_id, item sort_order) would
    -- reinvent an identity that already exists, and sort_order is not even
    -- stable: replaceContent reassigns it from array position on every write
    -- to a curriculum's content.
    --
    -- ON DELETE CASCADE, unlike curriculum_enrollments' RESTRICT on
    -- curriculum_id. The two are not the same relationship: an enrollment is
    -- the athlete's record that they took a roadmap on, worth protecting from
    -- a stranger's delete: a read-mark is the athlete's record about ONE
    -- ITEM's content, and once that item is gone (the curriculum was edited to
    -- remove it, or deleted outright) there is nothing left for the mark to be
    -- about. This matches bjj_focus_sources' own reasoning for cascading off
    -- curriculum_id: a dangling reference is worse than a claim quietly
    -- ending with what it was about.
    curriculum_item_id BIGINT      NOT NULL REFERENCES curriculum_items (id) ON DELETE CASCADE,

    read_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One mark per athlete per item — marking it again just moves read_at,
    -- which is what MarkItemRead's ON CONFLICT DO UPDATE relies on.
    PRIMARY KEY (user_id, curriculum_item_id)
);

-- THE DATABASE-LEVEL GUARANTEE, not just an application check.
--
-- A CHECK constraint cannot express "look at another table", so this is a
-- trigger — the idiom this repo does not otherwise use for a shape guard
-- (curriculum_items_kind_shape is a plain CHECK because everything it needs is
-- on the same row), but the same DECLARATIVE INTENT: a technique item's
-- progress stays derived, full stop, and that has to hold no matter which
-- endpoint or which future caller writes this table.
--
-- ERRCODE 23514 (check_violation) on purpose, not the trigger's default
-- P0001 (raise_exception): curriculum.translate() already maps 23514 to
-- ErrInvalidInput for the shape-guard family (curriculum_items_kind_shape and
-- friends), so this reuses that mapping rather than adding a new one, and a
-- caller who tries to mark a technique read gets the same class of answer
-- ("invalid input") that every other shape violation in this module gives.
CREATE OR REPLACE FUNCTION curriculum_item_reads_concept_only() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM curriculum_items
        WHERE id = NEW.curriculum_item_id AND kind = 'concept'
    ) THEN
        RAISE EXCEPTION
            'curriculum_item_reads: item % is not a concept item — a technique''s progress stays derived',
            NEW.curriculum_item_id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE INSERT OR UPDATE: UPDATE is included even though nothing here ever
-- changes curriculum_item_id on an existing row (the PK includes it, so that
-- would be a different row) — cheap insurance against a future writer that
-- does, rather than a guard that only holds for today's one caller.
CREATE TRIGGER curriculum_item_reads_concept_only_trg
    BEFORE INSERT OR UPDATE ON curriculum_item_reads
    FOR EACH ROW EXECUTE FUNCTION curriculum_item_reads_concept_only();

-- Postgres does not index the referencing side of a foreign key on its own;
-- without this, the CASCADE above seq-scans curriculum_item_reads on every
-- curriculum_items delete. The primary key already covers "this athlete's
-- reads", so this is the complementary direction: "who has read this item",
-- which the CASCADE needs and which no other index here serves.
CREATE INDEX curriculum_item_reads_item_idx ON curriculum_item_reads (curriculum_item_id);
