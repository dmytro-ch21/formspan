-- N513/#901: an immutable decision-record audit trail for the progression
-- engine (Progress/ProgressV2, backend/internal/modules/session/). One row
-- per exercise, per call to GET /v1/sessions/suggestions that returns a
-- suggestion — including an abstained/no-history/effort-conflict one, since
-- "why didn't I get a suggestion" is exactly the question this audit trail
-- exists to answer after the fact. See docs/decisions/history.md's N513
-- entry for the full design reasoning (why this lives in the session module,
-- the write-path latency call, the immutability model, and what was
-- deliberately deferred).
CREATE TABLE session_progression_decisions (
    -- Server-generated and server-only: nothing about this row is ever
    -- authored offline, so there is no client-id-for-idempotent-sync need
    -- the way `sessions.id` has. A plain identity column, same pattern as
    -- `session_sets.id`.
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    user_id     TEXT        NOT NULL,
    exercise_id TEXT        NOT NULL REFERENCES exercises (id),
    -- The workout template this suggestion was requested against, if any —
    -- same nullable/ON DELETE SET NULL semantics as sessions.workout_id:
    -- deleting a template must not erase the audit trail of suggestions
    -- served against it. NULL for a freeform/exercise-detail suggestion
    -- request (see handler.go's Suggestions — workout_id is optional and
    -- unvalidated there too).
    workout_id  TEXT        REFERENCES workouts (id) ON DELETE SET NULL,

    -- Which engine produced this decision, and which revision of its logic.
    -- `engine` names the code path (never changes meaning); `ruleset_version`
    -- is a hand-bumped marker of the DECISION LOGIC itself — see
    -- decisionRulesetVersion's own doc comment in decisionrecord.go for when
    -- to bump it.
    engine          TEXT NOT NULL,
    ruleset_version TEXT NOT NULL,

    -- N494/#864's four-level protocol resolution, already collapsed to a
    -- single winning source by ResolveProtocol — see protocol.go. NULL
    -- throughout for v1 (progress_v1 never resolves a Protocol at all, per
    -- progression.go's own standing rule that v1 must not read it).
    protocol_source                  TEXT,
    protocol_rep_range_low           INTEGER,
    protocol_rep_range_high          INTEGER,
    protocol_target_sets             INTEGER,
    protocol_target_rir              NUMERIC(4, 1),
    protocol_equipment_increment_kg  NUMERIC(6, 2),
    protocol_strategy                TEXT,

    -- Which past session the engine actually reasoned from (Progress/
    -- ProgressV2's own `last`), and a best-effort summary of which of ITS
    -- sets were included in the cohort vs excluded and why — e.g.
    -- {"set_type:backoff": 1, "missing_weight_or_reps": 1}. NOT a full
    -- per-set ledger and not a multi-session walk: see the history entry for
    -- why (warm-ups are already filtered out before this package ever sees
    -- them, and a prior session skipped for being non-normal is folded into
    -- `warnings` below rather than counted here).
    evidence_session_id   TEXT REFERENCES sessions (id) ON DELETE SET NULL,
    included_set_count    INTEGER     NOT NULL DEFAULT 0,
    excluded_set_summary  JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- The normalized effort reading the engine actually used — the top set's
    -- own RIR/RPE (Plan.LastRIR/LastRPE), and whether every set in the
    -- cohort carried one, none did, or only some did (session.effortCoverage
    -- reused verbatim for both engines).
    effort_coverage    TEXT,
    effort_reading_rir INTEGER,
    effort_reading_rpe NUMERIC(3, 1),

    -- The suggestion itself: Plan.Code/Reason/TargetWeightKg/TargetReps,
    -- verbatim. `warnings` folds in every non-numeric-outcome signal the
    -- ticket names (effort_conflict, abstain, ...) plus the in-session
    -- divergence signal and the skipped-light-session flag, as a JSON array
    -- of short machine strings — never Reason, which is prose.
    output_code             TEXT        NOT NULL,
    output_reason           TEXT        NOT NULL DEFAULT '',
    output_target_weight_kg NUMERIC(6, 2),
    output_target_reps      INTEGER,
    warnings                JSONB       NOT NULL DEFAULT '[]'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The one thing allowed to change after the row is written — see the
    -- immutability trigger below, which enforces that every column ABOVE
    -- this one is write-once. 'pending' means a numeric target was given and
    -- nothing has resolved it yet; 'not_applicable' means there was no
    -- numeric target to act on in the first place (abstain/no_history/
    -- effort_conflict/not_applicable), so outcome tracking never applies.
    outcome_status      TEXT        NOT NULL DEFAULT 'not_applicable',
    outcome_weight_kg    NUMERIC(6, 2),
    outcome_reps         INTEGER,
    outcome_session_id   TEXT REFERENCES sessions (id) ON DELETE SET NULL,
    outcome_recorded_at  TIMESTAMPTZ,

    CONSTRAINT session_progression_decisions_engine_valid CHECK (
        engine IN ('progress_v1', 'progress_v2')
    ),
    CONSTRAINT session_progression_decisions_protocol_source_valid CHECK (
        protocol_source IS NULL OR
        protocol_source IN ('program', 'athlete_config', 'profile_default', 'abstain')
    ),
    CONSTRAINT session_progression_decisions_effort_coverage_valid CHECK (
        effort_coverage IS NULL OR effort_coverage IN ('all', 'none', 'partial')
    ),
    CONSTRAINT session_progression_decisions_outcome_status_valid CHECK (
        outcome_status IN ('pending', 'applied', 'edited', 'dismissed', 'not_applicable')
    )
);

-- The correlation lookup ResolveDecisionOutcomes/DismissPendingDecisions run
-- on every set save and session finish: "the latest still-pending decision
-- for this athlete/exercise/workout". Partial on outcome_status so a
-- long-lived athlete's resolved history never grows this index.
CREATE INDEX session_progression_decisions_pending_idx
    ON session_progression_decisions (user_id, exercise_id, workout_id, created_at DESC)
    WHERE outcome_status = 'pending';

-- Finish()'s sweep: every still-pending row for one workout run.
CREATE INDEX session_progression_decisions_workout_idx
    ON session_progression_decisions (workout_id)
    WHERE workout_id IS NOT NULL;

-- General per-athlete lookup for future tooling (N515's shadow-replay tool,
-- analytics) — there is no read endpoint in this ticket's own scope (see the
-- history entry), but the row is useless to anything later without a way to
-- page through one athlete's decisions in order.
CREATE INDEX session_progression_decisions_user_created_idx
    ON session_progression_decisions (user_id, created_at DESC);

-- Immutability, enforced rather than merely documented — the same standing
-- this repo gives `workouts_owned_rows_are_never_seeded` (migration 000043)
-- rather than a comment asking nicely. Every column is write-once EXCEPT the
-- five outcome_* columns (the one mutation this ticket's own acceptance
-- criteria requires — "never mutated after the fact except to record
-- apply/edit/dismiss and subsequent performance") and TWO columns this
-- trigger deliberately does not watch at all: `workout_id` and
-- `evidence_session_id`. Both carry ON DELETE SET NULL (a deleted workout or
-- session must not erase the audit trail pointing at it — the same
-- "history outlives the plan it came from" reasoning sessions.workout_id's
-- own doc comment gives), and that SET NULL is itself an UPDATE this trigger
-- would otherwise fire on and reject — a decision record would then block
-- the very deletion it is supposed to survive. This is not a gap in the
-- guarantee: nothing outside that one FK-driven transition ever touches
-- these two columns (RecordDecisions only INSERTs; no code path anywhere
-- runs a bare UPDATE naming them), so the property the trigger exists to
-- protect — the athlete-facing content of the decision can't be quietly
-- rewritten — is unaffected. Caught by
-- TestSessionProgressionDecisions_CoreFieldsAreImmutable's own fixture
-- cleanup, which deletes the evidence session it created and would have
-- failed here otherwise.
CREATE FUNCTION session_progression_decisions_immutable_core() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.exercise_id IS DISTINCT FROM OLD.exercise_id
        OR NEW.engine IS DISTINCT FROM OLD.engine
        OR NEW.ruleset_version IS DISTINCT FROM OLD.ruleset_version
        OR NEW.protocol_source IS DISTINCT FROM OLD.protocol_source
        OR NEW.protocol_rep_range_low IS DISTINCT FROM OLD.protocol_rep_range_low
        OR NEW.protocol_rep_range_high IS DISTINCT FROM OLD.protocol_rep_range_high
        OR NEW.protocol_target_sets IS DISTINCT FROM OLD.protocol_target_sets
        OR NEW.protocol_target_rir IS DISTINCT FROM OLD.protocol_target_rir
        OR NEW.protocol_equipment_increment_kg IS DISTINCT FROM OLD.protocol_equipment_increment_kg
        OR NEW.protocol_strategy IS DISTINCT FROM OLD.protocol_strategy
        OR NEW.included_set_count IS DISTINCT FROM OLD.included_set_count
        OR NEW.excluded_set_summary IS DISTINCT FROM OLD.excluded_set_summary
        OR NEW.effort_coverage IS DISTINCT FROM OLD.effort_coverage
        OR NEW.effort_reading_rir IS DISTINCT FROM OLD.effort_reading_rir
        OR NEW.effort_reading_rpe IS DISTINCT FROM OLD.effort_reading_rpe
        OR NEW.output_code IS DISTINCT FROM OLD.output_code
        OR NEW.output_reason IS DISTINCT FROM OLD.output_reason
        OR NEW.output_target_weight_kg IS DISTINCT FROM OLD.output_target_weight_kg
        OR NEW.output_target_reps IS DISTINCT FROM OLD.output_target_reps
        OR NEW.warnings IS DISTINCT FROM OLD.warnings
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION
            'session_progression_decisions: core decision fields are immutable once written (id=%)',
            OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_progression_decisions_immutable_core_trg
    BEFORE UPDATE ON session_progression_decisions
    FOR EACH ROW EXECUTE FUNCTION session_progression_decisions_immutable_core();
