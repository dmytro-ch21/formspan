-- Same posture as 000034: this touches a table the API reads on every
-- curriculum request, so a lock wait behind a long-running read should fail
-- fast rather than queue behind it and block every writer that arrives after.
SET lock_timeout = '3s';

-- Curricula grow the structure a real syllabus has.
--
-- The redesign this serves (2026-08-10): a belt curriculum is not a flat list
-- of a dozen techniques. It is PHASES — "survive the bad places first, then
-- stop losing the guard you have" — where most of the material is conceptual
-- (base, frames, positional hierarchy, safety) and only the milestones are
-- measurable techniques. Three additions, none of which move any existing
-- column's meaning:
--
--   1. `curriculum_phases` — named, described sections within one curriculum.
--   2. `curriculum_items.kind` — an item is a TECHNIQUE (a pointer into the
--      library, optionally carrying mastery criteria) or a CONCEPT (authored
--      text: "position before submission", a graduation standard). Concepts
--      NEVER carry criteria — there is no evidence stream that could measure
--      one, and per 000034 nothing here may be completable by hand. They also
--      never count toward progress: the progress rule ("countable = carries
--      criteria") already excludes them with no new rule needed.
--   3. `target_drilled_sessions` — a drilled-spread criterion, for the
--      movement fundamentals a beginner will never SCORE (a breakfall, a
--      shrimp). 000034 rules `drilled` out of every existing criterion because
--      practice must not satisfy a bar about live use; this column is the
--      opposite claim, made explicitly — "you drilled this across N separate
--      classes" — and it is honest for exactly the items where scoring is not
--      the point. Mastery stays fully derived.

-- Which browse section a curriculum belongs to — 'belt', 'foundations', and
-- whatever comes next. Same treatment as `belt` one column up: unconstrained
-- TEXT so a new section is an enum edit rather than a migration, NULLABLE
-- because an athlete's own list belongs to no section — it lives under "mine",
-- and a sentinel would sort among the real sections.
ALTER TABLE curricula ADD COLUMN track TEXT;

CREATE TABLE curriculum_phases (
    curriculum_id TEXT    NOT NULL REFERENCES curricula (id) ON DELETE CASCADE,

    -- `sort_order`, not `position`, for 000034's reason: the mastery query
    -- joins tables where `position` means "Half Guard".
    sort_order    INTEGER NOT NULL,

    title         TEXT    NOT NULL,
    -- Where the phase's objective and performance expectations live — prose,
    -- authored, and the only home the curriculum redesign gives them.
    description   TEXT    NOT NULL DEFAULT '',

    -- Composite PK rather than a surrogate id, like curriculum_enrollments:
    -- phases are replaced wholesale with their curriculum's items, so nothing
    -- ever needs a stable phase identity across writes — and (curriculum_id,
    -- sort_order) is exactly what the items' FK below needs to point at.
    PRIMARY KEY (curriculum_id, sort_order),

    CONSTRAINT curriculum_phases_title_nonempty CHECK (title <> '')
);

-- An item may belong to a phase. Nullable: every existing curriculum is a flat
-- list, and a flat list is still a legal curriculum — NULL means unphased, not
-- broken.
--
-- The composite FK is what stops an item naming a phase that does not exist.
-- ON DELETE CASCADE never fires in practice — every writer replaces items and
-- phases together, items first — but if a phase ever goes alone, an item
-- pointing into a hole is worse than one fewer item, same argument as the
-- technique FK above it.
ALTER TABLE curriculum_items ADD COLUMN phase_order INTEGER;
ALTER TABLE curriculum_items ADD CONSTRAINT curriculum_items_phase_fk
    FOREIGN KEY (curriculum_id, phase_order)
    REFERENCES curriculum_phases (curriculum_id, sort_order) ON DELETE CASCADE;

-- 'technique' or 'concept'. TEXT + CHECK like every enum here.
ALTER TABLE curriculum_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'technique';

-- A concept's heading. Empty on technique items, whose name is the library's —
-- 000034 already refuses to store a name that could disagree with the catalog,
-- and this column does not reopen that: the CHECK below keeps it empty exactly
-- where the library owns the name.
ALTER TABLE curriculum_items ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- Distinct sessions carrying a `drilled` tag for this technique, since
-- enrolling. SESSIONS, not volume: drilling a movement forty times in one
-- class is one class, and spread across weeks is the only thing a drilled
-- criterion can honestly claim. Volume would also invite exactly the
-- "hit three armbars = one row, count 3" arithmetic that makes big numbers
-- cheap to log.
ALTER TABLE curriculum_items ADD COLUMN target_drilled_sessions INTEGER;

-- A concept is authored text and nothing else; a technique is a library
-- pointer and never carries its own title. The criteria ban on concepts is the
-- load-bearing half: every criterion is measured over `bjj_session_tags`
-- rows keyed on a technique_id, and a concept has none — a criterion on one
-- would be a bar no evidence could ever clear OR a completion somebody would
-- eventually be tempted to make hand-markable. 000034 closed that door;
-- this keeps it closed.
ALTER TABLE curriculum_items ADD CONSTRAINT curriculum_items_kind_valid
    CHECK (kind IN ('technique', 'concept'));
ALTER TABLE curriculum_items ADD CONSTRAINT curriculum_items_kind_shape CHECK (
    (kind = 'technique' AND technique_id IS NOT NULL AND title = '')
    OR
    (kind = 'concept' AND technique_id IS NULL AND title <> ''
     AND target_scored IS NULL AND target_defended IS NULL
     AND target_sessions IS NULL AND min_hit_rate IS NULL
     AND target_drilled_sessions IS NULL)
);

-- Only now that the shape CHECK above stands guard for technique rows.
-- Ordered this way on purpose: dropping NOT NULL first would leave a window
-- in which a technique item with no technique was legal.
ALTER TABLE curriculum_items ALTER COLUMN technique_id DROP NOT NULL;

ALTER TABLE curriculum_items DROP CONSTRAINT curriculum_items_targets_positive;
ALTER TABLE curriculum_items ADD CONSTRAINT curriculum_items_targets_positive CHECK (
    (target_scored           IS NULL OR target_scored           > 0) AND
    (target_defended         IS NULL OR target_defended         > 0) AND
    (target_sessions         IS NULL OR target_sessions         > 0) AND
    (target_drilled_sessions IS NULL OR target_drilled_sessions > 0)
);

-- The anchor rule gains a third anchor. A criterion is anchored on volume —
-- offensive, defensive, or drilled spread — or it does not exist.
-- `min_hit_rate` still requires `target_scored` specifically
-- (curriculum_items_hit_rate_needs_volume, unchanged): a rate divides the
-- offensive attempt count, and a drilled-only item has no attempts to divide.
ALTER TABLE curriculum_items DROP CONSTRAINT curriculum_items_criteria_anchored;
ALTER TABLE curriculum_items ADD CONSTRAINT curriculum_items_criteria_anchored CHECK (
    target_scored IS NOT NULL
    OR target_defended IS NOT NULL
    OR target_drilled_sessions IS NOT NULL
    OR (target_sessions IS NULL AND min_hit_rate IS NULL)
);
