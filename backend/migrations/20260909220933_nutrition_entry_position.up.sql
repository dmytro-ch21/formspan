-- N553/#1019 — where an entry sits INSIDE its meal.
--
-- Until now a meal was listed by `created_at, id` and nothing else, so
-- "put the eggs above the toast" had nowhere to be written and a within-meal
-- drag would have snapped back on the next pull. N531's own doc comment says
-- exactly that, and declined to ship the gesture rather than ship one that
-- forgets. This column is the half that was missing.
--
-- ## Why GAPPED integers rather than a dense 0,1,2,…
--
-- A dense rank has to renumber every row after the one that moved: one write
-- per entry per drag, and — this is the part that matters offline — one sync
-- conflict per entry, on rows the athlete did not touch. With a gap between
-- neighbours, a move writes the MOVED ROW ONLY: its new position is the
-- midpoint of the two rows it landed between. Reordering N rows costs one
-- write, not N.
--
-- The step is 1024 (`positionStep` in nutrition.go — keep the two in step).
-- 1024 is 10 halvings of headroom at one spot before two neighbours become
-- adjacent, at which point the client renumbers that ONE meal on that ONE day
-- back onto the grid and pushes those rows. That rebalance is the only write
-- that touches more than one row, and it is bounded by a single meal.
--
-- ## BIGINT, and it may go negative
--
-- Dragging to the top of a meal is `min - 1024`, which is how "first" stays a
-- one-row write instead of a renumber. A meal dragged-to-top a thousand times
-- is at -1024000; BIGINT does not care, and the clients keep every value well
-- inside 2^53 so JSON stays exact.
--
-- ## The backfill is the whole point of the DEFAULT being temporary
--
-- Existing rows are seeded from the order they are ALREADY displayed in
-- (`created_at, id` — `ListEntries`'s own key, and the phone's `logged_at, id`
-- resolves to the same sequence), so the first load after this migration looks
-- exactly like the last load before it. Nobody's breakfast reshuffles.
ALTER TABLE nutrition_entries ADD COLUMN position BIGINT NOT NULL DEFAULT 0;

UPDATE nutrition_entries e
SET position = s.rn * 1024
FROM (
    SELECT id,
           row_number() OVER (
               PARTITION BY user_id, eaten_on, meal
               ORDER BY created_at, id
           ) AS rn
    FROM nutrition_entries
) s
WHERE e.id = s.id;

-- Two reads want this: `ListEntries` sorts a day by it, and every INSERT asks
-- for `max(position)` within one (user, day, meal) so a new entry appends to
-- the end of its meal instead of landing in the middle.
CREATE INDEX nutrition_entries_user_day_meal_position_idx
    ON nutrition_entries (user_id, eaten_on, meal, position);
