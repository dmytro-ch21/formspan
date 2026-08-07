ALTER TABLE workouts DROP CONSTRAINT IF EXISTS workouts_owned_rows_are_never_seeded;
ALTER TABLE workouts DROP CONSTRAINT IF EXISTS workouts_source_valid;
ALTER TABLE workouts DROP COLUMN IF EXISTS source;
