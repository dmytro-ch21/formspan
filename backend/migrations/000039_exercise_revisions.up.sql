-- Every console write to an exercise, kept. The twin of `technique_revisions`
-- (000037), and every argument there applies here: snapshots rather than
-- diffs so restoring is a copy and not a replay, JSONB rather than a typed
-- mirror so a revision written before a column existed does not silently
-- restore its zero value, and written by the CONSOLE only — `cmd/seed` runs
-- over 504 rows on every release and recording that would bury the handful an
-- operator actually made.
--
-- One thing differs from techniques, and it is why the payload is the CONTENT
-- projection rather than the whole row as a client sees it: an exercise's media
-- lives in `exercise_media`, which the console cannot author and the content
-- write path does not touch. A snapshot including media would promise a
-- restore that puts pictures back, and it would not.
CREATE TABLE IF NOT EXISTS exercise_revisions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,

    -- Monotonic per exercise, from 1. Not a global sequence: "revision 3 of
    -- this exercise" is what an operator reads.
    revision    INTEGER NOT NULL,

    -- The Clerk user id from the request's own claims, never a client-supplied
    -- value. An audit trail the writer can forge records nothing.
    actor       TEXT NOT NULL,

    action      TEXT NOT NULL
        CONSTRAINT exercise_revisions_action_known
        CHECK (action IN ('create', 'update', 'publish', 'restore')),

    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT exercise_revisions_unique_revision UNIQUE (exercise_id, revision)
);
