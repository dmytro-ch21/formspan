-- Drops the authored noun. Every athlete-typed word ("capsule", "serving",
-- "scoop") is lost and the client falls back to deriving one from the unit,
-- which is the behaviour this column exists to end. Stated rather than silent:
-- rolling this back is not free, it costs the copy on every custom tracker.

SET lock_timeout = '3s';

ALTER TABLE daily_trackers DROP COLUMN count_noun;
