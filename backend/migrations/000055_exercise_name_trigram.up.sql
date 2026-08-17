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
-- first. This index serves the ranking.
--
-- `pg_trgm` itself is NOT created here: migration 000017 installed it for the
-- technique library, and `CREATE EXTENSION` a second time in a different
-- migration is how an extension ends up owned by whichever one is rolled back
-- first. It is a database-wide object; this file only indexes with it.
SET lock_timeout = '3s';

-- GIN rather than GIST: this is a read-mostly reference table written only by
-- the seeder and the admin console, so the slower build and larger index buy
-- the faster lookups, which is the trade the catalog wants.
--
-- On `name` only. `id` is a slug DERIVED from the name — `incline-dumbbell-press`
-- carries no word the name does not — so a second index would double the write
-- cost of every content edit to rank the same rows by the same words.
CREATE INDEX IF NOT EXISTS exercises_name_trgm_idx
    ON exercises USING gin (name gin_trgm_ops);

COMMENT ON INDEX exercises_name_trgm_idx IS
    'Serves similarity(name, query) ordering for the catalog search. See '
    'internal/modules/exercise/search.go for why ranking and matching are '
    'separate, and why a synonym list is needed on top of trigrams.';
