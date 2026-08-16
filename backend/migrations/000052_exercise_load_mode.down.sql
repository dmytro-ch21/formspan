-- Dropping the column takes the interpretation with it, and every dumbbell
-- set's tonnage silently halves back to the wrong number. That is the safe
-- direction only in the sense that it restores the previous behaviour; nothing
-- stored is lost, because `weight_kg` never changed.
ALTER TABLE exercises DROP COLUMN IF EXISTS load_mode;
