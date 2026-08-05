import {
  MOVEMENT_GROUPS,
  MUSCLE_GROUPS,
  inMovementGroup,
  inMuscleGroup,
  movementGroupOf,
  muscleGroupOf,
} from '../exerciseFacets';
import type { Exercise } from '../exercises';

/**
 * The facet groupings, checked against the catalog that actually ships.
 *
 * The load-bearing test is the coverage one. An unmapped muscle or pattern
 * fails **silently**: its exercises stay in the list, stay searchable, and
 * simply cannot be reached through the filter — so nothing looks broken and a
 * handful of exercises are quietly undiscoverable. Nobody would notice from the
 * screen. Adding a value to `exercises.json` without adding it here turns this
 * red instead, which is the only reason the mapping is safe to hand-maintain.
 *
 * It reads the real `exercises.json` rather than a fixture on purpose: a
 * fixture would only ever assert that the map covers the values someone
 * remembered to put in the fixture.
 */

const catalog = require('../../../../backend/internal/modules/exercise/exercises.json') as
  | { exercises?: RawExercise[] }
  | RawExercise[];

type RawExercise = {
  id: string;
  name: string;
  movement_pattern?: string;
  primary_muscles?: string[];
};

const rows: RawExercise[] = Array.isArray(catalog) ? catalog : (catalog.exercises ?? []);

it('the shipped catalog is not empty, or every assertion below is vacuous', () => {
  expect(rows.length).toBeGreaterThan(400);
});

it('every primary muscle in the catalog belongs to a group', () => {
  const unmapped = new Map<string, string[]>();
  for (const r of rows) {
    for (const m of r.primary_muscles ?? []) {
      if (muscleGroupOf(m) === null) {
        unmapped.set(m, [...(unmapped.get(m) ?? []), r.id].slice(0, 3));
      }
    }
  }
  // Named, with examples — "3 unmapped" would send the next person hunting.
  expect(Object.fromEntries(unmapped)).toEqual({});
});

it('every movement pattern in the catalog belongs to a group', () => {
  const unmapped = new Map<string, string[]>();
  for (const r of rows) {
    const p = r.movement_pattern ?? '';
    if (p !== '' && movementGroupOf(p) === null) {
      unmapped.set(p, [...(unmapped.get(p) ?? []), r.id].slice(0, 3));
    }
  }
  expect(Object.fromEntries(unmapped)).toEqual({});
});

it('every group is reachable — none is an empty option', () => {
  // A group nobody can select is worse than a missing one: it looks like a
  // working filter and always answers "nothing matches".
  const muscles = new Set(rows.flatMap((r) => r.primary_muscles ?? []));
  for (const g of MUSCLE_GROUPS) {
    expect({ group: g.key, hit: g.muscles.some((m) => muscles.has(m)) })
      .toEqual({ group: g.key, hit: true });
  }
  const patterns = new Set(rows.map((r) => r.movement_pattern ?? ''));
  for (const g of MOVEMENT_GROUPS) {
    expect({ group: g.key, hit: g.patterns.some((p) => patterns.has(p)) })
      .toEqual({ group: g.key, hit: true });
  }
});

it('no raw value is claimed by two groups', () => {
  const check = (name: string, lists: readonly (readonly string[])[]) => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const l of lists) {
      for (const v of l) {
        if (seen.has(v)) dupes.add(v);
        seen.add(v);
      }
    }
    expect({ [name]: [...dupes] }).toEqual({ [name]: [] });
  };
  check('muscle', MUSCLE_GROUPS.map((g) => g.muscles));
  check('pattern', MOVEMENT_GROUPS.map((g) => g.patterns));
});

const ex = (over: Partial<Exercise> = {}): Exercise =>
  ({
    id: 'e1',
    name: 'Bench Press',
    sport: 'strength',
    movement_pattern: 'horizontal_push',
    primary_muscles: ['chest'],
    secondary_muscles: [],
    equipment: [],
    load_type: 'weight_reps',
    is_unilateral: false,
    instructions: '',
    media: [],
    ...over,
  }) as Exercise;

describe('inMuscleGroup', () => {
  test('an empty group matches everything, so "All" needs no special case', () => {
    expect(inMuscleGroup(ex(), '')).toBe(true);
  });

  test('matches on a primary muscle', () => {
    expect(inMuscleGroup(ex({ primary_muscles: ['upper-chest'] }), 'chest')).toBe(true);
    expect(inMuscleGroup(ex({ primary_muscles: ['upper-chest'] }), 'back')).toBe(false);
  });

  test('ignores secondary muscles', () => {
    // Almost everything works almost everything secondarily. Counting them
    // makes "Chest" return most of the catalog and the filter stops meaning
    // anything.
    const pullUp = ex({ primary_muscles: ['lats'], secondary_muscles: ['chest', 'biceps'] });
    expect(inMuscleGroup(pullUp, 'chest')).toBe(false);
    expect(inMuscleGroup(pullUp, 'back')).toBe(true);
  });

  test('an exercise with several primaries appears under each', () => {
    const deadlift = ex({ primary_muscles: ['hamstrings', 'glutes'] });
    expect(inMuscleGroup(deadlift, 'legs')).toBe(true);
    expect(inMuscleGroup(deadlift, 'glutes')).toBe(true);
  });
});

describe('inMovementGroup', () => {
  test('folds horizontal and vertical into one push', () => {
    expect(inMovementGroup(ex({ movement_pattern: 'horizontal_push' }), 'push')).toBe(true);
    expect(inMovementGroup(ex({ movement_pattern: 'vertical_push' }), 'push')).toBe(true);
    expect(inMovementGroup(ex({ movement_pattern: 'horizontal_pull' }), 'push')).toBe(false);
  });

  test('an empty group matches everything', () => {
    expect(inMovementGroup(ex(), '')).toBe(true);
  });

  test('an unmapped pattern matches no group rather than every group', () => {
    // The safe direction: a new pattern shows up unfiltered in "All" instead
    // of contaminating whichever group happened to be selected.
    expect(inMovementGroup(ex({ movement_pattern: 'kite_flying' }), 'push')).toBe(false);
    expect(inMovementGroup(ex({ movement_pattern: 'kite_flying' }), '')).toBe(true);
  });
});
