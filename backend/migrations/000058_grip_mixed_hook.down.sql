-- Narrow the vocabulary back to the four from 000054.
--
-- Rows carrying the two new values would violate the restored CHECK, so they
-- are cleared FIRST. That loses data, which is the honest cost of going
-- backwards here: there is no narrower grip to demote a mixed pull to, and
-- `regular` would be a false entry — precisely the thing 000054 refused to
-- invent. Clearing gives back "unrecorded", which is true.
UPDATE session_sets SET grip = NULL WHERE grip IN ('mixed', 'hook');

ALTER TABLE session_sets
    DROP CONSTRAINT IF EXISTS session_sets_grip_valid;

ALTER TABLE session_sets
    ADD CONSTRAINT session_sets_grip_valid
    CHECK (grip IS NULL OR grip IN ('regular', 'neutral', 'reverse', 'angled'));

COMMENT ON COLUMN session_sets.grip IS
    'How the implement was held for this set: regular (overhand/pronated), neutral '
    '(palms facing), reverse (underhand/supinated), angled (an EZ-bar or multi-grip '
    'handle). NULL means unrecorded, never a default: nobody who logged '
    'before this column existed chose a grip, and reading silence as overhand would '
    'invent training data. mixed and hook are deliberately absent; see the migration.';
