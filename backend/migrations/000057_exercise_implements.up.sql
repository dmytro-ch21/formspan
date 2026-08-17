-- How many implements of the entered weight actually moved.
--
-- # The bug this fixes is in the RULE, not in the rows
--
-- Tonnage was computed as:
--
--     CASE WHEN load_mode = 'per_side' AND NOT is_unilateral THEN 2 ELSE 1
--
-- which reads `is_unilateral` — "one LIMB at a time" — as though it meant "one
-- IMPLEMENT moves". For most movements those coincide. For a dumbbell walking
-- lunge they do not: you hold TWO dumbbells and work ONE leg.
--
-- The model could not say that, so whoever classified the lunge family had to
-- choose which error to ship:
--
--   is_unilateral = true   correct reps hint ("8 each side"), tonnage HALVED
--   is_unilateral = false  correct tonnage, reps hint claims both legs at once
--
-- The dumbbell rows chose the first and the kettlebell rows chose the second,
-- which is why `dumbbell-walking-lunge` counted x1 while `kettlebell-walking-lunge`
-- counted x2 — the same movement, opposite answers, five such pairs. Neither
-- side was careless. Both were forced.
--
-- # Three facts, three columns
--
--   load_mode      which number to type      -> the "per hand" input hint
--   implements     how many of it moved      -> the tonnage factor  (THIS)
--   is_unilateral  how many limbs work       -> the "8 each side" reps hint
--
-- Independent, so none of them has to lie for another to be right. It also
-- SIMPLIFIES the tonnage rule, which becomes `weight_kg * implements` with no
-- CASE at all: the factor is now a stored fact rather than a derivation over
-- two flags that mean other things.
SET lock_timeout = '3s';

-- 1 is right for the overwhelming majority — a barbell, a machine, one
-- kettlebell in two hands, a one-arm row — so the default costs no rewrite.
ALTER TABLE exercises
    ADD COLUMN IF NOT EXISTS implements SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE exercises
    ADD CONSTRAINT exercises_implements_known
    CHECK (implements IN (1, 2));

COMMENT ON COLUMN exercises.implements IS
    'How many implements of `weight_kg` move in one rep: 1 for a barbell, a machine, or '
    'a single dumbbell; 2 for a PAIR. Multiplies logged weight to give tonnage. NOT the '
    'same question as is_unilateral (how many limbs work) — a dumbbell walking lunge is '
    'two implements and one leg, which is the case the old derived rule could not express.';

-- 2. Reproduce exactly what the old rule computed, so nothing moves yet.
UPDATE exercises
   SET implements = 2
 WHERE load_mode = 'per_side' AND NOT is_unilateral;

-- 3. NOW correct the lunge family, which is the only place the old rule was
--    forced into a wrong answer.
--
--    Every per-side lunge, split squat and step-up is held with two implements:
--    one in each hand. The single-implement variants of these movements —
--    goblet, offset, suitcase — are `load_mode = 'total'` and so are not
--    matched here at all, which is what makes this safe as a pattern match
--    rather than a list of ids.
--
--    Measured against the shipped catalog: 16 rows match, of which 8 change
--    (7 dumbbell + kettlebell-bulgarian-split-squat). The other 8 already
--    counted double via `NOT is_unilateral` and keep their factor while
--    getting their reps hint back.
UPDATE exercises
   SET implements = 2
 WHERE load_mode = 'per_side'
   AND (id LIKE '%lunge%' OR id LIKE '%split-squat%' OR id LIKE '%step-up%');

-- 4. And restore `is_unilateral` to meaning what it says. These are one-leg
--    movements; the flag was being switched off purely to buy a doubling that
--    now comes from `implements`, which cost the athlete the "8 reps here means
--    8 each side" hint on exactly the movements that need it most.
UPDATE exercises
   SET is_unilateral = true
 WHERE load_mode = 'per_side'
   AND (id LIKE '%lunge%' OR id LIKE '%split-squat%' OR id LIKE '%step-up%');
