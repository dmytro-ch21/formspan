-- The trigram index on `name` is finally used (N109).
--
-- Migration 000062 added `food_catalog_name_trgm_idx` and kept it "as
-- headroom" despite being unused at 173 rows. N88's history entry measured
-- WHY it stays unused at 12,651: `SearchClause` emits, per token,
--
--   f.name ILIKE $n OR EXISTS (SELECT 1 FROM unnest(f.aliases) alias
--                               WHERE alias ILIKE $n)
--
-- and the OR against a correlated subquery forces Postgres to Seq Scan the
-- whole table — a GIN bitmap scan cannot be built for one branch of an OR
-- whose other branch is a subplan. Measured on `chicken breast`: Seq Scan,
-- 12,588 rows filtered, 31.6ms (N88) / 14.6ms (re-measured here, same plan,
-- different hardware). With the alias half removed the same predicate plans
-- as a Bitmap Index Scan and runs in 0.97ms / 0.66ms — a ~20-30x gap on the
-- mainline search path.
--
-- The alias branch cannot simply be dropped: `search.go`'s own comments
-- (and the `arm bar` defect in the technique library) are explicit that
-- alias matching, kept SEPARATE from name matching so a term can never
-- straddle two unrelated aliases, is load-bearing — `ahi` -> yellowfin tuna,
-- `garbanzo` -> chickpeas depend on it.
--
-- # The fix: an indexable OVER-APPROXIMATION, ANDed alongside the exact check
--
-- `aliases_text` is `aliases` joined with a space, generated and stored so it
-- can carry a plain trigram GIN index. It is NEVER used as the sole test for
-- a match — SearchClause ANDs it as a *prefilter* next to the original,
-- unmodified `EXISTS (SELECT 1 FROM unnest(...))` check:
--
--   (f.name ILIKE $n OR f.aliases_text ILIKE $n)                    -- prefilter, indexable
--   AND
--   (f.name ILIKE $n OR EXISTS (SELECT 1 FROM unnest(f.aliases) ...)) -- exact, unchanged
--
-- This is a no-op on the RESULT: if some alias element contains the typed
-- substring, the joined string still contains it too (joining only adds
-- characters around it, never inside it), so the exact clause implies the
-- prefilter and `prefilter AND exact` is logically identical to `exact`
-- alone for every row. What changes is that Postgres can now build a Bitmap
-- Index Scan against `aliases_text` (alongside the existing one against
-- `name`) to find CANDIDATES fast, and apply the untouched `EXISTS` clause
-- only as a Recheck/Filter on that narrowed set — instead of evaluating it
-- against all 12,651 rows.
--
-- The exact clause staying in the query, unweakened, is what keeps the
-- alias-boundary guarantee: `aliases_text` joining `{'arm','bar'}` into
-- `'arm bar'` cannot make a query for `armbar` match, because `'arm bar'`
-- (with the space) does not contain the substring `armbar` (without one) —
-- and even where a joined string DOES produce a false-positive CANDIDATE,
-- the `EXISTS` recheck still throws it out before it reaches a result. See
-- `internal/modules/food/search_test.go` and the Postgres integration test
-- for both directions of that claim, checked against real data.
--
-- `array_to_string` is STABLE, not IMMUTABLE (its output can in general
-- depend on the element type's output function), so Postgres refuses a
-- generated column or a GIN expression index built on it directly. `aliases`
-- is TEXT[], where the join really is pure — this wrapper exists only to
-- assert that immutability to the planner.
SET lock_timeout = '3s';

CREATE FUNCTION food_catalog_aliases_text(text[]) RETURNS text AS $$
    SELECT array_to_string($1, ' ')
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

ALTER TABLE food_catalog
    ADD COLUMN aliases_text TEXT GENERATED ALWAYS AS (food_catalog_aliases_text(aliases)) STORED;

CREATE INDEX food_catalog_aliases_text_trgm_idx ON food_catalog USING gin (aliases_text gin_trgm_ops);

COMMENT ON INDEX food_catalog_aliases_text_trgm_idx IS
    'A prefilter only, ANDed alongside the exact unnest()-based EXISTS check '
    'in SearchClause, never in place of it (N109). Joining aliases into one '
    'string here cannot let a term match across an alias boundary in the '
    'final result: the exact check still governs it, this index only narrows '
    'what Postgres has to Recheck. See internal/modules/food/search.go.';
