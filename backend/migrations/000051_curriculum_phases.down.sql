-- Concept items cannot survive the NOT NULL restore below, and an item that
-- names no technique means nothing to the schema this returns to.
DELETE FROM curriculum_items WHERE kind = 'concept';

-- A drilled-anchored item may legally carry target_sessions under this
-- migration's constraint, but the OLD criteria_anchored being restored below
-- has no drilled disjunct — re-adding it would abort validating that row and
-- kill the rollback mid-file. Strip the now-unanchored sessions target first.
-- (min_hit_rate cannot occur here: hit_rate_needs_volume pins it to
-- target_scored, which this WHERE excludes.)
--
-- Drilled-only rows themselves survive and, after the DROP COLUMN below,
-- silently become criteria-less reading items. Deliberate: a down migration's
-- job is a schema the old binary can run, not a lossless inverse.
UPDATE curriculum_items SET target_sessions = NULL
WHERE target_scored IS NULL AND target_defended IS NULL
  AND target_sessions IS NOT NULL;

ALTER TABLE curriculum_items DROP CONSTRAINT curriculum_items_criteria_anchored;
ALTER TABLE curriculum_items ADD CONSTRAINT curriculum_items_criteria_anchored CHECK (
    target_scored IS NOT NULL
    OR target_defended IS NOT NULL
    OR (target_sessions IS NULL AND min_hit_rate IS NULL)
);

ALTER TABLE curriculum_items DROP CONSTRAINT curriculum_items_targets_positive;
ALTER TABLE curriculum_items ADD CONSTRAINT curriculum_items_targets_positive CHECK (
    (target_scored   IS NULL OR target_scored   > 0) AND
    (target_defended IS NULL OR target_defended > 0) AND
    (target_sessions IS NULL OR target_sessions > 0)
);

ALTER TABLE curriculum_items ALTER COLUMN technique_id SET NOT NULL;
ALTER TABLE curriculum_items DROP CONSTRAINT curriculum_items_kind_shape;
ALTER TABLE curriculum_items DROP CONSTRAINT curriculum_items_kind_valid;
ALTER TABLE curriculum_items DROP COLUMN target_drilled_sessions;
ALTER TABLE curriculum_items DROP COLUMN title;
ALTER TABLE curriculum_items DROP COLUMN kind;
ALTER TABLE curriculum_items DROP CONSTRAINT curriculum_items_phase_fk;
ALTER TABLE curriculum_items DROP COLUMN phase_order;

DROP TABLE IF EXISTS curriculum_phases;

ALTER TABLE curricula DROP COLUMN track;
