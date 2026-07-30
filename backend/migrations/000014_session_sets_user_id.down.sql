ALTER TABLE session_sets DROP CONSTRAINT IF EXISTS session_sets_session_owner_fk;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_id_user_unique;
DROP INDEX IF EXISTS session_sets_user_exercise_idx;
ALTER TABLE session_sets DROP COLUMN IF EXISTS user_id;
