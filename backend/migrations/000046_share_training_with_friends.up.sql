-- The first time one athlete's training becomes readable by another.
--
-- Until now every read of `sessions` was `WHERE user_id = $1` without
-- exception — the sharing module moves COPIES on an explicit send-and-accept
-- precisely so it never has to answer "who may see this". A friends' feed is
-- the first thing that does, so the answer is a column rather than a rule
-- someone has to remember.
--
-- **OFF BY DEFAULT, and that is the whole point.** Nobody's training may
-- become visible because they installed an update. `DEFAULT false` means every
-- existing profile and every new one starts private, and the only way out is
-- an athlete tapping a switch.
SET lock_timeout = '3s';

-- Catalog-only since PG 11 (a constant default), so no table rewrite on a
-- table every authenticated request reads.
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS share_training_with_friends BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.share_training_with_friends IS
    'Opt-in: may accepted friends see this athlete''s FINISHED sessions in their feed. '
    'Read live at query time rather than stamped onto each session, so turning it off '
    'retracts everything immediately — which is the property a privacy switch has to have. '
    'The consequence is that turning it ON is retroactive, and the setting copy says so.';

-- The feed's access path.
--
-- It reads finished sessions belonging to a SET of user ids (the caller's
-- accepted friends), newest first. `sessions_user_started_idx (user_id,
-- started_at DESC)` already serves that for a single user, and Postgres can
-- use it per-id under a `= ANY(...)`, so no new index on `sessions` is needed.
--
-- What IS needed is the reverse lookup on friendships: "everyone who is an
-- accepted friend of $1". The primary key covers `user_a`, and
-- `friendships_user_b_idx` (000041) covers `user_b`. Both halves are already
-- indexed, so the friend-id query is served too.
--
-- Deliberately NO index on `share_training_with_friends`. It is a boolean that
-- starts overwhelmingly false, and the feed never scans profiles by it — it is
-- only ever checked for the handful of ids a friendship query already returned.
