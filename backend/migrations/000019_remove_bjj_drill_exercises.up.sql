-- Remove the 20 BJJ drills from the exercise catalog.
--
-- They predate the technique library. Now that `techniques` holds 466 real BJJ
-- entries, filtering the Library to "BJJ" returned twenty conditioning drills
-- (Bear Crawl, Sprawl, Granby Roll…) alongside them — two different kinds of
-- thing under one label, and the drills carried the backend's per-sport
-- placeholder image, so they rendered as a block of identical stock photos.
--
-- WHY A MIGRATION AND NOT JUST THE SEED: `UpsertAll` never deletes. Removing
-- rows from exercises.json leaves them in every database that has already been
-- seeded, forever. This is the first time that documented gap has actually
-- had to be paid.
--
-- DELIBERATELY CONDITIONAL. Anything a user has genuinely logged or planned
-- against is kept: `session_sets` and `workout_items` reference `exercises`
-- with no ON DELETE clause, so an unconditional DELETE would either fail the
-- whole migration or, worse, tempt someone into adding CASCADE and silently
-- destroying training history. A drill that survives here is visible in the
-- library rather than a crash — the right failure direction.
--
-- `exercise_media`, `exercise_unit_prefs` and `pinned_exercises` all CASCADE,
-- so they clean up on their own.
--
-- Verified against staging before writing this: 20 bjj rows, 0 referenced by
-- session_sets, 0 by workout_items, 0 pinned.
DELETE FROM exercises e
WHERE e.sport = 'bjj'
  AND NOT EXISTS (SELECT 1 FROM session_sets  s WHERE s.exercise_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM workout_items w WHERE w.exercise_id = e.id);
