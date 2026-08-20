-- Reverses 000072. The table is written only by the seeder and the console, so
-- dropping it loses no athlete data — a logged entry records the GRAMS it was
-- logged at and never points at a portion row.
SET lock_timeout = '3s';
DROP TABLE food_catalog_portions;
