-- A promotion photo, stored the same way body_checkins.photo_key is.
--
-- Nullable, like every other free-text field on this table: an undated
-- promotion already establishes rank on its own (see bjj.go's Promotion doc),
-- and a promotion with no photo is exactly as valid a record. The key only —
-- never a URL. The bucket and its hostname stay out of the database, and the
-- object is read back through a short-lived presigned URL minted per response,
-- exactly as body_checkins' photo_key already is.
ALTER TABLE bjj_promotions ADD COLUMN photo_key TEXT;
