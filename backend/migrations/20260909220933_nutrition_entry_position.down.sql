DROP INDEX IF EXISTS nutrition_entries_user_day_meal_position_idx;
ALTER TABLE nutrition_entries DROP COLUMN IF EXISTS position;
