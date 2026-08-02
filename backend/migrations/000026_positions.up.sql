-- The nodes of the graph, given content.
--
-- docs/decisions/bjj-tracking-design.md §4 describes the library as a graph:
-- techniques are edges, positions are the organizing dimension they run
-- between. The edges were seeded (466 of them); the nodes never were. Positions
-- existed only as free text on `techniques.position` and as a filter-chip
-- taxonomy on the clients — enough to narrow a list, and nothing a beginner
-- could read. "Armbar from Closed Guard" is unreadable if nothing tells you
-- what closed guard is.
--
-- WHY THIS TABLE LIVES IN THE technique MODULE rather than its own:
-- same reasoning as ibjjf_rulesets in migration 000017. It is reference content
-- for the library, read on the same screens, seeded from the same command. A
-- module boundary here would buy a package and cost a cross-module call on
-- every library render.
--
-- WHY NO FOREIGN KEY from techniques.position to this table:
-- `techniques.position` is prose-ish free text with 14 distinct values
-- ("Guard - Bottom", "Back - Top (Back Control)"), while these are 10 curated
-- entries at family granularity. The clients already relate the two by prefix
-- match (inPositionFamily), which tolerates the mismatch. An FK would force a
-- rewrite of all 466 technique rows to satisfy a constraint that buys nothing
-- the prefix match doesn't already give.
CREATE TABLE IF NOT EXISTS positions (
    -- Hand-authored and stable ("closed-guard", "mount") — NOT content-addressed
    -- like ibjjf_rulesets, whose ids are hashes. That difference is why this
    -- table needs no orphan-pruning step: editing the prose of a position
    -- updates a row rather than minting a new one and stranding the old.
    id           TEXT PRIMARY KEY,
    name         TEXT   NOT NULL,

    -- "guard", "closed guard", "mount position" — what a beginner actually
    -- types. Mirrors techniques.aliases, and exists for the same reason: the
    -- name is one of several things the position is called.
    aliases      TEXT[] NOT NULL DEFAULT '{}',

    -- The bridge to the technique library, and the one field where an
    -- innocuous-looking value is wrong. It must match the family keys the
    -- clients already prefix-match with (Guard, Half Guard, Standing, Mount,
    -- Side Control, Back, Turtle, North-South) — note "Back", NOT "Back
    -- Control", because the technique rows say "Back - Top (Back Control)".
    -- A typo here fails silently: the cross-linked technique list just comes
    -- back empty. Go-side seed validation checks it against the known set.
    family       TEXT   NOT NULL DEFAULT '',

    -- Pedagogical order, not alphabetical: standing, then the guards, then the
    -- pins in roughly the order a beginner meets them. Alphabetical would open
    -- the glossary on "Back Control", which is the last thing a white belt
    -- needs. Increments of 10 so a position can be inserted without renumbering.
    order_index  INTEGER NOT NULL DEFAULT 0,

    -- The two halves of what a beginner needs, kept apart for the same reason
    -- techniques split description from when_to_use: merged, they produce a
    -- paragraph that answers neither question.
    --   description — what the position is, and how you end up in it.
    --   priorities  — what you are trying to do while you are there, written
    --                 for both players, because every position is someone's
    --                 good news and someone else's problem.
    description  TEXT   NOT NULL DEFAULT '',
    priorities   TEXT   NOT NULL DEFAULT '',

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No index. This table is 10 rows read in full on every glossary open; a
-- sequential scan is the fast path, and an index on order_index would be
-- larger than the table it serves.
