-- Per-exercise unit overrides.
--
-- A lifter who thinks in kilograms still faces a leg press marked in pounds,
-- and forcing the whole app to one system makes them convert in their head
-- at exactly the moment they're trying to record a number. The override is
-- per user *and* per exercise because it's a property of the equipment they
-- happen to train on, not of them.
--
-- Absence means "use the profile default", so there is no third state to
-- reason about and clearing an override is a DELETE.
CREATE TABLE exercise_unit_prefs (
  user_id     TEXT NOT NULL,
  exercise_id TEXT NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  unit_system TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, exercise_id),
  CONSTRAINT exercise_unit_prefs_valid CHECK (unit_system IN ('metric', 'imperial'))
);

CREATE INDEX exercise_unit_prefs_user_idx ON exercise_unit_prefs (user_id);
