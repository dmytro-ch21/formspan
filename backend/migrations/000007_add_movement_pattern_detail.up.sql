-- The authored catalog carries 75 distinct movement patterns (Elbow Flexion,
-- Scapular Elevation, Plantar Flexion...). That granularity is right for
-- browsing and wrong for rules: "heavy hinge work yesterday" would have to
-- enumerate a dozen of them.
--
-- So there are two levels. `movement_pattern` stays the coarse, closed
-- vocabulary the cross-sport rules reason over; this column preserves the
-- source's own value for display and filtering. Same split as keeping
-- primary_muscles for display while rules read movement_pattern.
ALTER TABLE exercises ADD COLUMN movement_pattern_detail TEXT NOT NULL DEFAULT '';
