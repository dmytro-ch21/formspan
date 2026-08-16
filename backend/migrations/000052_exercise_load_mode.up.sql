-- What the number on a set MEANS.
--
-- `session_sets.weight_kg` has always been a bare number with no statement of
-- whether it describes the load in one hand or the load altogether. For a
-- barbell those are the same thing, which is why it went unnoticed. For a pair
-- of dumbbells they differ by a factor of two, and the athlete types what is
-- stamped on the dumbbell — 30 — while the app has been reading it as the whole
-- set's load.
--
-- Everything downstream inherits the error: session tonnage, the week's volume,
-- the share card and the friends' feed, the estimated 1RM, and the progression
-- suggestion that decides what to load next time. None of them were wrong
-- ABOUT the data; they were wrong about what the data meant.
--
-- # Why this lives on the exercise
--
-- It is a property of the movement, not of the day. A dumbbell press is
-- per-hand every time anybody performs it, so recording it per set would be
-- asking the athlete a question whose answer never changes, and would leave
-- every historical row unanswerable.
--
-- # The backfill CHANGES HISTORICAL NUMBERS, deliberately
--
-- Marking the dumbbell and kettlebell catalog `per_side` doubles the computed
-- tonnage of every dumbbell set ever logged. That is a correction, not a
-- rewrite: the athlete lifted two dumbbells and the app was counting one. It is
-- called out here because a volume chart that silently steps up on the day of a
-- deploy looks like a bug, and somebody should be able to find this comment.
--
-- No stored number moves. `weight_kg` still holds exactly what was typed; only
-- the interpretation is now recorded alongside it.
SET lock_timeout = '3s';

-- Catalog-only default (PG 11+), so no rewrite of a table every session read
-- joins against.
ALTER TABLE exercises
    ADD COLUMN IF NOT EXISTS load_mode TEXT NOT NULL DEFAULT 'total'
        CONSTRAINT exercises_load_mode_known CHECK (load_mode IN ('total', 'per_side'));

COMMENT ON COLUMN exercises.load_mode IS
    'How to read session_sets.weight_kg for this exercise. ''total'' — the number is the whole '
    'load: a barbell, a machine, OR a single implement held in two hands (a goblet squat, a '
    'two-handed swing). ''per_side'' — it is one implement''s weight and the athlete moves one '
    'per limb. Total load is then weight x limbs, where limbs comes from is_unilateral: two for '
    'a pair of dumbbells, one for a single-arm row. A property of the movement, never of a set.';

-- The backfill, by equipment, because equipment is what determines it.
--
-- Deliberately NOT keyed on `is_unilateral`: those are different questions. A
-- dumbbell bench press is bilateral AND per-hand; a single-arm cable row is
-- unilateral AND total. Conflating them is the obvious shortcut and it is wrong
-- in both directions. `is_unilateral` earns its keep afterwards, deciding
-- whether a per_side number is doubled or not — but it cannot decide THIS.
--
-- **Equipment alone over-classifies, and the exclusion list below is why.**
-- Roughly a fifth of what the dumbbell/kettlebell filter catches is a SINGLE
-- implement held in two hands — a goblet squat, a two-handed swing, a pullover,
-- a Turkish get-up. Those are `total`: the number already is the whole load, and
-- doubling them would invent weight the athlete never moved. Measured on the
-- real 504-row catalog rather than guessed at.
UPDATE exercises
SET load_mode = 'per_side'
WHERE load_mode = 'total'
  AND (
        'dumbbells' = ANY (equipment)
     OR 'kettlebell' = ANY (equipment)
     OR 'farmer-handles' = ANY (equipment)
  )
  -- A machine or barbell in the same list wins: "Dumbbell Bench Press on a
  -- Smith Machine" is not a thing, but a row carrying both is a data error, and
  -- the safe reading is the one that does not double somebody's numbers.
  AND NOT (
        'barbell' = ANY (equipment)
     OR 'smith-machine' = ANY (equipment)
     OR 'cable-stack' = ANY (equipment)
     OR 'selectorized' = ANY (equipment)
     OR 'plate-loaded-machine' = ANY (equipment)
  )
  -- Single implement, two hands. Matched on name because nothing in the schema
  -- records how many implements a movement uses, and adding a column for the
  -- ~20 rows it would describe is worse than a list somebody can read.
  --
  -- NOTE, because an earlier draft of this comment claimed otherwise: the admin
  -- console cannot yet correct a row's load_mode. `createWithin` does not write
  -- the column (so console-authored exercises are always 'total') and no
  -- endpoint updates it. Correcting a misclassification today means editing
  -- exercises.json and deploying. That is a real gap and it is recorded in the
  -- history entry rather than papered over here.
  AND name !~* '(goblet|halo|pullover|get-up|getup|windmill|around the world)'
  -- A swing, snatch, clean or high pull is one bell unless it says "double".
  AND NOT (
        name ~* '(swing|snatch|high pull)'
    AND name !~* 'double'
  )
  AND NOT (
        name ~* '(kettlebell (clean|deadlift|sumo deadlift))'
    AND name !~* 'double'
  );

-- No index. It is read only for exercises a session already named, never
-- scanned by, exactly like the sharing flags on `profiles`.
