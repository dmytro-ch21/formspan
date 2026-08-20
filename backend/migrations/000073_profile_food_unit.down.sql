-- Reverses 000073. Athletes who had chosen a food unit fall back to deriving it
-- from unit_system, which is the pre-N90 behaviour.
SET lock_timeout = '3s';
ALTER TABLE profiles DROP COLUMN food_unit;
