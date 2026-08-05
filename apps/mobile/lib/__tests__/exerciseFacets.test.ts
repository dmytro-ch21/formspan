import {
  ISOLATION_PULL,
  ISOLATION_PUSH,
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

const additions = require('../../../../backend/internal/modules/exercise/exercises.additions.json') as
  | { exercises?: RawExercise[] }
  | RawExercise[];

/**
 * Both catalog files, not just the seed one.
 *
 * `exercises.additions.json` is where `cmd/exportcontent` writes anything
 * authored in the admin console — i.e. it is the file that actually produces
 * NEW vocabulary. Reading only the seed meant the coverage test watched the
 * door new values do not come through. It is `[]` today, which is exactly when
 * it is cheap to wire up.
 */
const rows: RawExercise[] = [
  ...(Array.isArray(catalog) ? catalog : (catalog.exercises ?? [])),
  ...(Array.isArray(additions) ? additions : (additions.exercises ?? [])),
];

/**
 * The API's closed vocabulary for `movement_pattern`, mirrored from
 * `backend/internal/modules/exercise/seed.go`'s `validMovementPatterns`.
 *
 * The rows-based test below has a blind spot review found: its oracle is what
 * SHIPS, so a legal-but-unused value is invisible to it — `grappling` was
 * exactly that, accepted by the API and mapped by nothing. Asserting the
 * vocabulary as well as the rows closes it. Hand-mirrored, so it can drift;
 * the mirror failing loudly is better than the silence it replaces.
 */
const API_MOVEMENT_PATTERNS = [
  'squat', 'hinge', 'lunge',
  'horizontal_push', 'vertical_push',
  'horizontal_pull', 'vertical_pull',
  'carry', 'core', 'rotation',
  'locomotion', 'grappling', 'olympic',
  'jump', 'mobility', 'isolation',
];

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

it('every movement pattern the API ACCEPTS belongs to a group, not just the shipped ones', () => {
  // The catalog is not the contract. `grappling` was legal, unused, and
  // unmapped — so the first console-authored exercise using it would have been
  // silently unreachable through the filter, which is the exact failure this
  // suite exists to prevent, arriving through the door it was not watching.
  const unmapped = API_MOVEMENT_PATTERNS.filter((p) => movementGroupOf(p) === null);
  expect(unmapped).toEqual([]);
});

it('every group is reachable — none is an empty option', () => {
  // A group nobody can select is worse than a missing one: it looks like a
  // working filter and always answers "nothing matches".
  const muscles = new Set(rows.flatMap((r) => r.primary_muscles ?? []));
  for (const g of MUSCLE_GROUPS) {
    expect({ group: g.key, hit: g.muscles.some((m) => muscles.has(m)) })
      .toEqual({ group: g.key, hit: true });
  }
  // Against the API vocabulary, not the shipped rows: `grappling` is legal and
  // currently unused, so a rows-only check would call Conditioning unreachable
  // for mapping it. The property that matters is that no group is composed
  // entirely of values the API would reject.
  const patterns = new Set(API_MOVEMENT_PATTERNS);
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

describe('isolation work answers push and pull too', () => {
  // `movement_pattern` is single-valued and `isolation` is 142 of 504 rows, so
  // taken literally "Pull" returned no biceps curl. That is the data being
  // faithful and the filter being useless.
  const iso = (muscles: string[]) =>
    ex({ movement_pattern: 'isolation', primary_muscles: muscles });

  test('a curl is a pull, and still an isolation', () => {
    expect(inMovementGroup(iso(['biceps']), 'pull')).toBe(true);
    expect(inMovementGroup(iso(['biceps']), 'isolation')).toBe(true);
    expect(inMovementGroup(iso(['biceps']), 'push')).toBe(false);
  });

  test('a triceps extension and a lateral raise are pushes', () => {
    expect(inMovementGroup(iso(['triceps']), 'push')).toBe(true);
    // Abduction, strictly neither — it is in Push because that is the day it
    // is programmed on. A convention, and the comment says so.
    expect(inMovementGroup(iso(['lateral-delts']), 'push')).toBe(true);
    expect(inMovementGroup(iso(['rear-delts']), 'pull')).toBe(true);
  });

  test('leg and core isolation joins neither, rather than being forced into one', () => {
    for (const m of ['quadriceps', 'hamstrings', 'calves', 'abdominals', 'forearms']) {
      expect({ m, push: inMovementGroup(iso([m]), 'push'), pull: inMovementGroup(iso([m]), 'pull') })
        .toEqual({ m, push: false, pull: false });
    }
    // Still reachable — through Isolation, and through its muscle group.
    expect(inMovementGroup(iso(['quadriceps']), 'isolation')).toBe(true);
    expect(inMuscleGroup(iso(['quadriceps']), 'legs')).toBe(true);
  });

  test('ONLY isolation gets the derivation — a mobility drill is not a pull', () => {
    const mob = ex({ movement_pattern: 'mobility', primary_muscles: ['biceps'] });
    expect(inMovementGroup(mob, 'pull')).toBe(false);
    expect(inMovementGroup(mob, 'mobility')).toBe(true);
  });

  test('a compound press is not also an isolation', () => {
    // Only the second assertion carries this. `ex()` defaults to
    // primary_muscles ['chest'], which IS in ISOLATION_PUSH, so a "push → true"
    // assertion here passes even with the pattern lookup and the isolation
    // guard both broken. Review caught that; the push case is covered by
    // 'folds horizontal and vertical into one push' above.
    expect(inMovementGroup(ex({ movement_pattern: 'horizontal_push' }), 'isolation')).toBe(false);
  });

  test('a multi-primary isolation row is accepted by every axis it implies', () => {
    // Dumbbell Pullover, one primary in each set. Genuinely ambiguous, and the
    // row that documents `.some()` producing double membership on purpose.
    const pullover = iso(['lats', 'chest']);
    expect(inMovementGroup(pullover, 'pull')).toBe(true);
    expect(inMovementGroup(pullover, 'push')).toBe(true);
  });

  test('a stabiliser recorded as a primary does not drag a core row into Push', () => {
    // Suspension Pike is ['abdominals', 'shoulders']. `.some()` means ONE
    // qualifying muscle is enough, so while the generic `shoulders` was in
    // ISOLATION_PUSH this core exercise appeared under Push. It is out.
    expect(inMovementGroup(iso(['abdominals', 'shoulders']), 'push')).toBe(false);
    expect(inMuscleGroup(iso(['abdominals', 'shoulders']), 'core')).toBe(true);
  });
});

/**
 * The isolation sets, held to the real catalog by NAME.
 *
 * Review mutation-proved the tests above do not cover this: silently deleting
 * `lats`, `upper-traps` or `chest` from a set removed 4-8 real exercises from a
 * facet and the whole suite stayed green — the same "quietly undiscoverable"
 * failure this file exists to catch, reintroduced by the fix for it. Only 4 of
 * the 21 members had any assertion at all.
 *
 * Named rows are a NON-CIRCULAR oracle: the expectation is what a lifter would
 * say, not what the map says. Each of these is a real `isolation` row in the
 * shipped catalog.
 */
describe('the isolation sets, against named rows in the real catalog', () => {
  const find = (name: string) => {
    const r = rows.find((x) => x.name === name);
    if (!r) throw new Error(`catalog has no exercise named ${name} — rename or drop this case`);
    return r;
  };
  const asExercise = (name: string) =>
    ex({
      movement_pattern: find(name).movement_pattern,
      primary_muscles: find(name).primary_muscles ?? [],
    });

  test.each([
    ['Cable Fly', 'push'],
    ['Barbell Curl', 'pull'],
    ['Barbell Shrug', 'pull'],
    ['Straight-Arm Pulldown', 'pull'],
  ])('%s is a %s', (name, group) => {
    expect(inMovementGroup(asExercise(name), group)).toBe(true);
  });

  test('every member of both sets is a real muscle the catalog uses', () => {
    // Without this, `lateral-delt` (singular) is a silent no-op that no other
    // assertion can see — and the excluded-muscle test above would pass for the
    // wrong reason if it named a muscle that does not exist either.
    const unreal = [...ISOLATION_PUSH, ...ISOLATION_PULL].filter((m) => muscleGroupOf(m) === null);
    expect(unreal).toEqual([]);
  });

  test('no muscle is in both isolation sets', () => {
    const both = [...ISOLATION_PUSH].filter((m) => ISOLATION_PULL.has(m));
    expect(both).toEqual([]);
  });
});
