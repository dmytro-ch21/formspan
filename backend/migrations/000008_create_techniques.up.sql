-- The BJJ technique library. Deliberately NOT rows in `exercises`, because
-- it is a different shape, not merely a different sport:
--
--   * An exercise is a loggable unit measured by load_type. You never log
--     "3 sets of armbar at 60kg" — techniques aren't measured at all.
--   * A technique is positioned in a *graph*: it comes from a position and
--     is answered by counters. 444 of the 450 seeded techniques carry
--     setup_from edges and all 450 carry counters, so that graph is the
--     substance of the library, not a nice-to-have.
--
-- Forcing these together would leave half the columns null on both sides and
-- make the graph inexpressible.
CREATE TABLE techniques (
    id              TEXT PRIMARY KEY,
    name            TEXT        NOT NULL,
    aliases         TEXT[]      NOT NULL DEFAULT '{}',

    -- Submission | Sweep | Pass | Escape | Takedown | Control/Pin |
    -- Transition | Guard Retention | Other. Left as free text rather than a
    -- CHECK: this vocabulary is still settling, and the seed validates it in
    -- Go where a bad value fails before any write.
    category        TEXT        NOT NULL,

    -- Where it happens — "Guard - Bottom", "Standing", "Mount - Top".
    position        TEXT        NOT NULL,
    position_detail TEXT        NOT NULL DEFAULT '',

    gi_no_gi        TEXT        NOT NULL DEFAULT 'Both',
    typical_belt    TEXT        NOT NULL DEFAULT '',
    description     TEXT        NOT NULL DEFAULT '',

    -- The graph edges. Stored as name arrays rather than FK rows because the
    -- source authors them as free text and not every referenced technique
    -- exists in the library yet — a hard FK would reject the whole seed over
    -- one forward reference. Resolve to IDs when the content stabilises.
    setup_from      TEXT[]      NOT NULL DEFAULT '{}',
    common_counters TEXT[]      NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT techniques_gi_no_gi_valid CHECK (gi_no_gi IN ('Both', 'Gi Only', 'No-Gi Only'))
);

-- Browsing is overwhelmingly "what can I do from here", then "of what kind".
CREATE INDEX techniques_position_idx ON techniques (position);
CREATE INDEX techniques_category_idx ON techniques (category);
