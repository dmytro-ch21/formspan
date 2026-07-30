SET lock_timeout = '3s';

-- The exercises an athlete wants their records shown for.
--
-- A shortlist rather than a per-record-type matrix, because that's the shape
-- of the actual decision: people care about "my big three", not about whether
-- to display heaviest-weight separately from estimated-1RM. Which record
-- *kinds* an exercise shows is already decided by its load type, so choosing
-- the exercise chooses everything that follows.
--
-- Absence means "no explicit choice", and the API falls back to the exercises
-- you've trained most — so the view is useful before anyone configures it and
-- there is no empty state to set up.
CREATE TABLE pinned_exercises (
  user_id     TEXT NOT NULL,
  exercise_id TEXT NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  -- Explicit order: this is a display shortlist, and the athlete's own
  -- ordering is part of the choice.
  position    INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, exercise_id)
);

CREATE INDEX pinned_exercises_user_idx ON pinned_exercises (user_id, position);
