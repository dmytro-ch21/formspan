-- How the bar was held.
--
-- "Incline dumbbell press, neutral grip" and "incline dumbbell press" are the
-- same movement trained slightly differently, and the app had no way to say
-- which. An athlete pressing neutral because their shoulder is cranky, then
-- switching back six weeks later, has a real change in their training that no
-- number recorded.
--
-- # Why on the SET and not on the exercise
--
-- The obvious alternative is a catalog row per grip — "Dumbbell Bench Press
-- (Neutral)" beside "Dumbbell Bench Press" — and it is wrong twice over.
--
-- It multiplies the catalog: 504 exercises become something near 2,000, every
-- one of them needing muscles, equipment, instructions and media that differ
-- from its sibling in one word. And having paid that, it STILL cannot say the
-- thing an athlete actually does, which is switch grip on the last set because
-- the first three hurt. Grip is a property of how a set was performed, exactly
-- like the weight and the reps, so it lives with them.
--
-- It also keeps history honest. Two catalog rows split one exercise's history
-- in two — the progression rule, the 1RM estimate and the personal records all
-- stop seeing the sets that used the other grip, so an athlete who alternates
-- has two half-histories and no PRs. One row with a per-set grip keeps a single
-- history and makes the grip a filter over it rather than a fork in it.
--
-- # NULL is unrecorded, and that is not 'regular'
--
-- No default, deliberately. Every set ever logged predates this column, and a
-- default would have all of them assert a grip nobody chose — which is worse
-- than silence, because a future "you press better neutral" claim would be
-- computed over fabricated data. NULL means nobody said.
--
-- # The vocabulary, and what is missing from it
--
-- Four values, which are the four an athlete names for a press, a pull or a
-- curl: overhand, palms-facing, underhand, and the canted position an EZ-bar
-- or a multi-grip handle forces.
--
-- **`mixed` and `hook` are absent on purpose.** They are how a heavy deadlift
-- is actually held, and they are not variations of the four — a mixed grip is
-- one hand each way. Adding them without designing for them would let a
-- deadlifter record "regular" for a mixed pull, which is a false entry rather
-- than a missing one. So the picker does not appear on hinges, carries or
-- olympic lifts yet, and this enum stays honest about what it can express.
SET lock_timeout = '3s';

-- Nullable with no default, so this is catalog-only: no table rewrite, and
-- `session_sets` is the largest table in the app.
ALTER TABLE session_sets
    ADD COLUMN IF NOT EXISTS grip TEXT;

COMMENT ON COLUMN session_sets.grip IS
    'How the implement was held for this set: regular (overhand/pronated), neutral '
    '(palms facing), reverse (underhand/supinated), angled (an EZ-bar or multi-grip '
    'handle). NULL means unrecorded, which is NOT the same as regular — no set logged '
    'before this column existed chose a grip, and reading silence as overhand would '
    'invent training data. mixed and hook are deliberately absent; see the migration.';

-- Same shape as `session_sets_set_type_valid` in 000010: a CHECK rather than an
-- enum type, so adding a value later is a migration and not a type rewrite.
-- NULL passes, which is the point.
ALTER TABLE session_sets
    ADD CONSTRAINT session_sets_grip_valid
    CHECK (grip IS NULL OR grip IN ('regular', 'neutral', 'reverse', 'angled'));

-- No index. It is read with the set row it sits on and never scanned by — the
-- same reasoning as every other measure on this table.
