-- Enrich the technique library with the rest of the authored spreadsheet, and
-- normalise the IBJJF competition rules out of the technique rows.
--
-- WHY A SEPARATE RULESET TABLE, when it is only 25 rows:
--
-- The six IBJJF columns are near-constant across the library. `age_scope` has
-- exactly ONE distinct value across all 466 techniques; `rule_notes` has 16,
-- and its most common string repeats 359 times at ~200 characters. Stored per
-- technique that is ~182 KB of duplicated prose; stored once per ruleset it is
-- ~11 KB. The library is read far more than it is written and is shipped to a
-- phone, so the duplication is paid on every list request forever.
--
-- It also gives the rules one place to be corrected. IBJJF updates its rulebook
-- periodically; with the text inlined, a rule change is a 359-row UPDATE that
-- can half-apply. Here it is one row.
CREATE TABLE ibjjf_rulesets (
    id           TEXT PRIMARY KEY,

    -- "Adult (18+) — Gi and No-Gi separated". One value today, kept as a
    -- column because under-18 divisions use a stricter chart and will
    -- eventually need their own rulesets rather than a schema change.
    age_scope    TEXT   NOT NULL,

    -- "Generally legal — Adult", "Brown/Black only — Adult", "Prohibited", …
    rule_class   TEXT   NOT NULL,

    -- Belts allowed in each division. EMPTY MEANS "not applicable to this
    -- division", not "allowed at no belt" — a gi-only technique has no no-gi
    -- belts at all. The human-readable reason lives in the matching *_note,
    -- because "N/A — gi-specific" is a statement about scope that an empty
    -- array cannot carry.
    gi_allowed_belts     TEXT[] NOT NULL DEFAULT '{}',
    gi_note              TEXT   NOT NULL DEFAULT '',
    no_gi_allowed_belts  TEXT[] NOT NULL DEFAULT '{}',
    no_gi_note           TEXT   NOT NULL DEFAULT '',

    -- Precomputed at import, and load-bearing enough to be worth a column.
    --
    -- Adult no-gi has NO WHITE BELT DIVISION, so a no-gi technique listing
    -- "Blue, Purple, Brown, Black" is the BASELINE — not a restriction on the
    -- technique. Deriving "is this restricted?" by comparing belt lists gets
    -- this wrong and flags ~130 perfectly ordinary techniques (hand fighting,
    -- pummelling, sit-outs) as restricted. That mistake was made three times
    -- while building this. The real count is 20.
    --
    -- Stored rather than derived so no reader has to know that rule.
    is_restricted BOOLEAN NOT NULL DEFAULT false,

    notes        TEXT   NOT NULL DEFAULT '',
    sources      TEXT[] NOT NULL DEFAULT '{}',

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE techniques
    -- The tactical layer the library was missing. `description` is mechanics
    -- ("control wrist and elbow, pivot across the shoulder"); `when_to_use` is
    -- the decision ("after the elbow is isolated, BEFORE the stack completes").
    -- Averages 228 chars against description's 120.
    ADD COLUMN when_to_use       TEXT   NOT NULL DEFAULT '',

    -- The third graph edge. Only ~29% of these resolve to another technique in
    -- the library (against 80% for setup_from), so this is mostly prose naming
    -- things that are not entries — "establish grips or inside ties". Stored as
    -- text for that reason; the UI must not render an unresolvable name as a
    -- tappable link.
    ADD COLUMN common_next_moves TEXT[] NOT NULL DEFAULT '{}',

    -- Empty in every row of the current spreadsheet. Carried so the column
    -- exists when content arrives; the UI renders nothing when it is blank
    -- rather than an empty section implying a missing video.
    ADD COLUMN video_reference   TEXT   NOT NULL DEFAULT '',
    ADD COLUMN source_notes      TEXT   NOT NULL DEFAULT '',

    -- NOT NULL would fail on the 450 rows already seeded. Nullable with an FK
    -- so a technique may predate its ruleset, and ON DELETE RESTRICT so a
    -- ruleset cannot be removed while techniques still point at it.
    ADD COLUMN ibjjf_ruleset_id  TEXT
        REFERENCES ibjjf_rulesets (id) ON DELETE RESTRICT;

CREATE INDEX techniques_ibjjf_ruleset_id_idx ON techniques (ibjjf_ruleset_id);

-- Search today is ILIKE on `name` alone, unindexed. At 466 rows a sequential
-- scan is genuinely fine — this index is for aliases, which is a correctness
-- gap rather than a speed one: "scarf hold" and "kesa gatame" are the same
-- technique and only one of them is the name.
--
-- pg_trgm rather than tsvector deliberately: it keeps the existing substring
-- semantics (typing "arm" matches "armbar"), which prefix-based full-text
-- search would break.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX techniques_name_trgm_idx
    ON techniques USING GIN (name gin_trgm_ops);
