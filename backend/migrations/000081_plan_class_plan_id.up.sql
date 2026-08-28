-- Matching 000080 (and 000034/000035 before it), which take the same
-- precaution for a migration that alters a hot, frequently-read table: a
-- lock wait behind a long-running read on `plans` should fail fast rather
-- than queue behind it and block every writer that arrives after.
SET lock_timeout = '3s';

-- N442: a scheduled class is a Plan/calendar entry referencing a class plan,
-- reusing this module rather than inventing a second scheduling concept —
-- see the ticket and the 2026-08-28 history entry.
--
-- A second, MUTUALLY EXCLUSIVE pointer alongside `workout_id`: a plan may
-- reference a strength/running TEMPLATE (`workout_id`) or a BJJ CLASS PLAN
-- (`class_plan_id`), never both. Nothing anywhere knows how to render a
-- calendar row naming two templates at once, so a row that did would be a
-- bug wearing the shape of a feature.
ALTER TABLE plans
    ADD COLUMN class_plan_id TEXT REFERENCES class_plans (id) ON DELETE SET NULL;

-- ON DELETE SET NULL, matching `workout_id`'s own choice two columns up (see
-- 000033) and for the IDENTICAL reason, restated here because this is the
-- ticket's own explicit "decide and state it" question: deleting a class
-- plan must not delete the days scheduled around it. The plan degrades to
-- its discipline — still true, and, if it names no workout either, still
-- startable as a bare "BJJ on Tuesday". Block would turn a coach editing
-- their own class plan into someone else's calendar refusing to update;
-- cascade would delete calendar rows a coach never asked to lose merely for
-- reworking a lesson; orphan-with-notice needs a notification mechanism this
-- schema does not have. SET NULL costs nothing and loses nothing but the
-- pointer, exactly as it already does for workout_id.

-- Mirrors `plans_workout_idx`: "which days did I schedule around this class
-- plan" is the query that has to run with any confidence before a coach
-- reworks or deletes one.
CREATE INDEX plans_class_plan_idx ON plans (class_plan_id) WHERE class_plan_id IS NOT NULL;

-- Enforced here AND in Go (plan.go's NewPlan/PlanUpdate validation in
-- postgres.go, checked against the row's state after an update, not merely
-- against what one PATCH sets) — defence in depth, matching
-- `class_plan_blocks_technique_fields_valid`'s reasoning in 000080: the Go
-- layer is what lets an error name the specific conflict to the caller, this
-- is what stops a bug in the Go layer (or a future caller of this table)
-- from ever writing a row that points at both a strength template and a
-- class plan at once.
--
-- Deliberately NOT the same category as the `sport` CHECK 000033 argues
-- against having. That constraint enumerated an open, growing vocabulary — a
-- fifth discipline would need a migration before it could be planned. This
-- constrains a fixed shape, "at most one of these two specific columns",
-- which does not grow as the discipline registry grows and carries none of
-- that migration-per-discipline cost.
ALTER TABLE plans
    ADD CONSTRAINT plans_one_template_kind CHECK (
        workout_id IS NULL OR class_plan_id IS NULL
    );
