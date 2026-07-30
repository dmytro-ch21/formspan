-- Marking a set done is what makes the session summary *progressive*: the
-- numbers count what you've actually completed, not what's been planned.
-- Without it, opening a template shows full tonnage before you've lifted
-- anything, which is the opposite of a training log.
--
-- Existing rows backfill to true, then the default flips to false. Anything
-- already logged was, by definition, done — resetting history to "not
-- completed" would zero every past session's volume.
ALTER TABLE session_sets ADD COLUMN completed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE session_sets ALTER COLUMN completed SET DEFAULT false;

-- Whether to collect RIR and RPE at all. On by default because the
-- progression rule is built on them and silently withholding its only input
-- would make the app look broken rather than simple; off for anyone who
-- finds two effort fields per set more friction than they're worth.
ALTER TABLE profiles ADD COLUMN track_effort BOOLEAN NOT NULL DEFAULT true;
