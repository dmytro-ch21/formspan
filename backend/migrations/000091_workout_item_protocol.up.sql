-- N494/#864 (phase 2 of #753): per-workout-item progression protocol.
--
-- One JSONB column rather than exploding progression_strategy, rep range,
-- target sets, target effort, rep-count mode, equipment increment and the
-- per-set prescription list into a dozen scalar columns (plus a child table
-- for the per-set list alone) — the same choice this codebase already made
-- for nutrition_targets.basis (migration 000059). These fields are authored
-- and read together, as one object, and never queried independently of
-- their parent item.
--
-- Nullable: an item with no configured protocol is the common case today
-- and must stay that way — see backend/internal/modules/session's
-- ResolveProtocol, whose "abstain" priority level falls through to the
-- workout-wide, goal-based rep range exactly as it always has for a NULL
-- here.
ALTER TABLE workout_items ADD COLUMN protocol JSONB;

-- Minimal shape guard Postgres itself CAN check: the application layer
-- (workout.ItemProtocol.Validate) owns the real validation — enum values,
-- range ordering, per-set consistency — because none of that is expressible
-- as a CHECK over an opaque JSONB blob. This constraint only rules out the
-- degenerate case of a scalar or array landing in the column instead of an
-- object.
ALTER TABLE workout_items ADD CONSTRAINT workout_items_protocol_is_object
    CHECK (protocol IS NULL OR jsonb_typeof(protocol) = 'object');
