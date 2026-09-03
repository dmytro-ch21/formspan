DROP INDEX IF EXISTS running_session_detail_healthkit_uuid_per_user;
ALTER TABLE running_session_detail DROP COLUMN IF EXISTS healthkit_uuid;
