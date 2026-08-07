-- Drafts for the exercise catalog, the same column techniques got in 000036.
--
-- 000036 deliberately did NOT include exercises: a column without a
-- create-as-draft path, a public filter and a publish button is a column
-- nothing reads, and half of it — drafts with no way to publish them — creates
-- exercises that can never go live. That was the right call then and this is
-- the other half arriving, not a correction.
--
-- Every argument from 000036 applies unchanged, so it is the place to read
-- them. The one that matters most: DEFAULT 'published' is load-bearing for the
-- backfill. Defaulting to 'draft' empties the catalog of all 504 exercises the
-- moment this runs, which is a catastrophe rather than a bug — every row that
-- exists today is live today, so the default has to describe them. The console's
-- CREATE path therefore sets 'draft' explicitly and never relies on it.
--
-- ACCESS EXCLUSIVE on a table every client reads; same 3s ceiling as
-- 000028/000029/000032/000036 for the same reason.
SET lock_timeout = '3s';

ALTER TABLE exercises
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published'
        CONSTRAINT exercises_status_known CHECK (status IN ('draft', 'published'));
