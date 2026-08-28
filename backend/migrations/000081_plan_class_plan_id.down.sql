ALTER TABLE plans DROP CONSTRAINT plans_one_template_kind;
DROP INDEX plans_class_plan_idx;
ALTER TABLE plans DROP COLUMN class_plan_id;
