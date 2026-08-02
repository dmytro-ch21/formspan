-- BJJ rank, as a history rather than a column.
--
-- The obvious design is `profiles.belt` + `profiles.stripes`, and it is wrong
-- for a reason worth writing down: a current-rank column and a promotion
-- history are two sources for one fact, and they drift. Someone edits a
-- promotion date, or deletes a mistaken entry, and the column still says
-- brown. Deriving the current rank FROM the history means there is nothing to
-- keep in step.
--
-- It also matches how the sport actually works. A promotion is an event with a
-- date, a place and a person behind it; a belt is just the most recent one.
-- "Three years at blue" is a question about the timeline, and a column cannot
-- answer it.
CREATE TABLE IF NOT EXISTS bjj_promotions (
    -- Minted here, not by the client. Every other id in this schema is
    -- client-generated, because sessions and workouts are created offline and
    -- pushed later and the id is what makes the retry idempotent. A promotion
    -- is entered at a desk with a connection; there is no outbox behind it, so
    -- a client id buys nothing -- and `gen_random_uuid()` is built into
    -- Postgres, so this costs no Go dependency either.
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id     TEXT NOT NULL,

    -- Adult IBJJF only for now: white | blue | purple | brown | black.
    -- Deliberately TEXT with no CHECK constraint — the same call migration
    -- 000021 made for sports. Validation lives in Go, where adding coral or
    -- the kids belts is an enum edit rather than a migration.
    belt        TEXT NOT NULL,

    -- 0-4. Stripes reset to 0 on promotion to the next belt, which is why
    -- they live on the promotion and not on the athlete.
    stripes     SMALLINT NOT NULL DEFAULT 0,

    -- Black-belt degrees, 0-6. Null-free: 0 means "not a black belt, or a
    -- black belt with no degrees yet", and both render identically.
    degree      SMALLINT NOT NULL DEFAULT 0,

    -- When it happened. NULLABLE on purpose: plenty of people genuinely do
    -- not remember when they got their blue belt, and refusing the promotion
    -- without a date would lose the fact to protect the metadata. An undated
    -- promotion still establishes rank; it just cannot contribute to
    -- time-at-belt.
    promoted_on DATE,

    -- Free text, per promotion. Not a foreign key to an academies table:
    -- shared academy entities need dedupe, a naming authority and an admin
    -- merge surface, and nothing yet asks for "who else trains here".
    academy     TEXT NOT NULL DEFAULT '',
    -- Who tied it on. The one piece of this an athlete is most likely to
    -- want kept verbatim.
    instructor  TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read is "this athlete's promotions, most recent first".
CREATE INDEX IF NOT EXISTS bjj_promotions_user_idx
    ON bjj_promotions (user_id, promoted_on DESC NULLS LAST);
