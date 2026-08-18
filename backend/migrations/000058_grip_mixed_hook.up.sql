-- Widen the grip vocabulary to six: `mixed` and `hook` join the four from
-- 000054.
--
-- 000054 left them out on purpose and said why: they are how a heavy deadlift
-- is held, not variations of the other four, so offering the four on a hinge
-- would collect `regular` for a mixed pull — a false entry rather than a
-- missing one. Its answer was to withhold the picker from hinges, carries and
-- olympic lifts entirely. That is 93 of 762 exercises, and they are the ones
-- where grip matters MOST: a deadlifter could not record how they pull.
--
-- **The constraint NAME must keep the substring `grip`.** `translatePgError`
-- matches on it to return `ErrInvalidGrip` rather than a generic
-- `ErrInvalidInput`, and that distinction is the wire code `invalid_grip`,
-- which is the phone's signal that it may drop the grip and retry the push.
-- Rename this to something without "grip" in it and stale clients stop
-- repairing themselves, silently. Dropping and re-adding under the same name
-- keeps that intact.
--
-- No side on `mixed`. One hand is over and one is under, and lifters do
-- alternate which — but nothing consumes that yet, and asking "which hand?"
-- between sets is a question answered carelessly or skipped, which is the
-- confident-wrong-answer this column's whole design refuses. #256 made adding
-- a value later cheap (the server refuses an unknown grip with a code the
-- client acts on, and an old build keeps what it holds rather than nulling it),
-- so `mixed_left`/`mixed_right` remain reachable without a stale-client story.
-- Same as 000054, which created this constraint: `session_sets` is the largest
-- table in the app, and ADD CONSTRAINT ... CHECK scans all of it under ACCESS
-- EXCLUSIVE. Without a timeout the ALTER queues behind any long-running query
-- and every subsequent query on the table — reads included — queues behind the
-- ALTER. Failing fast beats blocking every session write.
SET lock_timeout = '3s';

ALTER TABLE session_sets
    DROP CONSTRAINT IF EXISTS session_sets_grip_valid;

ALTER TABLE session_sets
    ADD CONSTRAINT session_sets_grip_valid
    CHECK (grip IS NULL OR grip IN
        ('regular', 'neutral', 'reverse', 'angled', 'mixed', 'hook'));

COMMENT ON COLUMN session_sets.grip IS
    'How the implement was held for this set: regular (overhand/pronated), neutral '
    '(palms facing), reverse (underhand/supinated), angled (an EZ-bar or multi-grip '
    'handle), mixed (one over, one under — no side recorded) or hook (thumb trapped '
    'under the fingers). NULL means unrecorded, never a default: nobody who logged '
    'before this column existed chose a grip, and reading silence as overhand would '
    'invent training data.';
