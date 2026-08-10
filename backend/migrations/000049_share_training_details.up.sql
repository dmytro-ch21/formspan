-- The second, narrower sharing switch: may friends see WHAT was trained, not
-- just that it was.
--
-- `share_training_with_friends` (000046) decides whether an athlete appears in
-- a friend's feed at all. This decides how much of the session travels once
-- they do — the exercise list, or the techniques logged, on top of the numbers.
--
-- **TWO SWITCHES RATHER THAN ONE, deliberately.** The feed's package doc has
-- said since it was written that a row carries no exercises and no technique
-- ids, and that "enlarging it is a privacy decision rather than a feature".
-- This is that decision, made explicitly: the numbers say you trained hard,
-- the detail says what you are working on, and those are different things to
-- hand a training partner. Somebody who competes against their friends may
-- want the first and not the second.
--
-- **OFF BY DEFAULT**, same as 000046 and for the same reason: nobody's
-- programme becomes readable because they installed an update.
--
-- SUBORDINATE, not independent. This column alone shows nothing — the detail
-- is only ever attached to rows the feed's existing visibility rule already
-- returned, so turning it on while the master switch is off is a no-op. That
-- ordering is enforced in the query, not here, because a CHECK constraint
-- would also forbid an athlete from setting up their preference before opting
-- in at all.
SET lock_timeout = '3s';

-- Catalog-only default (PG 11+), so no rewrite of a table every authenticated
-- request reads.
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS share_training_details BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.share_training_details IS
    'Opt-in: do this athlete''s feed rows carry the exercise/technique list as well as the '
    'numbers. Subordinate to share_training_with_friends — it does nothing on its own. Read '
    'live at query time, so turning it off strips the detail from every past row immediately.';

-- No index. Same reasoning as 000046: it is only ever read for the handful of
-- profile rows a friendship query already returned, never scanned by.
