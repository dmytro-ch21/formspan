-- Dropping the column takes every athlete's answer with it. On a re-up they
-- all come back `false`, which is the safe direction and the only one worth
-- defaulting to: a privacy switch that fails open is not a privacy switch.
ALTER TABLE profiles DROP COLUMN IF EXISTS share_training_with_friends;
