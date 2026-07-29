-- The exercise catalog: global, operator-authored reference content, shared
-- by every user. Deliberately not user-scoped — unlike profiles/activities
-- there is no owner. User-authored custom exercises are a later decision;
-- when they arrive they get their own nullable owner column rather than a
-- parallel table, so the logger keeps reading from one place.
CREATE TABLE exercises (
    id                TEXT PRIMARY KEY,
    name              TEXT        NOT NULL,
    sport             TEXT        NOT NULL,

    -- What the movement *is*, structurally. This is the column the
    -- cross-sport rules reason over: "heavy hinge/squat yesterday" is what
    -- makes a hard sparring session tomorrow worth flagging. Muscle lists
    -- alone are too granular to write readable rules against.
    movement_pattern  TEXT        NOT NULL,
    primary_muscles   TEXT[]      NOT NULL DEFAULT '{}',
    secondary_muscles TEXT[]      NOT NULL DEFAULT '{}',
    equipment         TEXT[]      NOT NULL DEFAULT '{}',

    -- Which fields the logger should render for this exercise. Carrying it
    -- as data rather than branching in client code is what keeps logging
    -- one screen instead of a form per exercise type — and it means adding
    -- an exercise never requires an app release.
    load_type         TEXT        NOT NULL,

    -- Affects volume maths: 8 reps per side is not 8 reps.
    is_unilateral     BOOLEAN     NOT NULL DEFAULT FALSE,

    instructions      TEXT        NOT NULL DEFAULT '',

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT exercises_load_type_valid CHECK (
        load_type IN ('weight_reps', 'reps', 'time', 'distance', 'distance_time')
    )
);

-- Catalog browsing is filtered by sport far more than anything else.
CREATE INDEX exercises_sport_idx ON exercises (sport);
CREATE INDEX exercises_movement_pattern_idx ON exercises (movement_pattern);
