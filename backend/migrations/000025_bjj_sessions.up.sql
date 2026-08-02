-- BJJ session logging: the detail a mat session has and a barbell session does
-- not, plus the evidence stream every deferred BJJ feature reads.
--
-- ###########################################################################
-- # MERGE ORDER: this is 25 and there is an unmerged 24. Land 24 FIRST.
-- #
-- # `feat/bjj-position-glossary` carries 000024_positions and is not on main
-- # (main stops at 23). golang-migrate tracks a single integer version, so if
-- # this migration lands first the recorded version becomes 25 and 24 is
-- # then **silently skipped forever** — `migrate up` only runs versions
-- # greater than the current one. No error, no warning; the glossary tables
-- # simply never exist on any database that took 25 first, including the
-- # already-migrated Railway staging Postgres.
-- #
-- # Either merge the glossary branch before this one, or renumber this pair
-- # above whatever that branch ends up as. Nothing here depends on 24 — the
-- # constraint is purely the version counter.
-- ###########################################################################
--
-- # Why a companion table and not columns on `sessions`
--
-- A BJJ session IS a session — `sport = 'bjj'`, a real row in `sessions` — and
-- that is not a formality. Training history, the consistency grid, active days
-- and the cross-sport load currency all read `sessions`; a BJJ session that
-- lived in its own table would be invisible to every one of them, which would
-- quietly break the one promise the product is built on (one calendar, all
-- sports). So the session row stays where it is and this table hangs off it.
--
-- The detail is a separate table rather than eight nullable columns on
-- `sessions` for the reason `profile` already refused a belt column: rounds,
-- gi and mat RPE are meaningless to strength and running, and a shared table
-- that carries every discipline's specifics is how it ends up carrying all of
-- them badly.
--
-- # Why there are no sets
--
-- Not a simplification — a BJJ session *cannot* carry a `session_sets` row.
-- `session_sets.exercise_id` is NOT NULL and references `exercises`, and the
-- repository asserts every set's `exercises.sport` matches the session's;
-- migration 000019 removed the last BJJ rows from `exercises`, so there is no
-- legal set to attach. That was the right call (a technique is not measured in
-- reps) and this table is the consequence of it.

SET lock_timeout = '3s';

-- One row per BJJ session, 1:1 with `sessions`.
CREATE TABLE IF NOT EXISTS bjj_session_details
(
    -- Shares the session's id rather than minting its own: there is exactly
    -- one detail row per session, so a separate key would only create a way
    -- for the two to disagree.
    session_id    TEXT        PRIMARY KEY,

    -- Denormalised so the composite owner FK below can exist, matching
    -- `session_sets`. See 000014 for the full argument.
    user_id       TEXT        NOT NULL,

    -- class | drilling | positional | rolling. No CHECK, deliberately: this
    -- vocabulary is validated in Go, so adding "competition" or "open mat"
    -- later is an enum edit rather than a migration. Same stance 000021 took
    -- when it dropped the sport CHECKs.
    kind          TEXT        NOT NULL,

    -- NULL means "didn't say", which is a different fact from gi or no-gi and
    -- has to stay tellable — the floor log is three taps and this is not one
    -- of them.
    gi            BOOLEAN,

    -- Volume. Rounds x round length is the BJJ equivalent of tonnage and the
    -- external-load half of the load currency. Both nullable: a class you
    -- turned up to and didn't spar is a real session.
    rounds        INTEGER,
    round_minutes INTEGER,

    -- Session RPE, 1-10. The single highest-information input in the app and
    -- the internal-load half of sRPE x duration, which is what puts a round of
    -- rolling and a set of squats in the same unit. Range-checked because a
    -- range is not a vocabulary — `session_sets.rpe` is checked the same way.
    session_rpe   INTEGER     CONSTRAINT bjj_session_details_rpe_range
                              CHECK (session_rpe IS NULL OR (session_rpe BETWEEN 1 AND 10)),

    -- Free text, per promotion-history precedent: academies are not a shared
    -- entity until something asks "who else trains here".
    academy       TEXT        NOT NULL DEFAULT '',

    -- The reflection note. Kept here rather than in `sessions.notes` so the
    -- session's own notes field keeps meaning the same thing for every sport.
    note          TEXT        NOT NULL DEFAULT '',

    -- Body/injury flag. Feeds the recommendation rules' safety floors later;
    -- captured now because it is free to ask at reflection and impossible to
    -- reconstruct afterwards.
    body_note     TEXT        NOT NULL DEFAULT '',

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT bjj_session_details_positive
        CHECK ((rounds IS NULL OR rounds > 0)
           AND (round_minutes IS NULL OR round_minutes > 0)),

    CONSTRAINT bjj_session_details_session_owner_fk
        FOREIGN KEY (session_id, user_id) REFERENCES sessions (id, user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- The evidence stream.
--
-- This is the table the deferred features (proficiency views, the position
-- heatmap, the technique funnel, gap detection, the gameplan) are all pure
-- reads over, which is why its shape is settled now rather than when those get
-- built: position context and outcome direction are nearly free to record
-- today and expensive to retrofit onto months of history that lacks them.
--
-- The unit is an evidence event, never a self-assessment. "Rate your triangle
-- 1-5" produces a number with no provenance that goes stale; "attempted twice
-- from closed guard, hit once" produces a fact that stays true and that a
-- score can be derived from later.
CREATE TABLE IF NOT EXISTS bjj_session_tags
(
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    session_id   TEXT        NOT NULL,
    user_id      TEXT        NOT NULL,

    -- submission | sweep | pass | escape | takedown | control. Free text for
    -- the same reason `kind` is, and drawn from the technique library's own
    -- category vocabulary so a tagged technique can prefill it.
    category     TEXT        NOT NULL,

    -- THE OUTCOME DIRECTION, and the reason this table is worth its cost.
    --
    --   drilled   — practised, not live
    --   attempted — tried it live, it didn't land
    --   scored    — landed it live
    --   conceded  — it was done to you
    --
    -- drilled -> attempted -> scored is the technique funnel, whose drop-offs
    -- are the most actionable numbers in the sport ("drilled 12 times,
    -- attempted 0" is a finding, not a statistic). `conceded` is the
    -- symmetric half and the more valuable one: "where do I keep getting
    -- stuck" is the question every serious grappler has and almost nobody has
    -- data on. A schema that recorded only what worked could never answer it.
    event        TEXT        NOT NULL,

    -- Position context — the graph node this evidence attaches to. Stored as
    -- the position *family* ("Half Guard", "Mount"), matching the library's
    -- own filter granularity, because that is what the athlete can pick in
    -- seconds and what a heatmap reads. Empty means untagged, which is a
    -- normal fast-path outcome and not an error.
    position     TEXT        NOT NULL DEFAULT '',

    -- The specific technique, when known. Nullable on purpose: "got swept
    -- from half guard" is real evidence and must not require naming the
    -- sweep, or the fast path stops being fast and people stop logging.
    --
    -- ON DELETE SET NULL, not CASCADE: retiring a technique from the shared
    -- library must never delete an athlete's record of having done it.
    technique_id TEXT        REFERENCES techniques (id) ON DELETE SET NULL,

    -- "Hit three armbars" is one row, not three. Reflection is recalled in
    -- counts, and a row per repetition would make editing a chip mean
    -- reconciling N rows.
    count        INTEGER     NOT NULL DEFAULT 1
                             CONSTRAINT bjj_session_tags_count_positive CHECK (count > 0),

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT bjj_session_tags_session_owner_fk
        FOREIGN KEY (session_id, user_id) REFERENCES sessions (id, user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Reading one session back, which every detail screen does.
CREATE INDEX IF NOT EXISTS bjj_session_tags_session_idx
    ON bjj_session_tags (session_id);

-- The technique funnel: every event for one technique across all sessions.
-- Partial because a tag with no technique cannot appear in a funnel keyed on
-- one, and roughly half of fast-path tags will have none.
CREATE INDEX IF NOT EXISTS bjj_session_tags_user_technique_idx
    ON bjj_session_tags (user_id, technique_id, event)
    WHERE technique_id IS NOT NULL;

-- The position heatmap and gap detection: where this athlete's rounds are won
-- and lost, and which nodes have no successful edges out.
CREATE INDEX IF NOT EXISTS bjj_session_tags_user_position_idx
    ON bjj_session_tags (user_id, position, event);
