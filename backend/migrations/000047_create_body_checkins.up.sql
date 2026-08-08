-- Body check-ins and the phases they are measured against.
--
-- Two tables because they answer two different questions and change on two
-- different clocks: a check-in is a MEASUREMENT taken on a day, a phase is an
-- INTENT that spans months. Folding the goal onto each check-in would repeat it
-- across every row and leave nowhere to record a goal that has not been
-- measured against yet.

-- A body-composition phase: what the athlete is trying to do, between when and
-- when.
--
-- Modelled as a span rather than a field on the profile so that "making weight
-- by the 20th" is expressible at all, and so past phases survive the next one
-- starting. Both are the point: a rate-vs-target is meaningless without a
-- target date, and a cut you finished in March is the context for the numbers
-- you recorded in March.
CREATE TABLE body_phases (
    id          UUID PRIMARY KEY,
    user_id     TEXT NOT NULL,

    -- 'cut' | 'lean_bulk' | 'recomposition' | 'maintenance' | 'making_weight'.
    -- Text with a CHECK rather than an enum type, matching every other
    -- vocabulary in this schema: adding a kind is a migration either way, and a
    -- CHECK can be relaxed in one statement where an enum needs a type dance.
    kind        TEXT NOT NULL CHECK (kind IN
                    ('cut', 'lean_bulk', 'recomposition', 'maintenance', 'making_weight')),

    started_on  DATE NOT NULL,
    -- When the athlete intends to be done. Required for 'making_weight' (a
    -- division has a date), optional otherwise — enforced in the domain rather
    -- than here, because the message "a weigh-in date is what makes this a
    -- target" is not something a constraint violation can say.
    target_on   DATE,
    -- Nullable: a maintenance phase has no number to hit.
    target_weight_kg NUMERIC(6, 2) CHECK (target_weight_kg IS NULL OR target_weight_kg > 0),

    -- Set when the phase stops. NULL means it is the live one.
    ended_on    DATE,
    notes       TEXT NOT NULL DEFAULT '',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (ended_on IS NULL OR ended_on >= started_on),
    CHECK (target_on IS NULL OR target_on >= started_on)
);

-- At most one live phase per athlete.
--
-- A partial unique index rather than a trigger or an application check: two
-- concurrent "start a phase" requests are exactly the race an application check
-- loses, and the athlete would end up measuring against two targets with no way
-- to tell which the card was using.
CREATE UNIQUE INDEX body_phases_one_live_per_user
    ON body_phases (user_id) WHERE ended_on IS NULL;

CREATE INDEX body_phases_user_started ON body_phases (user_id, started_on DESC);

-- One measurement, on one calendar day.
--
-- **A DATE, not a timestamp, and the primary key includes it.** Body weight is
-- read once a day and compared across days; two rows for one day is not extra
-- data, it is an ambiguity about which one the trend should use. The composite
-- key makes "save today's check-in" an upsert, which is also what makes it
-- idempotent for the offline outbox.
CREATE TABLE body_checkins (
    user_id     TEXT NOT NULL,
    measured_on DATE NOT NULL,

    -- Kilograms, always — the same rule the whole schema follows. Display units
    -- are a client concern; a stored pound would make every historical row
    -- ambiguous the moment somebody changed the setting.
    weight_kg   NUMERIC(6, 2) CHECK (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg < 500)),

    -- Girths, in centimetres. Every one nullable and independently so: the
    -- daily check-in is a weight and nothing else, and a weekly one fills in
    -- whichever sites the athlete actually measures. Requiring the set would
    -- turn a ten-second habit into a five-minute one and end it.
    --
    -- Upper bounds are sanity rails against a mis-keyed decimal (a 700cm waist),
    -- not medical limits.
    neck_cm     NUMERIC(5, 1) CHECK (neck_cm     IS NULL OR (neck_cm     > 0 AND neck_cm     < 100)),
    shoulders_cm NUMERIC(5, 1) CHECK (shoulders_cm IS NULL OR (shoulders_cm > 0 AND shoulders_cm < 250)),
    chest_cm    NUMERIC(5, 1) CHECK (chest_cm    IS NULL OR (chest_cm    > 0 AND chest_cm    < 250)),
    waist_cm    NUMERIC(5, 1) CHECK (waist_cm    IS NULL OR (waist_cm    > 0 AND waist_cm    < 250)),
    hips_cm     NUMERIC(5, 1) CHECK (hips_cm     IS NULL OR (hips_cm     > 0 AND hips_cm     < 250)),
    thigh_cm    NUMERIC(5, 1) CHECK (thigh_cm    IS NULL OR (thigh_cm    > 0 AND thigh_cm    < 150)),
    calf_cm     NUMERIC(5, 1) CHECK (calf_cm     IS NULL OR (calf_cm     > 0 AND calf_cm     < 100)),
    upper_arm_cm NUMERIC(5, 1) CHECK (upper_arm_cm IS NULL OR (upper_arm_cm > 0 AND upper_arm_cm < 100)),
    forearm_cm  NUMERIC(5, 1) CHECK (forearm_cm  IS NULL OR (forearm_cm  > 0 AND forearm_cm  < 100)),

    -- Which side the limb girths were taken on. One value for the row rather
    -- than one per site, because the rule that matters is "be consistent", and
    -- an athlete who measures a left thigh and a right arm has produced two
    -- series that cannot be compared to anything.
    measured_side TEXT NOT NULL DEFAULT 'right' CHECK (measured_side IN ('left', 'right')),

    -- The storage key of the progress photo, or NULL. The key only — the
    -- bucket and its hostname stay out of the database, exactly as the exercise
    -- catalog's media does, so moving either is an env change and not a
    -- migration. Unlike that media this object is PRIVATE: it is read through a
    -- short-lived presigned URL and never through a public origin.
    photo_key   TEXT,

    notes       TEXT NOT NULL DEFAULT '',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, measured_on)
);

-- No second index here on purpose.
--
-- The one query this table serves is a window of one athlete's check-ins,
-- newest first — and the primary key on (user_id, measured_on) already serves
-- it via a backward index scan. A `(user_id, measured_on DESC)` index alongside
-- it buys nothing the planner cannot already do and costs a write on every
-- check-in, on this module's hottest-write table. Raised in review.
