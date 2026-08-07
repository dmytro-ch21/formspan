SET lock_timeout = '3s';

-- The sender's side gets its index now that something reads it.
--
-- 000042 deliberately shipped WITHOUT this: no query used from_user_id
-- (cancelling is a primary-key lookup) and there was no sent list, so it would
-- have been write amplification for a feature that did not exist — this repo
-- dropped exactly such an index once before, in 000018. The rule was "it
-- arrives with the sent list, not in anticipation of it." The sent list has
-- arrived.
--
-- PARTIAL on status = 'pending', because that is the only status either
-- direction ever lists: an accepted share is history, and the sent list
-- deliberately does not show it (see the module docs — showing accepted would
-- make a VANISHED row mean "declined", which is the one thing decline-is-delete
-- exists to avoid saying).
CREATE INDEX shares_sent_idx
    ON shares (from_user_id, created_at DESC)
    WHERE status = 'pending';

-- And the inbox index narrowed to match, for the same reason. Safe to rebuild
-- rather than leave inconsistent: `shares` shipped hours ago and holds no rows
-- in any environment, so this costs nothing today and costs a table scan's
-- worth of lock if it is deferred until it does.
DROP INDEX IF EXISTS shares_inbox_idx;
CREATE INDEX shares_inbox_idx
    ON shares (to_user_id, created_at DESC)
    WHERE status = 'pending';
