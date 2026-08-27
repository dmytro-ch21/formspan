-- The packet's own serving, alongside the unchanged per-100g cache (N117).
--
-- Reported from a device: scanning a Kinder bar showed "Per 100 g", 560 kcal,
-- with a bare "Servings" field defaulting to 1 — matching the box (140 kcal
-- for its own stated "2 Pieces (25g)") required computing 25/100 by hand
-- first. Open Food Facts' response carries the packet's own serving
-- (`serving_size: "2 pieces (25 g)"`, `serving_quantity: 25`,
-- `serving_quantity_unit: "g"`) and this table never asked for it.
--
-- ADDITIVE, deliberately, alongside `serving_label`/`serving_grams` rather
-- than replacing them: those two columns mean "the amount kcal/protein_g/etc.
-- on this row represent" everywhere they are read, and that stays "100 g" —
-- redefining them to the packet's own serving while the macros stayed
-- per-100g would be the exact two-serving-bases mixup
-- `backend/internal/modules/food/barcode.go`'s own history already warns
-- against, just moved from the Go layer into the database. A client uses
-- these two only to pick a better STARTING amount than "100 g"; every amount,
-- including that one, is still computed as `perHundredG * (grams/100)`.
--
-- Nullable, no default: most products on Open Food Facts state no serving at
-- all, and a fabricated one would corrupt the one figure a client cannot
-- verify against the packet itself the way it can a kcal number. See
-- `packetServingFrom` in `barcode.go` for the three ways this stays null
-- rather than guess (no quantity, a non-gram unit like a can's "ml", or a
-- gram figure with no label behind it).
ALTER TABLE food_barcode_cache
    ADD COLUMN packet_serving_label TEXT CHECK (packet_serving_label IS NULL OR length(packet_serving_label) BETWEEN 1 AND 40),
    ADD COLUMN packet_serving_grams NUMERIC(9, 2) CHECK (packet_serving_grams IS NULL OR packet_serving_grams > 0);
