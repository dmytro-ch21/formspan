-- N12: a real uploaded avatar per account.
--
-- A BOOLEAN, not a stored key. Unlike a check-in photo (one per DATE, keyed
-- on the date) an avatar is one per ACCOUNT, always re-encoded to JPEG
-- server-side on the way in — so its object key is fully deterministic from
-- the user id alone (`avatars/<user_id>.jpg`, derived in Go, never stored).
-- The only fact this column needs to hold is whether that object exists.
ALTER TABLE profiles ADD COLUMN has_avatar BOOLEAN NOT NULL DEFAULT false;
