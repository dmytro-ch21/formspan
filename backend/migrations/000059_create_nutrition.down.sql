-- Reverse dependency order: recipe items reference foods, and entries reference
-- foods, so foods cannot go first. nutrition_targets stands alone.
DROP TABLE IF EXISTS nutrition_entries;
DROP TABLE IF EXISTS nutrition_recipe_items;
DROP TABLE IF EXISTS nutrition_foods;
DROP TABLE IF EXISTS nutrition_targets;
