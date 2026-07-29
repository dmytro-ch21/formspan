-- The twelve hand-written starter exercises are superseded by the 523-entry
-- authored catalog. Most were renamed on the way in (barbell-back-squat ->
-- back-squat), so without this they'd linger alongside their replacements
-- and the API would serve both.
--
-- This is the "seeding never deletes" gap biting for real: the JSON is
-- authoritative for content but not for membership, so a removed entry stays
-- forever. A one-off migration is the right tool here — these are known IDs
-- from a pre-release placeholder set — but the general problem still wants
-- an `archived_at` column rather than a migration each time.
--
-- Safe because nothing references them: the media rows that pointed at three
-- of these have been re-pointed at their replacements in the seed, and no
-- workout or activity in any environment predates this catalog.
DELETE FROM exercises WHERE id IN (
    'barbell-back-squat',
    'barbell-bench-press',
    'barbell-deadlift',
    'barbell-overhead-press',
    'barbell-row',
    'dumbbell-lunge',
    'farmers-carry',
    'pull-up',
    'bjj-gi-rounds',
    'bjj-drilling'
);
