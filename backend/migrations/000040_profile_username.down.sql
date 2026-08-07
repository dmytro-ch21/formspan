DROP INDEX IF EXISTS profiles_username_unique;
ALTER TABLE profiles DROP COLUMN IF EXISTS username;
