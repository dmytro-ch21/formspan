-- Whether a catalog row is finished enough for athletes to see.
--
-- Until now a console write was live the instant it committed. That was fine
-- while a pull request stood between the write and production: the review was
-- the draft state. Authoring in production removes that step (see
-- docs/decisions/content-authoring-design.md), so a technique saved with a name
-- and nothing else reaches the library immediately, and the first person to
-- find it is an athlete looking for a move they were just shown.
--
-- TECHNIQUES ONLY, deliberately. The exercise catalog has the same console
-- write surface and the same exposure, and it would have been one more ALTER
-- here — but a column is not the feature. Without a create-as-draft path, a
-- public filter and a publish button, `exercises.status` would be a column
-- nothing reads, and the first person to trust it would be wrong. Worse: give
-- exercises drafts without a publish control and you can create one that can
-- never go live. Neither is better than both, and both is the exercise
-- console's turn, not this migration's.
--
-- 'published' — visible in the public catalog. Everything shipped is this.
-- 'draft'     — visible only in the admin console. Not in GET /v1/techniques,
--               not findable, not taggable.
--
-- DEFAULT 'published' is load-bearing for the backfill, and the opposite choice
-- would be a catastrophe rather than a bug: defaulting to 'draft' empties the
-- library of all 542 techniques the moment it runs. Same shape of reasoning as 000032's `source` default — every row that
-- exists today is live today, so the default has to describe them.
--
-- The console's CREATE path sets 'draft' EXPLICITLY for that reason; it cannot
-- rely on the column default, which means the wrong thing for new rows.
--
-- No index. The public list filters `status = 'published'`, which is ~100% of
-- 542 rows — a seq scan is what Postgres would choose anyway, and an index on
-- a column with one dominant value earns nothing. Revisit if drafts ever
-- outnumber the catalog, which would mean something else has gone wrong.
--
-- The ALTER takes ACCESS EXCLUSIVE on a table every client reads.
-- Behind one long-running read on staging that queues everything else, so the
-- ceiling is the difference between a slow migration and an outage. Matches
-- 000028/000029/000032, the most recent ALTERs on these tables.
SET lock_timeout = '3s';

ALTER TABLE techniques
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published'
        CONSTRAINT techniques_status_known CHECK (status IN ('draft', 'published'));
