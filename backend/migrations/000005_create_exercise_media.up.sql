-- Media for catalog entries. A separate table rather than columns on
-- `exercises` because one exercise has several assets (a start position, an
-- end position, later a demo clip), and because that set grows without a
-- schema change.
--
-- Only the storage *key* lives here — never the bytes, and never a full URL.
-- Bytes in Postgres would bloat every backup and WAL segment and couldn't be
-- CDN-cached; a baked-in absolute URL would pin the bucket and CDN hostname
-- into the database, so moving either would mean a data migration. The API
-- assembles the URL from MEDIA_BASE_URL at read time instead.
CREATE TABLE exercise_media (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    exercise_id  TEXT        NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,

    -- What this asset depicts, which is what lets a client pick the right
    -- one for a context (a list thumbnail vs. a full demo).
    --
    -- 'demo' is the single representative still, and is the common case —
    -- start/end pairs are the exception, not the default. Modelling only
    -- pairs would have forced every one-image exercise to pretend its photo
    -- was a "start position".
    kind         TEXT        NOT NULL,

    -- Path within the bucket, e.g. exercises/barbell-back-squat/start.webp.
    storage_key  TEXT        NOT NULL,

    content_type TEXT        NOT NULL,
    -- Intrinsic dimensions, so a client can reserve layout space before the
    -- image loads instead of reflowing the list as each one arrives.
    width        INTEGER,
    height       INTEGER,
    -- Ordering within a kind; also the display order for multi-step media.
    position     INTEGER     NOT NULL DEFAULT 0,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT exercise_media_kind_valid CHECK (
        kind IN ('thumbnail', 'demo', 'start', 'end', 'demo_video')
    ),
    -- One asset per (exercise, kind, position). Also the conflict target
    -- that makes seeding idempotent without needing a synthetic key.
    CONSTRAINT exercise_media_unique UNIQUE (exercise_id, kind, position)
);

CREATE INDEX exercise_media_exercise_id_idx ON exercise_media (exercise_id);
