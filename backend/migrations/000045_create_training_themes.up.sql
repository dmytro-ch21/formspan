SET lock_timeout = '3s';

-- What a training week is ABOUT. One sentence, per week, per athlete.
--
-- ## Why this is not a second `bjj_focus`
--
-- That question had to be answered before this table could be designed, because
-- the app already has a "what am I working on" list and two of them would drift
-- the way every duplicated vocabulary in this repo has.
--
-- `bjj_focus` is a ROLLING list of three-to-five TECHNIQUES, ranked by the
-- athlete, BJJ-only, with a `started_on` per row that answers "you have been on
-- this five weeks, consider rotating". A theme is a WEEK-BOXED sentence, coarse,
-- and covers whatever the athlete trains. Different granularity, different
-- lifespan, different sport scope.
--
-- **So a theme is a LABEL BESIDE the focus list, never a container for it, and
-- the rule that keeps it that way is that this table stores no technique ids and
-- no exercise ids.** Prose only. The moment a theme could list techniques it
-- would be a second focus list, and the two would answer the same question
-- differently.
--
-- The alternative — a theme that DRIVES focus — was considered and rejected on
-- a specific ground rather than a general one: it would make the focus list a
-- derived value, and `bjj_focus.started_on` exists precisely so that re-saving
-- the list does not reset the clock on a technique. Deriving focus from a week
-- resets that clock every Monday and destroys the one signal the column was
-- added for.
CREATE TABLE IF NOT EXISTS training_themes
(
    user_id    TEXT NOT NULL,

    -- The Monday of the week, as a calendar DATE.
    --
    -- Same reasoning as `plans.day`: "this week" is a claim about the athlete's
    -- own calendar, and a timestamptz would slide across a boundary the moment
    -- they fly somewhere. Monday because both clients' `startOfWeek` already say
    -- Monday, and a training week is a training block.
    week_start DATE NOT NULL,

    -- One sentence. The cap is the point: a theme that runs to a paragraph is a
    -- plan, and plans have their own table.
    title      TEXT NOT NULL,

    -- Room for the why, when there is one.
    notes      TEXT NOT NULL DEFAULT '',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One theme per week, and that IS the model rather than a limitation
    -- accepted for now. "This is a deload week" is a claim about the week, not
    -- about a discipline within it — an athlete who lifts and rolls has one
    -- week, not two. Per-sport themes would need a nullable `sport` in the key,
    -- and NULL does not deduplicate in a Postgres unique constraint, so that
    -- shape invites exactly the duplicate rows this avoids. Additive later if
    -- the need turns out to be real.
    PRIMARY KEY (user_id, week_start),

    -- A week that does not start on a Monday would silently overlap its
    -- neighbours, and two themes covering the same days is the one state the
    -- primary key above cannot catch.
    CONSTRAINT training_themes_week_starts_monday
        CHECK (EXTRACT(ISODOW FROM week_start) = 1),

    CONSTRAINT training_themes_title_present
        CHECK (char_length(btrim(title)) > 0),
    CONSTRAINT training_themes_title_len
        CHECK (char_length(title) <= 80),
    CONSTRAINT training_themes_notes_len
        CHECK (char_length(notes) <= 500)
);

-- Every read is "this athlete's themes over a date range", for the week view and
-- for reading a past week back. The primary key already leads with `user_id`, so
-- that index serves it; no second one is added.
