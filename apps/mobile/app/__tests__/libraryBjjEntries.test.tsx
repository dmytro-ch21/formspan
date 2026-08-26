import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import LibraryScreen from '../library';
import type { Module } from '@/lib/modules';
import { PREF_LIBRARY_SPORT } from '@/lib/prefs';

/**
 * The Library's own-chains entry — N181 (#586).
 *
 * `Sequences` was a row on the You tab and is here now: MOVED, not copied, so
 * there is exactly one entry point to `/sequence` in the app. That makes this
 * block the app's only route to an athlete's captured chains, and this file
 * exists because of what "only route" costs when the gate is wrong.
 *
 * The gate has three parts and each is asserted separately below, because each
 * one fails silently — a missing entry point produces no error, no red box and
 * no failing typecheck. It produces an athlete who cannot find their chains and
 * reports the feature as missing, which is #414 and, before it, N61.
 *
 *  1. It is gated on the technique MODULE, so a strength-only account does not
 *     get a shelf that can only be empty.
 *  2. It is NOT gated on the sport filter, which is persisted
 *     (`PREF_LIBRARY_SPORT`) — an athlete whose last visit left it on Strength
 *     would otherwise open this screen with the route already gone.
 *  3. It is NOT inside the position glossary, which additionally requires
 *     `positions.length > 0` — a server read. A failed positions fetch must not
 *     take the sequences away with it.
 *
 * Parts 2 and 3 are the two that a reading of the code passes and a test does
 * not: both render perfectly well on a warm, online, unfiltered screen, which
 * is the only state anybody checks by hand.
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
        // The screen memoises its callback; firing on mount is all this file
        // needs, since nothing here is about the refocus cycle.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    Stack: { Screen: () => null },
  };
});

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));

// Every network read this screen makes. They answer with nothing, deliberately:
// the sequences entry must not depend on any of them, and a stub that returned
// content could hide a dependency by satisfying it.
const mockPositions = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/positions', () => ({
  ...jest.requireActual('@/lib/positions'),
  fetchPositions: (...a: unknown[]) => mockPositions(...a),
}));
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(async () => []),
  fetchRulesets: jest.fn(async () => new Map()),
}));
jest.mock('@/lib/exercises', () => ({
  ...jest.requireActual('@/lib/exercises'),
  fetchExercises: jest.fn(async () => []),
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
  cachedExercises: jest.fn(async () => []),
  cacheExercises: jest.fn(async () => {}),
}));
const mockReadPref = jest.fn(
  (..._a: unknown[]): Promise<string | null> => Promise.resolve(null),
);
jest.mock('@/lib/prefs', () => ({
  ...jest.requireActual('@/lib/prefs'),
  readPref: (...a: unknown[]) => mockReadPref(...a),
  writePref: jest.fn(async () => {}),
}));
// A STABLE getter, defined once. `useAuthToken` is a dependency of this
// screen's fetch effects, so a mock that hands out a fresh closure per render
// re-runs them forever — "Maximum update depth exceeded", which reads as a bug
// in the screen and is a bug in the harness. Measured: the naive version loops
// on the very first render.
jest.mock('@/lib/useAuthToken', () => {
  const stable = async () => 't';
  return { useAuthToken: () => stable };
});

/**
 * The module registry, mutable so a test can turn the discipline off.
 *
 * `capabilities.catalog` carrying `techniques` is what `moduleWithCatalog`
 * reads — the same predicate that gates the technique FETCH — so this is the
 * real shape rather than a `key === 'bjj'` stand-in.
 */
const BJJ_ON: Module = {
  key: 'bjj',
  label: 'BJJ',
  is_sport: true,
  default_on: true,
  enabled: true,
  capabilities: {
    catalog: 'techniques',
    facets: ['position'],
    has_goals: false,
    has_progression: true,
    has_food_log: false,
    record_kinds: [],
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
let mockModules: Module[] = [BJJ_ON];
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockPositions.mockReset().mockResolvedValue([]);
  mockReadPref.mockReset().mockResolvedValue(null);
  mockModules = [BJJ_ON];
});

describe('the sequences entry (N181)', () => {
  it('is here, and goes to the chain list', async () => {
    render(<LibraryScreen />);

    fireEvent.press(await screen.findByTestId('library-sequences-link'));
    expect(mockPush).toHaveBeenCalledWith('/sequence');
  });

  it('survives a failed positions fetch', async () => {
    // The gate this asserts is the one a reading of the code cannot check: the
    // position glossary below requires `positions.length > 0`, so putting the
    // sequences row inside it would make a 500 on an unrelated fetch silently
    // remove the app's only route to the athlete's own chains. Rejecting rather
    // than resolving empty, so this is a genuinely failed read.
    mockPositions.mockRejectedValue(new Error('Network request failed'));
    render(<LibraryScreen />);

    expect(await screen.findByTestId('library-sequences-link')).toBeTruthy();
    // And the block it must not be inside really is absent here, or the
    // assertion above would be true for the wrong reason.
    await waitFor(() => expect(screen.queryByText('Start with positions')).toBeNull());
  });

  it('survives a persisted sport filter set to another discipline', async () => {
    // The sport chip is remembered across visits, so "Strength" is not an
    // exotic state — it is whatever the athlete last tapped. Gating this block
    // on `sport` (as the position glossary below it legitimately is) would mean
    // opening the Library and finding the only route to your own chains already
    // gone, with nothing on screen saying why.
    mockModules = [BJJ_ON, STRENGTH_ON];
    mockReadPref.mockImplementation(async (_userId: unknown, key: unknown) =>
      key === PREF_LIBRARY_SPORT ? 'strength' : null,
    );
    render(<LibraryScreen />);

    // WAIT FOR THE FILTER FIRST. The pref is read asynchronously, so the screen
    // renders unfiltered for a tick or two — and asserting the link before that
    // lands measures the unfiltered screen, which every arrangement of this gate
    // passes. Measured: with the ORDER reversed, adding `sport` to the gate
    // survived this test intact.
    await waitFor(() =>
      expect(
        screen.getByTestId('library-filter-strength').props.accessibilityState?.selected,
      ).toBe(true),
    );
    expect(screen.getByTestId('library-sequences-link')).toBeTruthy();
  });

  it('is absent when the discipline that owns it is off', async () => {
    // The arm that makes the others mean something, and the gate itself: a
    // strength-only account has no use for a chain list that can only be empty.
    mockModules = [{ ...BJJ_ON, enabled: false }, STRENGTH_ON];
    render(<LibraryScreen />);

    // Wait for the screen itself before asserting an absence, or this passes
    // against a screen that has not rendered at all.
    await screen.findByTestId('library-screen');
    expect(screen.queryByTestId('library-sequences-link')).toBeNull();
  });
});
