-- LOSSY in the same direction 000036's own down migration warns about: rolling
-- this back cannot un-know that a row was retired or that a hard delete was
-- ever refused. Concretely:
--
--   * Any row currently 'retired' violates the restored two-value CHECK.
--     Publish or draft them first — `SELECT id, name FROM techniques WHERE
--     status = 'retired'` is the list to work through, matching 000036's own
--     down migration's instruction for drafts.
--   * Any 'retire'/'reactivate' revision violates the restored four-value
--     action CHECK. Those rows have to go, which loses that slice of the
--     audit trail permanently — there is no lossless way to represent "this
--     write happened" without the vocabulary that named it.
--   * The foreign keys revert to disagreeing on purpose, restoring the exact
--     defect this migration exists to fix: bjj_session_tags.technique_id back
--     to SET NULL, curriculum_items.technique_id back to CASCADE.
SET lock_timeout = '3s';

ALTER TABLE curriculum_items
    DROP CONSTRAINT curriculum_items_technique_id_fkey,
    ADD CONSTRAINT curriculum_items_technique_id_fkey
        FOREIGN KEY (technique_id) REFERENCES techniques (id) ON DELETE CASCADE;

ALTER TABLE bjj_session_tags
    DROP CONSTRAINT bjj_session_tags_technique_id_fkey,
    ADD CONSTRAINT bjj_session_tags_technique_id_fkey
        FOREIGN KEY (technique_id) REFERENCES techniques (id) ON DELETE SET NULL;

ALTER TABLE technique_revisions
    DROP CONSTRAINT technique_revisions_action_known,
    ADD CONSTRAINT technique_revisions_action_known
        CHECK (action IN ('create', 'update', 'publish', 'restore'));

ALTER TABLE techniques
    DROP CONSTRAINT techniques_status_known,
    ADD CONSTRAINT techniques_status_known
        CHECK (status IN ('draft', 'published'));
