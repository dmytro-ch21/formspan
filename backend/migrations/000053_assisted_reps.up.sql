-- How many of those reps somebody else helped with.
--
-- "225 for 5, then 3 more with a spotter" is one continuous set at one weight,
-- and the app had no way to say it. Logged as 8 reps it overstates what the
-- athlete did alone; logged as 5 it throws away three real reps and the volume
-- that came with them.
--
-- **The number worth training against is `reps - assisted_reps`.** "Next time
-- 6 or 7 myself" is a target the progression rule can read directly, and it is
-- the reason this is a column rather than a note: prose cannot be compared to
-- last week.
--
-- # Why not a second row
--
-- The obvious alternative is two sets — 5 solo, 3 assisted — and it is wrong in
-- a way that matters. They are ONE set: one approach to the bar, one rest
-- period, one entry in `working_sets`. Splitting them counts the set twice
-- everywhere sets are counted, and this codebase has one definition of a
-- working set that everything agrees on. Widening a row is cheaper than
-- teaching six call sites that two rows are sometimes one.
--
-- # And why drop sets are NOT a column
--
-- A drop set — 225 for 3, strip to 185, 8 more — is genuinely two efforts at
-- two weights, so it is already two rows: a `working` set and a `drop` set,
-- each with its own `weight_kg` and `reps`. Nothing was missing from the
-- schema; what was missing is that nothing recorded WHICH set a drop came off.
--
-- That relationship is expressed by ADJACENCY — a `drop` row belongs to the
-- nearest preceding non-drop row of the same exercise — and deliberately not by
-- a foreign key. `ReplaceSets` deletes every row of a session and reinserts
-- them on each save, so `session_sets.id` is regenerated constantly and a
-- self-referencing `parent_set_id` would dangle on the first edit. A stable
-- group key would survive, but it is a second ordering concept for clients to
-- keep consistent alongside `position`, which is already a total order enforced
-- by `UNIQUE (session_id, position)`. Adjacency needs neither.
SET lock_timeout = '3s';

-- Catalog-only default (PG 11+): no table rewrite, and `session_sets` is the
-- largest table in the app.
ALTER TABLE session_sets
    ADD COLUMN IF NOT EXISTS assisted_reps INTEGER;

COMMENT ON COLUMN session_sets.assisted_reps IS
    'How many of `reps` were completed with help (a spotter, a band, an assisted-pull-up '
    'machine). NULL means unrecorded, which is not the same as zero: nobody should be asked '
    'to type 0 on every set. Always <= reps. `reps - assisted_reps` is the number worth '
    'progressing against.';

-- NULL is unrecorded and 0 is "none of them" — both legal, and different.
-- What is not legal is help on more reps than were performed, or on a set with
-- no reps at all.
ALTER TABLE session_sets
    ADD CONSTRAINT session_sets_assisted_within_reps
    CHECK (assisted_reps IS NULL OR (assisted_reps >= 0 AND reps IS NOT NULL AND assisted_reps <= reps));

-- No index. It is read with the set row it sits on, never scanned by — the same
-- reasoning as every other measure on this table.
