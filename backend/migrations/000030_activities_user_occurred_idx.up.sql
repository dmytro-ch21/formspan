-- The per-user activity list is `WHERE user_id = $1 ORDER BY occurred_at DESC,
-- id DESC LIMIT 500`. `activities_user_id_idx` covers only the WHERE, so
-- Postgres fetched every row the user had and sorted them — the LIMIT bounded
-- the response, not the work.
--
-- Every column of the ORDER BY is in this index, in the same direction, so the
-- plan becomes an index scan that stops at 500. The trailing `id` is what
-- makes the order TOTAL: `occurred_at` is client-supplied (mobile writes it
-- from local SQLite), so ties are realistic, and an index on
-- (user_id, occurred_at DESC) alone returns tied rows in physical order —
-- which a plain UPDATE changes. Measured: with that index, rewriting one row
-- of a tied pair flipped which of the two survived the cap. That is both a
-- correctness bug (a row the caller can never see) and an ETag bug (the array
-- reorders, the hash changes, and the endpoint is a permanent cache miss).
CREATE INDEX IF NOT EXISTS activities_user_occurred_idx
    ON activities (user_id, occurred_at DESC, id DESC);

DROP INDEX IF EXISTS activities_user_id_idx;
