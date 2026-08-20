-- Drops the label macros from all five tables.
--
-- Loses data with no other copy for anything the athlete typed or a barcode
-- scan cached. The seeded catalog values are recoverable by re-running
-- `cmd/seed`, since they come from the version-controlled `foods.json`.
ALTER TABLE nutrition_entries
    DROP COLUMN saturated_fat_g, DROP COLUMN sugar_g, DROP COLUMN added_sugar_g,
    DROP COLUMN sodium_mg, DROP COLUMN cholesterol_mg;
ALTER TABLE nutrition_recipe_items
    DROP COLUMN saturated_fat_g, DROP COLUMN sugar_g, DROP COLUMN added_sugar_g,
    DROP COLUMN sodium_mg, DROP COLUMN cholesterol_mg;
ALTER TABLE nutrition_foods
    DROP COLUMN saturated_fat_g, DROP COLUMN sugar_g, DROP COLUMN added_sugar_g,
    DROP COLUMN sodium_mg, DROP COLUMN cholesterol_mg;
ALTER TABLE food_barcode_cache
    DROP COLUMN saturated_fat_g, DROP COLUMN sugar_g, DROP COLUMN added_sugar_g,
    DROP COLUMN sodium_mg, DROP COLUMN cholesterol_mg;
ALTER TABLE food_catalog
    DROP COLUMN saturated_fat_g, DROP COLUMN sugar_g, DROP COLUMN added_sugar_g,
    DROP COLUMN sodium_mg, DROP COLUMN cholesterol_mg;
