-- N124/N113: the meal-section glyph (N58/#375) is derived from CATEGORY, and
-- until now only food_catalog rows carry one — a logged entry has never had
-- it. This COPIES the category onto the entry at log time, the exact rule
-- 000059's own package comment states for every macro on this table: "a
-- logged row owns its numbers." Correcting a catalog row's category next
-- month must not silently repaint a meal already logged from it — the same
-- reasoning nutrition_recipe_items already applies to a recipe's components.
--
-- Nullable, and deliberately so. Most entries today have no category source
-- at all: an athlete's own saved food (`nutrition_foods` has no category
-- column), an AI draft, or a barcode scan. Null is the honest answer for all
-- three — `glyphFor(null)` on the client already degrades to the neutral
-- plate glyph for precisely this reason (see foodGlyph.ts's own doc comment:
-- "a wrong glyph is worse than no glyph"). Closing that gap for saved foods
-- and AI drafts is follow-on work, not something this migration should force
-- by inventing a category nobody stated.
ALTER TABLE nutrition_entries ADD COLUMN category TEXT
    CHECK (category IS NULL OR length(btrim(category)) BETWEEN 1 AND 40);
