SET lock_timeout = '3s';

DROP INDEX IF EXISTS shares_sent_idx;

-- Restore the unconditional inbox index 000042 created, so down/up round-trips
-- land exactly where they started.
DROP INDEX IF EXISTS shares_inbox_idx;
CREATE INDEX shares_inbox_idx ON shares (to_user_id, created_at DESC);
