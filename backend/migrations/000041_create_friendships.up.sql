SET lock_timeout = '3s';

-- One row per PAIR of athletes, whatever direction the request travelled.
--
-- The pair is stored canonically — user_a is always the lexically smaller id —
-- so (A,B) and (B,A) are the same row by construction and a duplicate or
-- crossing request is a primary-key conflict, not an application-level check
-- someone has to remember. `requested_by` preserves the direction the
-- canonical form erases: it is what splits an inbox from an outbox, and what
-- stops a sender accepting their own request.
--
-- `status` is a CLOSED two-value set, so it gets a CHECK — matching
-- curricula's visibility rather than the 000021 grow-in-Go convention, which
-- is for vocabularies that are expected to grow. There is no third state on
-- purpose: DECLINE IS DELETE. A stored 'declined' row would either block
-- re-requests forever or force the API to lie about it; deleting keeps the
-- model honest at the cost of re-request spam, which is recorded as a
-- moderation residual rather than solved with a lie.
--
-- No foreign keys to profiles: the repo has no users table anywhere (Clerk is
-- the identity authority, per every other module), and a profiles row is
-- created lazily on first save so it cannot be a referential anchor.
CREATE TABLE friendships (
    user_a       TEXT NOT NULL,
    user_b       TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- When the pending request became a friendship; null while pending.
    accepted_at  TIMESTAMPTZ,

    PRIMARY KEY (user_a, user_b),
    CONSTRAINT friendships_canonical_order CHECK (user_a < user_b),
    CONSTRAINT friendships_requester_in_pair CHECK (requested_by IN (user_a, user_b)),
    CONSTRAINT friendships_status_valid CHECK (status IN ('pending', 'accepted'))
);

-- Every read is "rows involving ME". The primary key serves user_a lookups;
-- this serves the user_b half of the same question.
CREATE INDEX friendships_user_b_idx ON friendships (user_b);
