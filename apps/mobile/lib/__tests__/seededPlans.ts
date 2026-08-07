/**
 * The seeded plan ids, mirrored for the artwork test.
 *
 * A copy rather than a read of `workouts.json`, because the point of the
 * palette test is spread across the ids that actually ship — and importing the
 * Go module's JSON from here would couple a UI test to the backend's file
 * layout for one array of strings.
 */
export const SEEDED_PLAN_IDS = [
  'public-bodyweight-foundations',
  'public-home-upper',
  'public-home-lower',
  'public-home-core',
  'public-bodyweight-conditioning',
  'public-dumbbells-full-body',
  'public-dumbbells-upper',
  'public-dumbbells-lower',
  'public-ppl-push',
  'public-ppl-pull',
  'public-ppl-legs',
  'public-upper',
  'public-lower',
  'public-full-body',
  'public-heavy-five',
  'public-heavy-five-b',
  'public-kettlebell-conditioning'
] as const;
