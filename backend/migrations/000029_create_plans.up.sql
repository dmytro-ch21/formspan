-- What the athlete INTENDS to train, and on which day.
--
-- The third leg of a distinction the schema already half-drew. `workouts` is
-- the template (what a session looks like), `sessions` is what happened, and
-- until now nothing recorded what was *meant* to happen on a given date. So
-- the phone's home screen could only ever offer a menu of disciplines — it had
-- no notion of "today is Push Day" to lead with.
--
-- That gap also cost the adherence signal the system-design doc calls the most
-- valuable row in the database: prescribed-vs-actual needs a prescription with
-- a date on it. A template has no date, and a session is the actual.
--
-- Deliberately NOT joined to `sessions`. A plan is an intention and is never
-- reconciled: a planned day can be trained twice, ignored, or trained with
-- something else entirely, and all three are ordinary. Auto-consuming a plan
-- when a session lands would need a rule for "does this session count as that
-- plan" that nobody can state — same sport? same template? same day? — and
-- would silently rewrite the athlete's own record of what they meant to do.
-- Adherence is therefore a *query* over both tables, computed when asked,
-- rather than a status column that has to be kept true.
CREATE TABLE plans (
    -- Client-generated, like sessions and activities. This is what makes an
    -- offline plan syncable idempotently: the phone fixes the id before the
    -- server has ever seen the row, so a retried push cannot duplicate it.
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,

    -- A calendar DATE, not a timestamptz, and that is the whole point.
    -- "Tuesday's session" is a claim about the athlete's own calendar; an
    -- instant would slide across a day boundary the moment they fly somewhere,
    -- moving Tuesday's plan onto Monday. `sessions.started_at` is correctly a
    -- timestamptz because it records a moment that actually occurred — this
    -- records a square on a calendar, which is a different kind of thing.
    day        DATE NOT NULL,

    -- The required half. "Tuesday is BJJ" is a complete plan, and the mat
    -- sessions this app is built around have no template at all.
    sport      TEXT NOT NULL,

    -- The optional half. ON DELETE SET NULL rather than CASCADE, matching
    -- `sessions.workout_id` and for the same reason: deleting a template must
    -- not delete the days you had planned around it. The plan degrades to its
    -- discipline, which is still true and still startable.
    workout_id TEXT REFERENCES workouts (id) ON DELETE SET NULL,

    -- Free text for "long run, easy" or "comp class" — the part of an
    -- intention a template cannot hold.
    notes      TEXT NOT NULL DEFAULT '',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- NO CHECK on `sport`, deliberately.
    --
    -- An earlier draft carried `CHECK (sport IN ('strength','running','bjj'))`
    -- with a comment claiming it mirrored `sessions_sport_valid`. That
    -- constraint has not existed since migration 000021, which dropped it and
    -- `workouts_sport_valid` precisely because a CHECK listing the values IS
    -- the migration-per-discipline cost that work existed to remove. A fifth
    -- discipline would pass every Go validator and then fail every INSERT,
    -- surfacing as a misleading 400.
    --
    -- The vocabulary is owned by `internal/platform/discipline` and enforced
    -- at the handler by `discipline.ValidSport`, which is the same decision
    -- 000021 made for sessions and workouts. `registry_sports_test.go` is the
    -- tripwire: it writes a plan for every sport in the registry, so a
    -- discipline the database would reject fails there rather than in
    -- production.
    CONSTRAINT plans_notes_len CHECK (char_length(notes) <= 500)
);

-- NOT unique on (user_id, day). Two-a-days are normal in this sport — lift in
-- the morning, mat in the evening — and a unique constraint would make the
-- second plan silently replace the first.
CREATE INDEX plans_user_day_idx ON plans (user_id, day);

-- "Which days did I plan around this template" — the query that has to run
-- before a template can be deleted or renamed with any confidence.
CREATE INDEX plans_workout_idx ON plans (workout_id) WHERE workout_id IS NOT NULL;
