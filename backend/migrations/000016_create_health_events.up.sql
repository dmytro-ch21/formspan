-- Notable operational events, so "is anything wrong?" has an answer that isn't
-- "grep Railway".
--
-- The logs already carry every request, but they go to stdout and are read
-- through Railway's viewer — the admin console cannot query them, and they
-- expire. Anything an operator needs to *look up* has to live in Postgres.
--
-- **Only notable events are recorded, never every request.** A row per request
-- would put a database write on the hot path of every call, and the healthy
-- case — which is almost all of them — is exactly the case with nothing to say.
-- What lands here is: server errors, requests slow enough to be a symptom, and
-- problems the *client* reports that the server would otherwise never learn
-- about. On a healthy system this table stays close to empty, and that emptiness
-- is itself the signal.
CREATE TABLE health_events (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Who noticed. 'api' is the server observing itself; 'client' is an app
    -- reporting something the server has no way to see — a push the device gave
    -- up on, a local write that failed. Kept distinct because their
    -- trustworthiness differs: one is measured, the other is claimed.
    source       TEXT        NOT NULL,
    kind         TEXT        NOT NULL,

    -- Nullable: an unauthenticated failure has no user, and that is a fact
    -- worth keeping rather than a gap to fill in.
    user_id      TEXT,

    -- Request shape. Null for client-reported events, which have no request.
    method       TEXT,
    path         TEXT,
    status       INTEGER,
    duration_ms  INTEGER,

    -- The error *code* from the envelope, which is contract; the message is
    -- not, and is stored only as human context.
    error_code   TEXT        NOT NULL DEFAULT '',
    message      TEXT        NOT NULL DEFAULT '',

    -- The same IDs the structured logs carry, so an admin can pivot from a row
    -- here to the full request in Railway. This is the whole point of storing
    -- them: the table says *that* something went wrong, the logs say what the
    -- request was doing at the time.
    request_id   TEXT        NOT NULL DEFAULT '',
    trace_id     TEXT        NOT NULL DEFAULT '',

    -- Anything shape-specific. Client reports put their entity id and attempt
    -- count here rather than growing a column each time a new kind appears.
    details      JSONB,

    CONSTRAINT health_events_source_valid CHECK (source IN ('api', 'client')),
    CONSTRAINT health_events_kind_valid CHECK (
        kind IN ('server_error', 'slow_request', 'client_error', 'sync_blocked')
    )
);

-- The health screen's default view: most recent first.
CREATE INDEX health_events_occurred_at_idx ON health_events (occurred_at DESC);

-- "Is this particular athlete having trouble?" — the question the user-detail
-- page exists to answer, and the one the logs could never answer at all,
-- because they carry no user id.
CREATE INDEX health_events_user_idx ON health_events (user_id, occurred_at DESC)
    WHERE user_id IS NOT NULL;

-- Filtering the screen to one kind.
CREATE INDEX health_events_kind_idx ON health_events (kind, occurred_at DESC);
