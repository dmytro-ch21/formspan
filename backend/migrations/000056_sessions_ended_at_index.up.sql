-- The feed reads a 3-day window over a friend list, and until now it read
-- every friend's LIFETIME of sessions to do it.
--
-- `sessions_user_started_idx (user_id, started_at DESC)` matches the friend
-- list and nothing else, so `ended_at IS NOT NULL AND ended_at >= $2` could
-- only be a post-hoc Filter. Measured on 200k rows / 500 users, 10 friends:
-- 4000 rows fetched, 3919 Rows Removed by Filter, to return 81. That cost
-- grows with how long an athlete has trained, not with how much they did this
-- week — the one thing a "recent activity" query must not do.
--
-- Column order is the query's: `user_id` is the equality (`= ANY`), so it
-- leads; `ended_at DESC` then makes the range a boundary seek AND supplies
-- ORDER BY ended_at DESC in index order.
--
-- PARTIAL on `ended_at IS NOT NULL` because that predicate is in every reader
-- and an in-progress session is never in any of them. It also keeps the index
-- off live sessions, which are the rows being written most often.
--
-- Not CONCURRENTLY: golang-migrate wraps each migration in a transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. The ACCESS SHARE-blocking
-- window is a table with four figures of rows in it today. If sessions is ever
-- large enough for that to matter, this needs to be applied out-of-band.
CREATE INDEX sessions_user_ended_idx
  ON sessions (user_id, ended_at DESC)
  WHERE ended_at IS NOT NULL;
