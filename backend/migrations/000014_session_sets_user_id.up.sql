-- Denormalise the owner onto session_sets.
--
-- Every set already belongs to a user, transitively, through its session. The
-- problem is that "transitively" can't be indexed: the personal-best lookup
-- filters on `sessions.user_id` and `session_sets.exercise_id`, which live in
-- different tables, so Postgres must either scan every user's sets for that
-- exercise or walk the caller's entire training history. Both get worse with
-- every session logged, on a query that runs whenever someone starts a
-- workout.
--
-- With the owner on the row, `(user_id, exercise_id, weight_kg DESC)` seeks
-- straight to one athlete's sets of one exercise, heaviest first — which is
-- exactly the order BestOneRMs wants.
ALTER TABLE session_sets ADD COLUMN user_id TEXT;

UPDATE session_sets ss
SET user_id = s.user_id
FROM sessions s
WHERE s.id = ss.session_id;

ALTER TABLE session_sets ALTER COLUMN user_id SET NOT NULL;

-- weight_kg DESC last so the index also answers "heaviest sets of X for this
-- athlete" without a sort. The 1RM search's own bound is a comparison against
-- the per-exercise maximum, which this makes cheap to find.
CREATE INDEX session_sets_user_exercise_idx
    ON session_sets (user_id, exercise_id, weight_kg DESC);
