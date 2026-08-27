-- Drops the packet's own serving from the barcode cache.
--
-- Loses only the STARTING-amount suggestion, never data: `serving_label`/
-- `serving_grams` and every macro on the row are untouched, and a fresh scan
-- re-derives the packet serving from Open Food Facts on its next lookup.
ALTER TABLE food_barcode_cache
    DROP COLUMN packet_serving_label,
    DROP COLUMN packet_serving_grams;
