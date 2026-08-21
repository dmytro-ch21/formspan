-- The unit an athlete wants FOOD quantities in (N90).
--
-- # Why this is not `unit_system`
--
-- The profile already carries `unit_system` ('metric' | 'imperial', migration
-- 000011), which drives kg/lb and m/mi. Deriving the food unit from it was the
-- obvious move and is wrong for most of the people it would affect:
--
--   **Kitchen scales and US nutrition labels are both in GRAMS.** An American
--   athlete who weighs 180 lb weighs their chicken in grams, because that is
--   what the scale and the packet say. Deriving 'oz' from 'imperial' would hand
--   them a unit they do not use for this one task.
--
-- So it is its own setting. NULL means "no opinion yet, derive it from
-- unit_system" — imperial starts on oz, metric on g — and the moment the athlete
-- touches the toggle their choice is stored here and stops following it.
--
-- Decided by the user 2026-08-20, choosing "own toggle, defaults from
-- unit_system" over "follow unit_system strictly".
--
-- # Nullable rather than DEFAULT 'g'
--
-- A default would erase the difference between "has not chosen" and "chose
-- grams", and those need different behaviour: the first still follows
-- unit_system if the athlete later switches to imperial, the second does not.
-- This is the same absence-versus-zero rule the nutrient columns follow.
--
-- # This changes NOTHING about storage
--
-- Grams are what is stored, always, exactly as kilograms and metres are for
-- training. `nutrition_entries` keeps recording the grams it recorded; ounces
-- are a display and input transform at the edge. lib/units.ts states the rule:
-- "Units are a presentation and input transform, nothing more."

SET lock_timeout = '3s';

ALTER TABLE profiles
    ADD COLUMN food_unit TEXT
        CHECK (food_unit IS NULL OR food_unit IN ('g', 'oz'));

COMMENT ON COLUMN profiles.food_unit IS
    'Display unit for food quantities. NULL = derive from unit_system. '
    'Storage is always grams; this is a presentation and input transform.';
