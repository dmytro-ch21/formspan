DROP INDEX IF EXISTS session_sets_user_exercise_idx;
ALTER TABLE session_sets DROP COLUMN IF EXISTS user_id;
