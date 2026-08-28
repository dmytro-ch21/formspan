-- Blocks first: `class_plan_blocks.class_plan_id` references the parent, and
-- while the FK's ON DELETE CASCADE handles row deletion it does not let the
-- parent TABLE be dropped out from under it.
DROP TABLE IF EXISTS class_plan_blocks;
DROP TABLE IF EXISTS class_plans;
