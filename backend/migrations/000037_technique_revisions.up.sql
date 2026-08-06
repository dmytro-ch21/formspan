-- Every console write to a technique, kept.
--
-- Content authored in production reaches athletes with no pull request between
-- the write and the library, so the three things a PR was quietly providing —
-- a record of who changed what, a diff, and a revert — have to exist somewhere
-- else. This is that somewhere.
--
-- SNAPSHOT, NOT DIFF. Each row holds the technique as it looked AFTER the
-- write, as a whole. A diff would be smaller and would make restoring a
-- reconstruction: replay every revision in order and hope none was lost or
-- reordered. At this volume — one author, a handful of edits a week, ~4 KB a
-- row — the storage argument does not exist and the correctness one is
-- decisive. Restoring is then a copy, not a computation.
--
-- JSONB rather than columns mirroring `techniques`. The catalog has gained
-- `function`, `to_position`, `source` and `status` in four months; a typed
-- mirror would have needed a migration each time, and a revision written before
-- a column existed would silently restore its zero value. The payload is
-- whatever the row was, and that stays true whatever the row becomes.
--
-- WRITTEN BY THE CONSOLE ONLY. `cmd/seed` runs on every deploy over 542 rows —
-- recording that would add 542 revisions per release and bury the handful an
-- operator actually made. The deploy's history is the git log; this table is
-- for the writer that does not have one.
CREATE TABLE IF NOT EXISTS technique_revisions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    technique_id TEXT NOT NULL REFERENCES techniques(id) ON DELETE CASCADE,

    -- Monotonic per technique, starting at 1. Not a global sequence: "revision
    -- 3 of this technique" is what an operator reads, and a global id makes
    -- that unanswerable without a window function.
    revision    INTEGER NOT NULL,

    -- The Clerk user id from the request's own claims, never a value a client
    -- sent. This is the audit half; a self-reported actor audits nothing.
    actor       TEXT NOT NULL,

    -- What produced this revision. Deliberately coarse: 'create', 'update',
    -- 'publish', 'restore'. Enough to read the history as a story, not so much
    -- that adding a verb needs a migration.
    action      TEXT NOT NULL
        CONSTRAINT technique_revisions_action_known
        CHECK (action IN ('create', 'update', 'publish', 'restore')),

    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Two writers cannot mint the same revision number. There is one author
    -- today, so this will not fire — which is exactly when it is cheap to add
    -- and exactly when its absence would go unnoticed.
    CONSTRAINT technique_revisions_unique_revision UNIQUE (technique_id, revision)
);

-- The history query is "this technique, newest first", which is the whole
-- access pattern. The UNIQUE above already indexes (technique_id, revision)
-- and serves it, so no second index — revision order and time order agree
-- because revisions are only ever appended.
