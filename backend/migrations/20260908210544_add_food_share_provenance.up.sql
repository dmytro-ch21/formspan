-- N532 (#963): a saved food remembers who shared it, and when.
--
-- Accepting a share copies the food into the receiver's own nutrition_foods
-- (share.go's three Copiers) with source='user', which is the honest value
-- for "editable by this athlete" — and it stays that way. But that copy used
-- to carry NOTHING saying it arrived from somebody else: the inbox card knew
-- the sender (shares.from_user_id, joined live to profiles.username), and
-- that knowledge died the moment the share was accepted. "Distinguish shared
-- food items" could not be a filter because there was nothing to filter on.
--
-- Provenance is a SEPARATE fact from source, on purpose. source answers "may
-- this athlete edit these numbers" (user/ai/seed/usda/off); these two answer
-- "where did this row come from". Folding the second into the first would
-- have needed a new source value that every source-reading branch (the AI
-- badge, the editor's provenance guard, the catalog match) would then have to
-- learn about, for a fact none of them care about.
--
-- The sharer's USER ID, not their handle. profiles.username can be renamed
-- (migration 000040), and shares.from_user_id already resolves the handle
-- live for exactly that reason — see share/postgres.go's list query. A stored
-- handle goes stale on the first rename and there is no event to fix it on.
-- No foreign key to profiles: shares carries none either (its doc explains
-- the enumeration and lifecycle reasons), and a deleted sharer must not make
-- the receiver's own saved food undeletable or unreadable — the read
-- COALESCEs a vanished profile to "no handle", never to an error.
--
-- Both NULL (the athlete's own food) or both set (a share) — the CHECK makes
-- a half-written provenance a state the database refuses, so a read never
-- has to decide what "shared, but by nobody" or "by somebody, at no time"
-- would mean.
ALTER TABLE nutrition_foods
    ADD COLUMN shared_by_user_id TEXT,
    ADD COLUMN shared_at TIMESTAMPTZ;

ALTER TABLE nutrition_foods
    ADD CONSTRAINT nutrition_foods_share_provenance_paired
    CHECK ((shared_by_user_id IS NULL) = (shared_at IS NULL));
