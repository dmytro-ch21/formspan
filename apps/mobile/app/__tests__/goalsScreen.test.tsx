import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import GoalsScreen from '../(tabs)/goals';
import { saveTarget, suggestedTarget } from '@/lib/nutritionApi';

/**
 * The Goals tab, and the two things that broke when it stopped being a pushed
 * screen (N70).
 *
 * `app/food/target.tsx` was opened from Food, so it REMOUNTED on every visit:
 * the fetch ran, the arithmetic ladder was current, and the day it saves
 * against was evaluated afresh. A tab mounts once, lazily, and then stays
 * mounted for the life of the process. Neither symptom is visible in a diff and
 * neither is reachable by a test that renders the screen once — they both need
 * a second visit, which is exactly why review found them and the suite did not.
 *
 * These are component tests rather than pure ones because the properties are
 * about LIFECYCLE: what a refocus does, and what a stale receipt is still
 * claiming afterwards. There is nothing pure to extract.
 */

// RNTL's default `asyncUtilTimeout` is ONE SECOND, and this suite needs longer:
// clearing the receipt runs a refetch, a promise resolution and a re-render, and
// on a CI runner that chain exceeded a second. It passed locally at ~1.4s and
// failed on CI, which is the worst way to find out. Six suites here already
// raise it for the same reason, and `jest.config.js`'s `testTimeout: 15_000`
// is what makes ten seconds actually reachable — see F13, where five files
// asked for ten and jest killed them at five.
configure({ asyncUtilTimeout: 10_000 });

jest.mock('@/lib/nutritionApi', () => ({
  suggestedTarget: jest.fn(),
  saveTarget: jest.fn(),
}));

// ONE getter, created once — because that is the real hook's contract, not a
// convenience. `useAuthToken` returns `useCallback(..., [])` and its docstring
// explains why in detail: Clerk's own `getToken` is rebuilt every render, and
// anything depending on it turns a focus fetch into an infinite refetch loop
// that also wipes local state a frame after each load.
//
// A mock handing out a fresh `jest.fn()` per render reintroduces exactly that
// loop inside the test, and the screen then fails for a reason that does not
// exist in the app. It did, before this was fixed.
const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => mockTokenGetter,
}));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', on: '#000' }),
}));

// The focus effect is the subject, so it is driven by hand rather than mocked
// away: `refocus()` runs the callback again the way returning to a tab does.
let refocus: () => void = () => {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  // Keyed on the CALLBACK, not on []. React Navigation re-runs a focus effect
  // when its callback identity changes while the screen is focused, and the
  // screen relies on exactly that: `load` changes with the activity, so moving
  // a pill refetches through this path rather than through a second effect.
  // Pinned to [] this mock silently models a different hook, and the test fails
  // against correct code — which is what it did first.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const react = jest.requireActual('react') as typeof import('react');
    react.useEffect(() => {
      refocus = () => {
        cb();
      };
      return cb();
    }, [cb]);
  },
}));

const mockSuggested = suggestedTarget as jest.MockedFunction<typeof suggestedTarget>;
const mockSave = saveTarget as jest.MockedFunction<typeof saveTarget>;

function suggestion(kcal: number) {
  return {
    suggestion: {
      kcal,
      protein_g: 150,
      carb_g: 300,
      fat_g: 70,
      fibre_g: 30,
      basis: {
        rmr_kcal: 1700,
        rmr_precision: 'estimated',
        activity_factor: 1.35,
        training_kcal: 300,
        phase_delta_kcal: -400,
        weight_kg: 80,
        projection: null,
      },
    },
    missing: [],
  } as unknown as Awaited<ReturnType<typeof suggestedTarget>>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSuggested.mockResolvedValue(suggestion(2400));
  mockSave.mockResolvedValue(undefined as never);
});

describe('the Goals tab refetches when it is focused again', () => {
  // A tab mounts once and stays mounted. Without a focus refetch the ladder
  // keeps describing the weight, training load and phase it read the first time
  // the tab was ever opened — including after the athlete changes their phase
  // from a button on this very screen.
  it('asks again on every focus, not only on mount', async () => {
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(1));

    refocus();
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));
  });
});

describe('the saved receipt', () => {
  it('appears when a target is accepted', async () => {
    render(<GoalsScreen />);
    const accept = await screen.findByTestId('target-accept');
    fireEvent.press(accept);

    expect(await screen.findByTestId('target-saved')).toBeTruthy();
  });

  // The receipt belongs to the numbers that were saved. Moving an activity pill
  // produces a fresh and UNSAVED suggestion, and leaving "Saved" underneath it
  // attaches a confirmation to something that was never stored — worse than
  // showing nothing, because the athlete has no reason to doubt it.
  it('goes away when the suggestion is replaced by a fresh one', async () => {
    render(<GoalsScreen />);
    fireEvent.press(await screen.findByTestId('target-accept'));
    expect(await screen.findByTestId('target-saved')).toBeTruthy();

    mockSuggested.mockResolvedValue(suggestion(2100));
    fireEvent.press(screen.getByTestId('target-activity-active'));

    // Sequenced in two steps rather than one, because they fail for different
    // reasons and a single `waitFor` cannot say which happened: the refetch not
    // firing at all, or firing and not clearing the receipt. The first version
    // asserted only the second and went red on CI while passing locally — the
    // race was invisible because the machine was fast enough to hide it.
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('target-saved')).toBeNull());
  });

  // The same rule through the other door: coming back to the tab re-asks, so
  // whatever is on screen is unsaved again.
  it('goes away when the tab is focused again', async () => {
    render(<GoalsScreen />);
    fireEvent.press(await screen.findByTestId('target-accept'));
    expect(await screen.findByTestId('target-saved')).toBeTruthy();

    refocus();
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('target-saved')).toBeNull());
  });
});
