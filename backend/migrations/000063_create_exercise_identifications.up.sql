-- Meters machine identification, so the daily cap survives a restart.
--
-- # What was wrong
--
-- N7 shipped with `identifyLimiter` only: a rate limiter, `Burst: 20,
-- Every: 30m`, which is about 48 calls a day sustained. Two problems, and the
-- second is the one that makes this urgent rather than tidy.
--
-- It is the WEAKER of the two controls on the more expensive half. Food
-- estimation has hard daily caps; identification had a burst that refills
-- forever.
--
-- And **the limiter is in-memory**, so it resets on process restart. Every
-- deploy hands every athlete a fresh burst of 20 — the ceiling stops being a
-- ceiling on exactly the days we ship most. A day with 23 deploys is a day with
-- 23 refills. That is what a table fixes and a counter in a process cannot.
--
-- N7's history entry recorded this as a DELIBERATE deferral rather than an
-- oversight — left whole rather than half-built, with the gap written down. This
-- migration is that deferral coming due, not a defect being papered over.
--
-- # The rate limiter STAYS
--
-- A quota bounds the day; a rate limit bounds the burst. They answer different
-- questions, and dropping either leaves a real gap: without the limiter a
-- client bug can spend a whole day's quota in one second, and without the quota
-- the day has no ceiling at all.
--
-- # Shape
--
-- Deliberately the twin of `nutrition_estimates` (000060), because the same
-- three properties are load-bearing and were already solved there:
--
--   * adherence is a QUERY over these rows, never a stored counter — a counter
--     drifts, cannot be recomputed, and cannot answer "what did this athlete
--     actually do";
--   * the gate runs BEFORE the model call, or it is a receipt rather than a
--     quota;
--   * failed and refused calls are recorded too, because they spend tokens.
--     A caller looping on a photo the model keeps refusing pays for every
--     attempt, and a quota counting only successes would never stop them.
--
-- No `source` column, unlike its twin: there is exactly one path here — a
-- photograph of a machine. A column with one legal value is a column that
-- invites a second meaning later.
--
-- **The photo itself is never stored**, matching the nutrition table: the bytes
-- are forwarded to the provider and discarded. That is what keeps this table
-- free of a retention question and of anything a breach would expose.
CREATE TABLE exercise_identifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT        NOT NULL,
    -- Whether a shortlist came back. Refusals and outages are recorded as
    -- false and still count: see above.
    succeeded       BOOLEAN     NOT NULL,
    -- What answered, for a later quality question that would otherwise be
    -- guesswork. Not the athlete's photo, which is never persisted.
    model           TEXT        NOT NULL DEFAULT '',
    -- How many candidates were offered, which is the one number that says
    -- whether the shortlist is doing its job.
    candidate_count INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The quota query's index: one athlete, newest first, inside a rolling window.
CREATE INDEX exercise_identifications_quota_idx
    ON exercise_identifications (user_id, created_at DESC);
