-- F23/#523: retiring a technique from the library was silently voiding every
-- athlete's evidence for it and dropping it from every roadmap, with no error
-- anywhere. See docs/decisions/history.md for the full trace; this migration
-- is the fix.
--
-- THE DECISION (the one sentence the ticket asked for): a technique is never
-- deleted through the normal retirement path — retiring sets a third status,
-- 'retired', so the row survives and every foreign key into it keeps pointing
-- at something real.
--
-- WHY NOT ONE OF THE OTHER TWO CANDIDATES THE TICKET NAMED:
--
--   * RESTRICT-the-delete-and-let-the-operator-resolve-it does not fit this
--     catalog's existing shape. 000036 already solved "hide unfinished
--     content from athletes" with a status column and a one-way Publish
--     verb — retiring is the same shape of decision (visibility), not a
--     removal, and a second mechanism (a delete the operator has to fight)
--     for the same kind of decision is the inconsistency this migration
--     avoids. It would also do nothing for a technique with only
--     bjj_session_tags evidence and no curriculum_items, which is the common
--     case: nothing points at those with NOT NULL, so nothing would refuse
--     the delete, and the silent SET NULL would fire exactly as it does
--     today.
--   * Denormalising evidence to outlive the catalog row is solving a problem
--     retiring does not have to create. The row is not going anywhere, so
--     there is nothing to denormalise against.
--
-- WHAT CHANGES:
--
--   1. techniques.status gains 'retired' alongside 'draft'/'published'.
--      Admin authoring flips it with two new one-way-each verbs, Retire and
--      Reactivate — see technique/content_postgres.go. Retiring never
--      touches bjj_session_tags or curriculum_items, so the CASCADE/SET NULL
--      question below stops being reachable through the normal path at all.
--
--   2. technique_revisions.action gains 'retire' and 'reactivate' so the
--      audit trail can say which of the two happened, matching 'publish'.
--
--   3. THE TWO FOREIGN KEYS STOP DISAGREEING. 000025 put
--      bjj_session_tags.technique_id at ON DELETE SET NULL and 000034 put
--      curriculum_items.technique_id at ON DELETE CASCADE, and each comment
--      defended its own choice in isolation — SET NULL because the athlete's
--      record must survive, CASCADE because a roadmap step naming nothing is
--      worse than one fewer step. Both are right about what they protect and
--      wrong about what deleting a technique should mean, because a real
--      DELETE now means exactly one thing: this technique should never have
--      existed, and nothing legitimate happened against it. Both foreign keys
--      become ON DELETE RESTRICT:
--
--        * If nothing references it — no session tag ever logged it, no
--          curriculum ever listed it — the delete succeeds. That is the
--          "created by mistake, fix the typo before anyone trains it" case,
--          and it is the ONLY case a hard delete now serves.
--        * If anything references it, Postgres refuses the delete outright.
--          There is no silent SET NULL to make an athlete's evidence stop
--          counting and no silent CASCADE to make a roadmap item vanish — the
--          operator gets a foreign-key-violation error and has to retire
--          instead, which is the whole point: a technique with real evidence
--          against it was never "created by mistake", and the two questions
--          ("should this exist" vs "is this still taught") were the wrong
--          ones to conflate under one DELETE in the first place.
--
--      This is a genuine behaviour change for the rare hard-delete path
--      (there is no DELETE /v1/admin/techniques today — this only matters if
--      one is ever added, or for a manual `DELETE FROM techniques` run by an
--      operator against a live database) and it is the point: the two
--      constraints agreeing on RESTRICT is what makes "the two foreign keys
--      stop disagreeing" true rather than aspirational.
--
-- Matching 000025/000034's own lock discipline: a short timeout on a table
-- every write touches, so a lock wait behind a long-running read fails fast
-- instead of queueing behind it and blocking every writer that arrives after.
SET lock_timeout = '3s';

ALTER TABLE techniques
    DROP CONSTRAINT techniques_status_known,
    ADD CONSTRAINT techniques_status_known
        CHECK (status IN ('draft', 'published', 'retired'));

ALTER TABLE technique_revisions
    DROP CONSTRAINT technique_revisions_action_known,
    ADD CONSTRAINT technique_revisions_action_known
        CHECK (action IN ('create', 'update', 'publish', 'restore', 'retire', 'reactivate'));

ALTER TABLE bjj_session_tags
    DROP CONSTRAINT bjj_session_tags_technique_id_fkey,
    ADD CONSTRAINT bjj_session_tags_technique_id_fkey
        FOREIGN KEY (technique_id) REFERENCES techniques (id) ON DELETE RESTRICT;

ALTER TABLE curriculum_items
    DROP CONSTRAINT curriculum_items_technique_id_fkey,
    ADD CONSTRAINT curriculum_items_technique_id_fkey
        FOREIGN KEY (technique_id) REFERENCES techniques (id) ON DELETE RESTRICT;
