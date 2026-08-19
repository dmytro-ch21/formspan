-- Drops the meter. The daily cap goes with it, leaving only the in-memory rate
-- limiter — which is the state N48 exists to correct, so rolling this back
-- restores an unbounded-per-day spend path.
DROP TABLE exercise_identifications;
