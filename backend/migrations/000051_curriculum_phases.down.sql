-- Concept items cannot survive the NOT NULL restore below, and an item that
-- names no technique means nothing to the schema this returns to.
DELETE FROM curriculum_items WHERE kind = 'concept';

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
