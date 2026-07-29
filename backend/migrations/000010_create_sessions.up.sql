-- A performed training session, and the sets that actually happened in it.
--
-- Distinct from `workouts`, which is the *plan*. Keeping them apart is what
-- preserves the gap between prescribed and actual — the adherence signal the
-- system-design doc calls the most valuable row in the database. A session
-- may follow a template (workout_id) or be freeform (NULL).
CREATE TABLE sessions (
    -- Client-generated, so a session can be started offline on a phone and
    -- synced idempotently — the same contract activities use.
    id          TEXT PRIMARY KEY,
    user_id     TEXT        NOT NULL,

    -- The template this followed, if any. ON DELETE SET NULL rather than
    -- CASCADE: deleting a template must never erase the history of sessions
    -- performed against it.
    workout_id  TEXT        REFERENCES workouts (id) ON DELETE SET NULL,
    -- Denormalised from the workout (or chosen directly for a freeform
    -- session) so history survives the template being deleted or edited.
    sport       TEXT        NOT NULL,
    name        TEXT        NOT NULL DEFAULT '',

    -- Client-supplied: the whole point of logging is that it can happen
    -- after the fact. ended_at NULL means still in progress.
    started_at  TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ,

    notes       TEXT        NOT NULL DEFAULT '',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sessions_sport_valid CHECK (sport IN ('strength', 'running', 'bjj')),
    CONSTRAINT sessions_ends_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX sessions_user_started_idx ON sessions (user_id, started_at DESC);
CREATE INDEX sessions_workout_idx ON sessions (workout_id) WHERE workout_id IS NOT NULL;

-- One row per set actually performed.
--
-- Rows rather than an aggregate, because this is the record of what happened
-- and real sets differ: the third is heavier, the last is a drop, one was a
-- warm-up. An aggregate ("3x5 @ 100") can't express any of that, and it's
-- exactly the detail that makes the history worth keeping.
CREATE TABLE session_sets (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id   TEXT        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    exercise_id  TEXT        NOT NULL REFERENCES exercises (id),

    -- Order within the session. Assigned server-side from array order, never
    -- trusted from the client.
    position     INTEGER     NOT NULL,

    -- Warm-ups shouldn't count toward working volume, and a drop set isn't a
    -- straight set. Without this the load maths silently over-counts.
    set_type     TEXT        NOT NULL DEFAULT 'working',

    -- What was done. All nullable because which apply depends on the
    -- exercise's load_type — a plank has no reps, a run has no weight.
    reps         INTEGER,
    weight_kg    NUMERIC(6, 2),
    seconds      INTEGER,
    distance_m   INTEGER,

    -- How hard it was. RIR (reps in reserve) and RPE are two views of the
    -- same quantity — RPE 8 is about 2 RIR — and lifters are fluent in one
    -- or the other, rarely both. Storing both nullable lets someone record
    -- whichever they think in, rather than forcing a conversion at the one
    -- moment they're least able to do arithmetic.
    rir          INTEGER,
    rpe          NUMERIC(3, 1),

    notes        TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT session_sets_position_unique UNIQUE (session_id, position),
    CONSTRAINT session_sets_set_type_valid CHECK (
        set_type IN ('warmup', 'working', 'backoff', 'drop', 'amrap', 'failure')
    ),
    -- RPE is a 10-point scale, conventionally in half steps. RIR is
    -- reps-in-reserve, so 0 is meaningful (nothing left) — hence >= 0 here
    -- where the other measures are > 0.
    CONSTRAINT session_sets_rpe_range CHECK (rpe IS NULL OR (rpe >= 1 AND rpe <= 10)),
    CONSTRAINT session_sets_rir_range CHECK (rir IS NULL OR (rir >= 0 AND rir <= 20)),
    CONSTRAINT session_sets_measures_positive CHECK (
        (reps       IS NULL OR reps       > 0) AND
        (weight_kg  IS NULL OR weight_kg  > 0) AND
        (seconds    IS NULL OR seconds    > 0) AND
        (distance_m IS NULL OR distance_m > 0)
    )
);

CREATE INDEX session_sets_session_idx ON session_sets (session_id);
-- "How has my squat moved over time" is the question this table exists to
-- answer, so the per-exercise history lookup gets its own index.
CREATE INDEX session_sets_exercise_idx ON session_sets (exercise_id);
