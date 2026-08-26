import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import FoodScreen from '../(tabs)/food';
import { RemainingBlock } from '@/components/food/RemainingBlock';
import type { Module } from '@/lib/modules';
import { TABS, offBar } from '@/lib/tabs';

/**
 * N180 / #585 — the daily target, two taps from anywhere.
 *
 * The user carried the N176 bar on their own phone and reversed it: food is the
 * highest-frequency action in the product and it had no permanent entry point,
 * while the target it is measured against was three taps down a screen most
 * athletes never opened.
 *
 * **"Two taps" is a claim about a PATH, so this file tests the path and not a
 * component.** Tap one is the Food tab, which only exists if `lib/tabs.ts` puts
 * it in the bar; tap two is the row, which only works if it renders and
 * navigates. Testing `TargetRow` in isolation would prove the row draws and
 * prove nothing about whether an athlete can get to it — and that is precisely
 * the failure #583 shipped, a prop whose state no code path could construct,
 * green forever because its test built the state by hand.
 *
 * So the first `describe` asserts the tab exists as a real bar slot rather than
 * mocking that away, and the rest render the actual screen.
 *
 * Scoped to the target row and its reachability. The day stepper, the meal
 * slots, the remaining figures and the module-off notice are not this file's
 * business — `foodScreenModuleOff.test.tsx` and `nutrition.test.ts` own those.
 */

const mockPush = jest.fn();
const mockFocusCbs: (() => void | (() => void))[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  // Keyed on the callback, matching React Navigation — the same shape
  // `foodScreenModuleOff.test.tsx` uses, and for the same reason: a focus
  // effect re-runs when its callback identity changes while focused.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const react = jest.requireActual('react') as typeof import('react');
    react.useEffect(() => {
      mockFocusCbs.push(cb);
      const cleanup = cb();
      return () => {
        const i = mockFocusCbs.indexOf(cb);
        if (i >= 0) mockFocusCbs.splice(i, 1);
        if (cleanup) cleanup();
      };
    }, [cb]);
  },
}));

/**
 * The target the fake server holds, swapped per test.
 *
 * `null` means "answered, and no target covers this day" — the `none` state.
 * A rejection means the ask itself failed, which is what produces `unknown`.
 */
const serverTarget: { current: unknown[] | 'fails' } = { current: [] };
const localTarget: { current: { state: string; target?: unknown } } = { current: { state: 'unknown' } };

jest.mock('@/lib/foodLog', () => ({
  localEntries: jest.fn(async () => []),
  localTargetView: jest.fn(async () => localTarget.current),
  cacheTargets: jest.fn(async () => {}),
  removeEntry: jest.fn(async () => {}),
}));

jest.mock('@/lib/nutritionApi', () => ({
  listTargets: jest.fn(async () => {
    if (serverTarget.current === 'fails') throw new Error('offline');
    return serverTarget.current;
  }),
  // NOT a stub: `targetOn` is the "newest row on or before this day" rule, and
  // mocking it would supply the behaviour rather than exercise it.
  targetOn: jest.requireActual('@/lib/nutritionApi').targetOn,
}));

// ONE getter, created once — the real hook returns `useCallback(..., [])`, and
// a fresh `jest.fn()` per render turns a focus fetch into a refetch loop that
// does not exist in the app.
const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'user_1' }) }));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#B8FF2C', ink: '#B8FF2C', on: '#0B0F16' }),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  useSyncState: () => ({ lastSyncAt: null }),
}));

jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric', unitsReady: true }) }));

// ONE object, created once — the real `useTrackerDay` memoises and the screen's
// focus effect depends on its `refresh`. A mock handing out a fresh object per
// render re-runs that effect forever; measured elsewhere as a 15s timeout that
// reads as a hang in the screen and is entirely the mock's doing.
const mockTrackerDay = {
  view: { state: 'ready', trackers: [] },
  entriesFor: () => [],
  refresh: () => () => {},
  addTap: jest.fn(async () => {}),
  removeEntry: jest.fn(async () => {}),
  openSettings: jest.fn(),
};
jest.mock('@/lib/useTrackerDay', () => ({ useTrackerDay: () => mockTrackerDay }));

const mockUseModules = jest.fn(() => ({
  modules: [] as Module[],
  ready: true,
  stale: false,
  apply: jest.fn(),
}));
jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => mockUseModules() }));

function nutrition(enabled: boolean): Module {
  return {
    key: 'nutrition',
    label: 'Nutrition',
    is_sport: false,
    default_on: true,
    enabled,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: true,
      record_kinds: [],
    },
  } as Module;
}

function withModules(modules: Module[], ready = true) {
  mockUseModules.mockReturnValue({ modules, ready, stale: false, apply: jest.fn() });
}

/** A stored target as the API hands it back. */
function target(kcal: number) {
  return {
    effective_on: '2020-01-01',
    kcal,
    protein_g: 180,
    carb_g: 300,
    fat_g: 80,
    fibre_g: 30,
    source: 'manual',
  };
}

/** Let the screen's local-then-network target chain settle. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocusCbs.length = 0;
  mockPush.mockClear();
  serverTarget.current = [];
  localTarget.current = { state: 'unknown' };
  withModules([nutrition(true)]);
});

/**
 * **Tap one.** The row is worth nothing if the screen holding it is not on the
 * bar — which was the entire complaint. Read from `lib/tabs.ts` rather than
 * mocked, so this fails if a later ticket takes the slot away again.
 */
describe('tap one — Food is a bar slot', () => {
  it('holds a button in the tab bar', () => {
    expect(TABS.map((t) => t.name)).toContain('food');
    expect(offBar('food')).toBe(false);
  });
});

describe('tap two — the target row', () => {
  it('shows the number without opening anything', async () => {
    serverTarget.current = [target(2700)];
    render(<FoodScreen />);
    await settle();

    // The grouped form, because that is what an athlete reads on the screen —
    // asserting `2700` would pass against a row that renders it ungrouped and
    // therefore differently from every other figure in this feature.
    expect(screen.getByTestId('food-target-value')).toHaveTextContent('2,700 kcal');
  });

  it('reaches the derivation in one tap from there', async () => {
    serverTarget.current = [target(2700)];
    render(<FoodScreen />);
    await settle();

    fireEvent.press(screen.getByTestId('food-target'));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/goals');
  });

  // **The assertion the ticket asks for, stated as the property it is about.**
  // It fails when the row is removed — which is the whole point of it — and it
  // is written against the testID and the press together, so deleting either
  // half of the row breaks it rather than leaving a green test over a screen
  // with no way to the target.
  it('is gone, and unreachable, if the row is removed', async () => {
    serverTarget.current = [target(2700)];
    render(<FoodScreen />);
    await settle();

    const row = screen.getByTestId('food-target');
    expect(row).toBeTruthy();
    fireEvent.press(row);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/goals');
  });

  it('does not print the target twice on one screen', async () => {
    // `RemainingBlock`'s caption is suppressed on this screen because the row
    // above states the same number. Both are driven by one `TargetView`, so
    // they cannot disagree — they can only be redundant, which reads as a bug
    // in the figure rather than in the layout.
    serverTarget.current = [target(2700)];
    render(<FoodScreen />);
    await settle();

    expect(screen.queryByTestId('fuel-target')).toBeNull();
    // …and the block itself is still there, or the assertion above would be
    // satisfied by the whole summary having gone missing.
    expect(screen.getByTestId('food-remaining')).toBeTruthy();
  });
});

/**
 * The four states of {@link TargetView}, each reached by a real path through
 * the screen rather than constructed by hand.
 *
 * That is the discipline #583 paid for: it shipped a prop whose state no code
 * path could produce, and the test asserting its copy had been vacuously green
 * for as long as it existed. Every case below drives the screen's own fetch
 * chain — a different server answer, a different cache answer — so a state that
 * stopped being reachable would fail here instead of passing quietly.
 */
describe('every state it renders is one the screen can actually reach', () => {
  it('says so while the first read is still in flight', async () => {
    // Asserted BEFORE `settle()` — this is the state before either read
    // resolves, which is what the screen initialises `dated` to and returns to
    // on every day step.
    serverTarget.current = [target(2700)];
    render(<FoodScreen />);

    expect(screen.getByTestId('food-target-value')).toHaveTextContent('Checking…');

    // Settled afterwards anyway, or the in-flight reads land after teardown as
    // un-acted updates — console noise that reads like a defect in the screen.
    await settle();
  });

  it('offers to set one when the server says there is none', async () => {
    serverTarget.current = [];
    render(<FoodScreen />);
    await settle();

    expect(screen.getByTestId('food-target-value')).toHaveTextContent('Not set');
  });

  it('never says "not set" when it simply could not ask', async () => {
    // The distinction the whole four-state union exists for. An athlete who set
    // a target on web, standing in a basement, must not be told to go and set
    // one — it is the app being wrong rather than uninformed, and it sends them
    // to redo work they have already done.
    serverTarget.current = 'fails';
    localTarget.current = { state: 'unknown' };
    render(<FoodScreen />);
    await settle();

    const value = screen.getByTestId('food-target-value');
    expect(value).toHaveTextContent('Cannot check from here');
    expect(value).not.toHaveTextContent('Not set');
  });

  it('still shows a cached number when the server cannot be reached', async () => {
    // The other half of that story, and the reason `unknown` is not simply
    // "offline": a cached target is a real answer, so the row states it.
    serverTarget.current = 'fails';
    localTarget.current = { state: 'set', target: target(2450) };
    render(<FoodScreen />);
    await settle();

    expect(screen.getByTestId('food-target-value')).toHaveTextContent('2,450 kcal');
  });
});

/**
 * `showTarget`, both ways.
 *
 * The Food tab turns the caption OFF because its row says the same number
 * louder. Every other surface — Today's `MomentumCard`, `NutritionCard` — has
 * no such row and relies on the caption, so a mutation hard-coding the prop to
 * `false` would take the target off Today entirely and nothing above would
 * notice: the Food-side assertions are all satisfied by a caption that never
 * renders anywhere.
 *
 * Hence both branches, asserted on the component directly. This is the one
 * place in this file that does not go through the screen, deliberately — the
 * default is exercised by callers this file does not render.
 */
describe('the target caption', () => {
  const view = { state: 'set', target: target(2700) } as const;
  const eaten = { state: 'ready', rows: [], totals: { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fibre_g: null } } as const;

  it('is on by default, for the surfaces with no row above them', () => {
    render(<RemainingBlock eaten={eaten} view={view} />);
    expect(screen.getByTestId('fuel-target')).toHaveTextContent('2,700 target');
  });

  it('is off where the caller has already said it', () => {
    render(<RemainingBlock eaten={eaten} view={view} showTarget={false} />);
    expect(screen.queryByTestId('fuel-target')).toBeNull();
    // The figures are untouched — this suppresses one caption, not the block.
    expect(screen.getByTestId('fuel-remaining-kcal')).toBeTruthy();
  });
});

/**
 * The gate that survived N180.
 *
 * Food is back on the bar UNCONDITIONALLY — the slot no longer comes and goes
 * with a server response — so the screen behind it is the only thing that can
 * explain a deployment or account with nutrition turned off. It did that
 * before this ticket and it must still do it: the row is not allowed to render
 * a target, or a "set one" invitation, over a module that is off.
 */
describe('with nutrition turned off', () => {
  it('renders the explanation and no target row at all', async () => {
    withModules([nutrition(false)]);
    render(<FoodScreen />);

    expect(screen.getByTestId('food-disabled')).toBeTruthy();
    expect(screen.queryByTestId('food-target')).toBeNull();
    await settle();
  });

  it('claims nothing before the module set has been read', async () => {
    // An unread list is an unanswered question, not a "no" — and the row must
    // not assert "Not set" from it either.
    withModules([], false);
    render(<FoodScreen />);

    expect(screen.queryByTestId('food-disabled')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('food-target')).toBeTruthy());
    await settle();
  });
});
