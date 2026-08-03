CREATE INDEX IF NOT EXISTS activities_user_id_idx ON activities (user_id);
DROP INDEX IF EXISTS activities_user_occurred_idx;
