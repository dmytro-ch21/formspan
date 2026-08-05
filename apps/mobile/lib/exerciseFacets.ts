import type { Exercise } from '@/lib/exercises';

/**
 * The two axes a strength catalog is actually browsed on: what it works, and
 * what shape the movement is.
 *
 * **Both are groupings, not the raw fields.** The catalog carries 58 distinct
 * `primary_muscles` and 15 `movement_pattern`s — real anatomy, and useless as a
 * filter: nobody opens a library looking for `teres-minor`, and "push" is not a
 * value in the data at all, it is `horizontal_push` and `vertical_push`. So the
 * raw vocabulary is mapped to something a person would ask for.
 *
 * **Every raw value must land in a group** — asserted against both the shipped
 * catalog and, for movement, the API's own closed vocabulary. Note the limit of
 * that guarantee: `primary_muscles` is validated against no vocabulary anywhere
 * in the backend, so the admin console can mint free-text muscles that no test
 * here can see. The coverage claim is "everything a deploy ships", not
 * "everything the API will accept". `exerciseFacets.test.ts` asserts because the failure mode is silent: an
 * unmapped muscle makes its exercises unreachable through the filter while they
 * still exist in the list, so nothing looks broken and a handful of exercises
 * are simply undiscoverable. Adding a muscle to `exercises.json` without adding
 * it here turns that test red, which is the whole point of it.
 *
 * Kept client-side deliberately. `GET /v1/exercises` takes only `q` and
 * `sport`, but `movement_pattern` and `primary_muscles` are already on every
 * row the Library has loaded — so this is a filter over data in hand rather
 * than a round trip, and it works offline like the rest of the screen.
 */

export type Facet = { key: string; label: string };

/**
 * Muscle groups, in the order they are offered.
 *
 * **Glutes are their own group rather than part of Legs**, which looks odd
 * anatomically and is right here: `glutes` is the single most common primary
 * muscle in the catalog (138 of 504). Legs is already 159 of 504 on its own —
 * 31%, the largest group by some way — and merging glutes in takes it to
 * roughly half the catalog, which is not a filter. Neck and Full body are small but
 * kept honest rather than swept into an "Other" that tells nobody anything.
 */
export const MUSCLE_GROUPS: (Facet & { muscles: readonly string[] })[] = [
  {
    key: 'chest',
    label: 'Chest',
    muscles: ['chest', 'upper-chest', 'lower-chest', 'serratus'],
  },
  {
    key: 'back',
    label: 'Back',
    muscles: [
      'lats', 'back', 'upper-back', 'mid-back', 'lower-back',
      'traps', 'upper-traps', 'mid-traps', 'lower-traps',
      'spinal-erectors', 'posterior-chain', 'spine', 'thoracic-spine',
    ],
  },
  {
    key: 'shoulders',
    label: 'Shoulders',
    muscles: [
      'shoulders', 'delts', 'front-delts', 'lateral-delts', 'rear-delts',
      'rotator-cuff', 'infraspinatus', 'subscapularis', 'teres-minor',
      'external-rotators',
    ],
  },
  {
    key: 'arms',
    label: 'Arms',
    muscles: [
      'biceps', 'triceps', 'brachialis', 'brachioradialis', 'forearms',
      'grip', 'wrist-extensors', 'wrist-flexors', 'hands',
    ],
  },
  {
    key: 'core',
    label: 'Core',
    muscles: [
      'abdominals', 'core', 'deep-core', 'lower-abdominals', 'obliques',
      'hip-flexors',
    ],
  },
  {
    key: 'glutes',
    label: 'Glutes',
    muscles: ['glutes', 'glute-medius'],
  },
  {
    key: 'legs',
    label: 'Legs',
    muscles: [
      'quadriceps', 'hamstrings', 'adductors', 'calves', 'soleus',
      'legs', 'hips', 'hip-rotators', 'ankles',
    ],
  },
  {
    key: 'neck',
    label: 'Neck',
    muscles: ['neck-extensors', 'neck-flexors', 'lateral-neck'],
  },
  {
    key: 'full-body',
    label: 'Full body',
    muscles: ['full-body', 'cardiorespiratory'],
  },
];

/**
 * Movement groups, in the order they are offered.
 *
 * "Push" and "Pull" are the two the request named, and neither exists in the
 * data — each is a horizontal and a vertical pattern folded together. The rest
 * follow the same rule: a name someone would say out loud, over whatever the
 * spreadsheet happened to call it.
 */
export const MOVEMENT_GROUPS: (Facet & { patterns: readonly string[] })[] = [
  { key: 'push', label: 'Push', patterns: ['horizontal_push', 'vertical_push'] },
  { key: 'pull', label: 'Pull', patterns: ['horizontal_pull', 'vertical_pull'] },
  { key: 'squat', label: 'Squat', patterns: ['squat'] },
  { key: 'hinge', label: 'Hinge', patterns: ['hinge'] },
  { key: 'lunge', label: 'Lunge', patterns: ['lunge'] },
  { key: 'carry', label: 'Carry', patterns: ['carry'] },
  // "Trunk", not "Core", because MUSCLE_GROUPS already has a Core: the button
  // face shows only the chosen value, so setting both gave two adjacent pills
  // reading "Core" with no way to tell which axis was which.
  { key: 'core', label: 'Trunk', patterns: ['core', 'rotation'] },
  { key: 'isolation', label: 'Isolation', patterns: ['isolation'] },
  { key: 'power', label: 'Power', patterns: ['olympic', 'jump'] },
  // `grappling` is in the API's closed vocabulary and shipped by no row today,
  // so the coverage test — whose oracle is the shipped catalog — was green on
  // the one hole that actually existed. The first admin-authored exercise using
  // it would have been silently unreachable. Now mapped, and the vocabulary
  // itself is asserted alongside the rows.
  { key: 'conditioning', label: 'Conditioning', patterns: ['locomotion', 'grappling'] },
  { key: 'mobility', label: 'Mobility', patterns: ['mobility'] },
];

const MUSCLE_TO_GROUP = new Map<string, string>(
  MUSCLE_GROUPS.flatMap((g) => g.muscles.map((m) => [m, g.key] as const)),
);
const PATTERN_TO_GROUP = new Map<string, string>(
  MOVEMENT_GROUPS.flatMap((g) => g.patterns.map((p) => [p, g.key] as const)),
);

/** The group a raw `primary_muscles` entry belongs to, or null if unmapped. */
export function muscleGroupOf(muscle: string): string | null {
  return MUSCLE_TO_GROUP.get(muscle) ?? null;
}

/** The group a raw `movement_pattern` belongs to, or null if unmapped. */
export function movementGroupOf(pattern: string): string | null {
  return PATTERN_TO_GROUP.get(pattern) ?? null;
}

/**
 * Does this exercise work that muscle group?
 *
 * `primary_muscles` only — NOT secondary. Almost everything works almost
 * everything secondarily, so including them makes "Chest" return most of the
 * catalog and the filter stops meaning anything. An exercise with several
 * primaries legitimately appears under each.
 */
export function inMuscleGroup(e: Exercise, group: string): boolean {
  if (!group) return true;
  return e.primary_muscles.some((m) => MUSCLE_TO_GROUP.get(m) === group);
}

/** Is this exercise that shape of movement? */
export function inMovementGroup(e: Exercise, group: string): boolean {
  if (!group) return true;
  return PATTERN_TO_GROUP.get(e.movement_pattern) === group;
}
