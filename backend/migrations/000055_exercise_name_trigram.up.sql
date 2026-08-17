-- Finding an exercise by the words an athlete would use.
--
-- The search was one contiguous `ILIKE '%term%'`. Measured against the three
-- exercises a real athlete reported missing from this 762-row catalog — all
-- three of which were present — it returned NOTHING for every one:
--
--   typed                      catalog
--   "ez bar curls"             "EZ-Bar Curl"
--   "incline dumbbell bench"   "Incline Dumbbell Press"
--   "dumbbell overhead press"  "Seated Dumbbell Shoulder Press"
--
-- The new search matches each typed word independently and ranks by trigram
-- similarity, so the WHERE decides what matches and the ORDER decides what is
-- first.
--
-- **This index serves the WHERE, not the ranking**, and the first version of
-- this comment said the opposite. GIN has no ordered scans — only GiST supports
-- KNN ordering via `<->` — so `ORDER BY similarity(...)` is always computed
-- row-by-row above the scan and sorted. What GIN can do is satisfy
-- `name ILIKE '%' || $1 || '%'` with a bitmap index scan, which is exactly the
-- predicate the new search generates and the one no btree can help with.
--
-- `pg_trgm` itself is NOT created here: migration 000017 installed it for the
-- technique library, and `CREATE EXTENSION` a second time in a different
-- migration is how an extension ends up owned by whichever one is rolled back
-- first. It is a database-wide object; this file only indexes with it.
SET lock_timeout = '3s';

-- **Measured as unused at today's size, and kept anyway.** At 762 rows the
-- planner seq-scans in 0.5 ms; at 7,620 rows it still seq-scans, in 3.9 ms. The
-- index is insurance for a catalog several times larger, bought on a table
-- written only by the seeder and the console — so its cost falls on rare writes
-- and never on the read path it exists for.
--
-- GIN rather than GiST for that future: a read-mostly table wants the slower
-- build and the faster lookup.
--
-- On `name` only. `id` is a slug DERIVED from the name — `incline-dumbbell-press`
-- carries no word the name does not — so a second index would double the write
-- cost of every content edit to serve the same words twice.
--
-- Note two-character tokens (`db`, `kb`, `bb`) contain no complete trigram and
-- can never use this index. That is harmless: they exist to expand into
-- `dumbbell`/`kettlebell`/`barbell`, which are the selective predicates.
CREATE INDEX IF NOT EXISTS exercises_name_trgm_idx
    ON exercises USING gin (name gin_trgm_ops);

COMMENT ON INDEX exercises_name_trgm_idx IS
    'Serves the ILIKE predicates of the catalog search (NOT the similarity '
    'ordering — GIN has no ordered scans). Unused at the current catalog size, '
    'where a seq scan wins; kept as headroom. See '
    'internal/modules/exercise/search.go.';
