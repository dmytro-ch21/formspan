-- Height, for the measurements that are ratios rather than raw numbers.
--
-- Waist-to-height and the Navy body-fat estimate both need it, and neither can
-- be computed from anything already on the profile. It lives here rather than
-- on a check-in because it is a fact about the athlete that does not change
-- week to week — storing it per check-in would ask for it every time and give
-- every row a chance to disagree.
--
-- Nullable: an athlete who never enters it simply gets the measurements that
-- do not need it, and the derived ones say what is missing rather than
-- guessing a height.
ALTER TABLE profiles ADD COLUMN height_cm NUMERIC(5, 1)
    CHECK (height_cm IS NULL OR (height_cm > 50 AND height_cm < 260));
