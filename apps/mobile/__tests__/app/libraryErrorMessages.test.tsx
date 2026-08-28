import { configure, render, screen, waitFor } from '@testing-library/react-native';

import LibraryScreen from '../../app/library';
import { ApiError } from '@/lib/apiError';

/**
 * N62 — the Library's own `describeError` used to grep the error MESSAGE for
 * the literal substring `(401)`, and that only ever matched because the old
 * `fetchExercises` hand-rolled exactly that string into a bare `Error`
 * (`Couldn't load exercises (401).`). Once it goes through `apiRequest` and
 * throws `ApiError`, the server's own message never contains "(401)" — so
 * the regex stops matching silently, and an athlete with an expired session
 * would see whatever the server's own text is instead of "Your session
 * expired. Sign in again."
 *
 * This was untested before the migration (nothing here asserted on this
 * message at all), which is exactly how it would have shipped broken.
 */
jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
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

const mockFetchExercises = jest.fn();
jest.mock('@/lib/exercises', () => ({
  ...jest.requireActual('@/lib/exercises'),
  fetchExercises: (...a: unknown[]) => mockFetchExercises(...a),
}));

jest.mock('@/lib/positions', () => ({
  ...jest.requireActual('@/lib/positions'),
  fetchPositions: jest.fn(async () => []),
}));
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(async () => []),
  fetchRulesets: jest.fn(async () => new Map()),
}));
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  listCurricula: jest.fn(async () => []),
}));
jest.mock('@/lib/bjj', () => ({
  ...jest.requireActual('@/lib/bjj'),
  getStanding: jest.fn(async () => null),
}));
// Empty, deliberately: a non-empty cache short-circuits `load`'s error path
// (`showedCache` stays true and the catch returns early), which would make
// every case below pass without ever reaching `describeError`.
jest.mock('@/lib/sessionStore', () => ({
  cachedExercises: jest.fn(async () => []),
  cacheExercises: jest.fn(async () => {}),
}));
jest.mock('@/lib/prefs', () => ({
  ...jest.requireActual('@/lib/prefs'),
  readPref: jest.fn(async () => null),
  writePref: jest.fn(async () => {}),
}));
jest.mock('@/lib/useAuthToken', () => {
  const stable = async () => 't';
  return { useAuthToken: () => stable };
});
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({
    modules: [
      {
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
      },
    ],
    ready: true,
  }),
}));

beforeEach(() => {
  mockFetchExercises.mockReset();
});

describe("describeError, on the catalog fetch's own failure", () => {
  it('reads the expired session off the STATUS, not the message text', async () => {
    mockFetchExercises.mockRejectedValue(new ApiError('unauthorized', 'unauthorized', 401));
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-error')).toBeTruthy());
    expect(screen.getByTestId('library-error')).toHaveTextContent(
      'Your session expired. Sign in again.',
    );
  });

  /**
   * The regression this guards. Before N62, this exact rejection would have
   * rendered the server's own message VERBATIM — no "(401)" substring in it
   * anywhere — because it is not the string the old regex was written
   * against.
   */
  it('does not depend on the message containing the literal "(401)"', async () => {
    mockFetchExercises.mockRejectedValue(
      new ApiError('Your Clerk session has expired', 'unauthorized', 401),
    );
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-error')).toBeTruthy());
    expect(screen.getByTestId('library-error')).toHaveTextContent(
      'Your session expired. Sign in again.',
    );
  });

  it('shows the server message as-is for a different status, not the expired-session copy', async () => {
    mockFetchExercises.mockRejectedValue(new ApiError('catalog unavailable', 'internal', 500));
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-error')).toBeTruthy());
    expect(screen.getByTestId('library-error')).toHaveTextContent('catalog unavailable');
    expect(screen.getByTestId('library-error')).not.toHaveTextContent('session expired');
  });
});
