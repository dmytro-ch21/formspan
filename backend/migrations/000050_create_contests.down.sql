-- `contest_matches` first: it holds the composite FK into `contests`, and the
-- unique constraint that FK references goes with the table.
DROP TABLE IF EXISTS contest_matches;
DROP TABLE IF EXISTS contests;
