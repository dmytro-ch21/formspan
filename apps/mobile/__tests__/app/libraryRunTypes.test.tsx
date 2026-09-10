import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import LibraryScreen from '../../app/library';
import type { Module } from '@/lib/modules';
import type { Exercise } from '@/lib/exercises';

/**
 * Run types in the Library — N534 (#965).
 *
 * `lib/__tests__/runTypes.test.ts` pins the CATALOG's own invariants. This
 * file pins the three things that only exist once the screen renders, each of
 * which fails silently:
 *
 *  1. **The gate.** Runs are shown on the `runs` catalog capability, never on
 *     `key === 'running'`. A registry that stopped declaring it, or a client
 *     comparing keys instead, both produce a Library with no running content
 *     and no error anywhere.
 *  2. **The sport filter.** Runs follow the same rule techniques do — visible
 *     under "All" and under their own sport, hidden under someone else's. The
 *     chip is persisted, so an athlete whose last visit left it on Strength
 *     would otherwise open this screen to a running catalog that is silently
 *     absent.
 *  3. **The merge.** Runs are folded into the already-merged exercise +
 *     technique list by a SECOND linear pass, and a merge that drops or
 *     misorders rows still renders a plausible-looking list. The interleaving
 *     assertion below is the only thing that would catch it.
 */
jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(() => {
        const cleanup = cb();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    Stack: { Screen: () => null },
  };
});

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));

/**
 * One exercise, named to land in the MIDDLE of the run types alphabetically —
 * between "Hill repeats" and "Long run". A fixture named "Bench press" would
 * sort before every run and let a merge that simply concatenated its two
 * inputs pass.
 */
const KETTLEBELL: Exercise = {
  id: 'kb-swing',
  name: 'Kettlebell swing',
  sport: 'strength',
  movement_pattern: 'hinge',
  primary_muscles: [],
  secondary_muscles: [],
  equipment: [],
  load_type: 'weight_reps',
  is_unilateral: false,
  load_mode: 'total',
  implements: 1,
  instructions: '',
  media: [],
} as unknown as Exercise;

let mockExercises: Exercise[] = [];
jest.mock('@/lib/positions', () => ({
  ...jest.requireActual('@/lib/positions'),
  fetchPositions: jest.fn(async () => []),
}));
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(async () => []),
  fetchRulesets: jest.fn(async () => new Map()),
}));
jest.mock('@/lib/exercises', () => ({
  ...jest.requireActual('@/lib/exercises'),
  fetchExercises: jest.fn(async () => mockExercises),
}));
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  listCurricula: jest.fn(async () => []),
}));
jest.mock('@/lib/bjj', () => ({
  ...jest.requireActual('@/lib/bjj'),
  getStanding: jest.fn(async () => null),
}));
jest.mock('@/lib/sessionStore', () => ({
  cachedExercises: jest.fn(async () => mockExercises),
  cacheExercises: jest.fn(async () => {}),
}));
const mockReadPref = jest.fn((..._a: unknown[]): Promise<string | null> => Promise.resolve(null));
jest.mock('@/lib/prefs', () => ({
  ...jest.requireActual('@/lib/prefs'),
  readPref: (...a: unknown[]) => mockReadPref(...a),
  writePref: jest.fn(async () => {}),
}));
jest.mock('@/lib/useAuthToken', () => {
  const stable = async () => 't';
  return { useAuthToken: () => stable };
});

/**
 * The registry shape that matters, not a `key === 'running'` stand-in:
 * `capabilities.catalog` carrying `runs` is exactly what `moduleWithCatalog`
 * reads on the screen.
 */
const RUNNING_ON: Module = {
  key: 'running',
  label: 'Running',
  is_sport: true,
  default_on: false,
  enabled: true,
  capabilities: {
    catalog: 'runs',
    facets: ['focus'],
    has_goals: false,
    has_progression: false,
    has_food_log: false,
    record_kinds: ['longest_time', 'furthest_distance'],
  },
};
const STRENGTH_ON: Module = {
  key: 'strength',
  label: 'Strength',
  is_sport: true,
  default_on: true,
  enabled: true,
  capabilities: {
    catalog: 'exercises',
    facets: [],
    has_goals: false,
    has_progression: true,
    has_food_log: false,
    record_kinds: [],
  },
};

let mockModules: Module[] = [RUNNING_ON];
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true }),
}));

beforeEach(() => {
  mockPush.mockClear();
  mockExercises = [];
  mockModules = [RUNNING_ON];
  mockReadPref.mockImplementation(() => Promise.resolve(null));
});

describe('when running is on', () => {
  it('lists the run types', async () => {
    await render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('run-type-easy')).toBeTruthy());
    expect(screen.getByTestId('run-type-long')).toBeTruthy();
    expect(screen.getByTestId('run-type-tempo')).toBeTruthy();
  });

  it('says what a run trains and how hard, without needing a heart-rate strap', async () => {
    await render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('run-type-tempo')).toBeTruthy());
    // The meta line is the whole reason the row is worth more than its name.
    expect(screen.getByText('Threshold · Zones 3-4')).toBeTruthy();
  });

  it('opens the run type when tapped', async () => {
    await render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('run-type-long')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('run-type-long'));
    expect(mockPush).toHaveBeenCalledWith('/run-type/long');
  });
});

describe('when running is off', () => {
  it('shows no run types at all', async () => {
    mockModules = [STRENGTH_ON];
    mockExercises = [KETTLEBELL];
    await render(<LibraryScreen />);
    // Wait for something that DOES render, so this is not asserting against a
    // screen that simply has not finished loading — the shape of absence-is-
    // not-evidence that would make this test pass on a broken screen.
    await waitFor(() => expect(screen.getByTestId('exercise-kb-swing')).toBeTruthy());
    expect(screen.queryByTestId('run-type-easy')).toBeNull();
    expect(screen.queryByTestId('run-type-tempo')).toBeNull();
  });
});

describe('the sport filter', () => {
  it('hides runs when the chip is on another sport', async () => {
    mockModules = [RUNNING_ON, STRENGTH_ON];
    mockExercises = [KETTLEBELL];
    // The chip is persisted, so this is the state an athlete actually returns
    // to rather than a synthetic one.
    mockReadPref.mockImplementation((_u: unknown, key: unknown) =>
      Promise.resolve(String(key).includes('sport') ? 'strength' : null),
    );
    await render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('exercise-kb-swing')).toBeTruthy());
    expect(screen.queryByTestId('run-type-easy')).toBeNull();
  });
});

describe('the focus filter', () => {
  it('narrows the list to one focus, and does not touch the others', async () => {
    await render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('run-type-easy')).toBeTruthy());

    // The Focus control only exists under the Running chip — `usesFacet` keys
    // on the SELECTED sport, exactly as muscle/movement do for strength. Under
    // "All" there is deliberately no control, so the chip comes first.
    await fireEvent.press(screen.getByTestId('library-filter-running'));
    await fireEvent.press(await screen.findByTestId('library-facet-focus'));
    await fireEvent.press(await screen.findByTestId('library-option-focus-Speed'));

    await waitFor(() => expect(screen.queryByTestId('run-type-easy')).toBeNull());
    // Speed is strides and sprints; everything else must be gone, and both of
    // those must remain — a filter that emptied the list entirely would pass a
    // test that only asserted the excluded rows had disappeared.
    expect(screen.getByTestId('run-type-strides')).toBeTruthy();
    expect(screen.getByTestId('run-type-sprints')).toBeTruthy();
    expect(screen.queryByTestId('run-type-long')).toBeNull();
  });
});

describe('the merge', () => {
  it('interleaves runs with exercises alphabetically rather than appending them', async () => {
    mockModules = [RUNNING_ON, STRENGTH_ON];
    mockExercises = [KETTLEBELL];
    await render(<LibraryScreen />);
    // Waits on the EXERCISE, not on a run — and the difference is the whole
    // apparatus. Run types come from a local constant and are on screen in the
    // first render; exercises arrive from a promise. Waiting for a run row
    // therefore proves nothing about whether the exercises have landed yet,
    // and this assertion ran against a runs-only list until that was fixed.
    await waitFor(() => expect(screen.getByTestId('exercise-kb-swing')).toBeTruthy());

    // "Kettlebell swing" sorts between "Hill repeats" and "Long run". A merge
    // that concatenated instead of interleaving would put it either before
    // every run or after every run, and both would pass a test that only
    // asserted the rows are present.
    const order = screen
      .getAllByTestId(/^(run-type|exercise)-/)
      .map((n) => String(n.props.testID));
    const hills = order.indexOf('run-type-hills');
    const kb = order.indexOf('exercise-kb-swing');
    const long = order.indexOf('run-type-long');

    expect(hills).toBeGreaterThanOrEqual(0);
    expect(kb).toBeGreaterThanOrEqual(0);
    expect(long).toBeGreaterThanOrEqual(0);
    expect(hills).toBeLessThan(kb);
    expect(kb).toBeLessThan(long);
  });
});
