-- Workouts are *templates* ("Push Day A": bench 5x5, overhead press 3x8),
-- deliberately distinct from a logged session (what you actually did on
-- Tuesday). Conflating the two is the classic mistake: you lose the ability
-- to say "I did 3 sets, not the 5 the plan called for" — which is exactly
-- the adherence signal worth the most later.
CREATE TABLE workouts (
    -- Client-generated, like activities, so a workout can be created offline
    -- and synced idempotently.
    id             TEXT PRIMARY KEY,

    -- NULL means a VOLA-authored official template rather than a user's own.
    -- Nullable owner + visibility covers both sharing cases (official
    -- templates, and a user publishing their own) without an ACL table,
    -- which would be premature.
    owner_user_id  TEXT,

    name           TEXT        NOT NULL,

    -- One discipline per workout — mixing is deliberately not supported.
    -- 'strength' | 'running' | 'bjj'.
    sport          TEXT        NOT NULL,

    -- The training style, which is NOT a sport: powerlifting, hypertrophy
    -- and endurance are all things you do with the same barbell squat, so
    -- they can't live on the exercise. Only meaningful for strength, hence
    -- nullable.
    goal           TEXT,

    notes          TEXT        NOT NULL DEFAULT '',
    visibility     TEXT        NOT NULL DEFAULT 'private',

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT workouts_sport_valid CHECK (sport IN ('strength', 'running', 'bjj')),
    CONSTRAINT workouts_goal_valid CHECK (
        goal IS NULL OR goal IN ('general', 'powerlifting', 'hypertrophy', 'endurance')
    ),
    CONSTRAINT workouts_visibility_valid CHECK (visibility IN ('private', 'public')),
    -- An official template nobody can see would be pointless, and a private
    -- ownerless row would be unreachable by anyone at all.
    CONSTRAINT workouts_official_is_public CHECK (
        owner_user_id IS NOT NULL OR visibility = 'public'
    )
);

CREATE INDEX workouts_owner_idx ON workouts (owner_user_id);
-- Browsing shared workouts filters on visibility then sport.
CREATE INDEX workouts_public_idx ON workouts (visibility, sport) WHERE visibility = 'public';

-- The ordered contents of a workout.
CREATE TABLE workout_items (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workout_id        TEXT    NOT NULL REFERENCES workouts (id) ON DELETE CASCADE,

    -- Strength and running workouts draw from the exercise catalog. BJJ
    -- draws from its own technique library, which doesn't exist yet — when
    -- it does, this gains a nullable technique_id alongside, with a CHECK
    -- that exactly one is set. Additive, so nothing here needs redoing.
    exercise_id       TEXT    NOT NULL REFERENCES exercises (id),

    position          INTEGER NOT NULL,

    -- Targets. All nullable because which ones apply is determined by the
    -- exercise's own load_type — a plank has no reps and a run has no
    -- weight. Same principle as load_type driving the logging inputs:
    -- the catalog decides the shape, the template just fills it in.
    target_sets       INTEGER,
    target_reps       INTEGER,
    target_weight_kg  NUMERIC(6, 2),
    target_seconds    INTEGER,
    target_distance_m INTEGER,

    notes             TEXT    NOT NULL DEFAULT '',

    CONSTRAINT workout_items_position_unique UNIQUE (workout_id, position),
    CONSTRAINT workout_items_targets_positive CHECK (
        (target_sets       IS NULL OR target_sets       > 0) AND
        (target_reps       IS NULL OR target_reps       > 0) AND
        (target_weight_kg  IS NULL OR target_weight_kg  > 0) AND
        (target_seconds    IS NULL OR target_seconds    > 0) AND
        (target_distance_m IS NULL OR target_distance_m > 0)
    )
);

CREATE INDEX workout_items_workout_idx ON workout_items (workout_id);
