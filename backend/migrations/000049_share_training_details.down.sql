-- Dropping the column takes every athlete's answer with it, and on a re-up
-- they all come back `false`. That is the safe direction and the only one
-- worth defaulting to — a privacy switch that fails open is not a switch.
ALTER TABLE profiles DROP COLUMN IF EXISTS share_training_details;
