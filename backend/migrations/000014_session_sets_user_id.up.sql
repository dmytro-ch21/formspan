-- A migration that queues behind an in-flight query blocks every reader
-- behind it too. Fail fast instead of stalling the table.
SET lock_timeout = '3s';

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

-- Make the denormalisation impossible to break, rather than merely unlikely.
--
-- Deriving user_id inside the INSERT guarantees *consistency* — the value can
-- only come from the session it belongs to. It does not guarantee
-- *authorization*: a future caller that skipped the ownership check would
-- write perfectly-derived rows into someone else's session, and those rows
-- would then pollute that athlete's personal bests.
--
-- A composite foreign key closes both. The pair has to exist on `sessions`,
-- so a set can never name a session/owner combination that isn't real, and
-- ON UPDATE CASCADE means a user_id rewrite (a Clerk migration, an account
-- merge) carries down instead of silently desyncing every set.
ALTER TABLE sessions
    ADD CONSTRAINT sessions_id_user_unique UNIQUE (id, user_id);

ALTER TABLE session_sets
    ADD CONSTRAINT session_sets_session_owner_fk
    FOREIGN KEY (session_id, user_id) REFERENCES sessions (id, user_id)
    ON DELETE CASCADE ON UPDATE CASCADE;
