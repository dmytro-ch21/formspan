-- Where a catalog row came from, so content stops needing a deploy.
--
-- Until now the embedded JSON was the only writer: adding a technique meant
-- editing `techniques.json`, committing, deploying and re-seeding. That is the
-- wrong loop for something an athlete wants to do standing on the mat, having
-- just been shown a pass whose name is not in the list.
--
-- The column is what makes a second writer safe. `cmd/seed` upserts by id with
-- a change-detection tuple, so without it a re-seed would silently revert every
-- admin edit to a row the JSON also knows about — and a re-seed runs on every
-- deploy. With it, seeding is scoped to `source = 'seed'` and admin-authored
-- content is untouchable by deploys.
--
-- 'seed'  — comes from the embedded JSON; the deploy owns it.
-- 'admin' — authored in the admin console; the database owns it, and an export
--           command carries it back into the JSON so it can be reviewed and
--           promoted to another environment through the normal deploy.
--
-- DEFAULT 'seed' is deliberate for the backfill: every row that exists today
-- came from the JSON, and defaulting the other way would make the next seed
-- skip the entire catalog.
ALTER TABLE techniques
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'seed'
        CONSTRAINT techniques_source_known CHECK (source IN ('seed', 'admin'));

ALTER TABLE exercises
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'seed'
        CONSTRAINT exercises_source_known CHECK (source IN ('seed', 'admin'));

-- The export reads one partition; nothing else filters on this.
CREATE INDEX IF NOT EXISTS techniques_source_idx ON techniques (source) WHERE source = 'admin';
CREATE INDEX IF NOT EXISTS exercises_source_idx ON exercises (source) WHERE source = 'admin';
