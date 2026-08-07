-- DDL on a table every workout request reads. House precedent from 000025 and
-- 000034: fail fast rather than queue every reader behind an ACCESS EXCLUSIVE
-- wait that is itself stuck behind one long-running List.
SET lock_timeout = '3s';

-- Which deploy or console wrote an ownerless workout.
--
-- `owner_user_id IS NULL` cannot answer this — a seeded plan and one authored
-- in the admin console are both ownerless — and the seeder needs to tell them
-- apart so a deploy can refresh its own rows without touching anything else.
-- Same column, same job, same reasoning as `curricula.source` (000034).
--
-- **`DEFAULT 'user'`, and here that is not merely conventional — it is the
-- safe direction.** Unlike `curricula`, this table is NOT empty: people have
-- workouts. Defaulting to 'seed' would hand every workout anybody has ever
-- built to the next deploy to overwrite. 000034's comment makes the same
-- argument about a hypothetical later backfill; this is that later backfill,
-- so it takes the advice.
--
-- Catalog-only since PG 11 (a constant default), so no table rewrite.
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';

-- The vocabulary, and the one invariant the seeder's safety rests on.
ALTER TABLE workouts
    ADD CONSTRAINT workouts_source_valid
    CHECK (source IN ('seed', 'admin', 'user'));

-- **An OWNED row can never claim `source='seed'`**, so it can never be picked
-- up by a deploy. Without this that property lives only in the application, and
-- the application is not the only thing that can write here.
--
-- **Deliberately one-directional, unlike `curricula`'s** — which asserts the
-- biconditional `(owner_user_id IS NULL) = (source <> 'user')`. That is wrong
-- for this table and the difference is not stylistic: `Create` does not write
-- `source` at all, so an ownerless row made through the ordinary path lands as
-- `('user', NULL)` — a shape the biconditional rejects. It was tried, and it
-- failed an existing test that inserts exactly that (`TestListCapDoesNot
-- EvictTheCallersOwnWorkouts`, whose fixture is an official template).
--
-- Nothing is lost by narrowing it. `('user', NULL)` is odd but harmless: the
-- seeder skips it, which is the correct and conservative answer. The dangerous
-- direction is the one still forbidden.
ALTER TABLE workouts
    ADD CONSTRAINT workouts_owned_rows_are_never_seeded
    CHECK (NOT (owner_user_id IS NOT NULL AND source = 'seed'));
