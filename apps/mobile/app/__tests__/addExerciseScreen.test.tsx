import { act, configure, render, screen, waitFor } from '@testing-library/react-native';

import { ApiError, OfflineError } from '@/lib/apiError';

import AddExerciseToSessionScreen from '../session/[id]/add';

/**
 * N62 — `fetchExercises` stopped hand-rolling its failure into a bare `Error`
 * and now throws `ApiError`/a `TransportError` subclass through `apiRequest`.
 *
 * This screen's offline path (`catch { … fall back to the cache }`) is the
 * one caller the ticket names explicitly, because it is doing real work in
 * the catch rather than just displaying a message: a dead network here still
 * has to let the athlete add or swap an exercise from what's cached. Pinned
 * with the NEW error identity rather than a bare `Error`, so a regression
 * that stops catching `ApiError`/`OfflineError` specifically (as opposed to
 * "anything") shows up here.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockFetchExercises = jest.fn();
jest.mock('@/lib/exercises', () => ({
  ...jest.requireActual('@/lib/exercises'),
  fetchExercises: (...a: unknown[]) => mockFetchExercises(...a),
}));

const mockReadLocalSession = jest.fn();
const mockSaveLocalSets = jest.fn();
const mockCachedExercises = jest.fn();
const mockCacheExercises = jest.fn();
jest.mock('@/lib/sessionStore', () => ({
  readLocalSession: (...a: unknown[]) => mockReadLocalSession(...a),
  saveLocalSets: (...a: unknown[]) => mockSaveLocalSets(...a),
  cachedExercises: (...a: unknown[]) => mockCachedExercises(...a),
  cacheExercises: (...a: unknown[]) => mockCacheExercises(...a),
}));

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

let mockParams: Record<string, string> = { id: 'sess-1' };
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
    Stack: { Screen: () => null },
  };
});

const SQUAT = {
  id: 'back-squat',
  name: 'Back Squat',
  sport: 'strength',
  movement_pattern: 'squat',
  primary_muscles: ['quads'],
  secondary_muscles: [],
  equipment: ['barbell'],
  load_type: 'weight_reps',
  is_unilateral: false,
  instructions: '',
  media: [],
};

const BENCH = { ...SQUAT, id: 'bench-press', name: 'Bench Press', movement_pattern: 'push' };

beforeEach(() => {
  mockParams = { id: 'sess-1' };
  mockFetchExercises.mockReset();
  mockReadLocalSession.mockReset().mockResolvedValue({ sport: 'strength', sets: [] });
  mockSaveLocalSets.mockReset().mockResolvedValue(undefined);
  mockCachedExercises.mockReset().mockResolvedValue([]);
  mockCacheExercises.mockReset().mockResolvedValue(undefined);
});

describe('when the catalog cannot be reached', () => {
  /**
   * The case the ticket is about. Deleting this screen's `catch` (or
   * narrowing it to something that no longer matches `ApiError`) is exactly
   * the regression this guards: without it, the request rejects and the
   * screen never falls back to the cache, so `cachedExercises` is never
   * called and the row below is never offered.
   */
  it('falls back to the cache on ApiError, the new error identity', async () => {
    mockFetchExercises.mockRejectedValue(new ApiError('exercise catalog unavailable', 'internal', 500));
    mockCachedExercises.mockResolvedValue([SQUAT, BENCH]);

    render(<AddExerciseToSessionScreen />);

    await waitFor(() => expect(mockCachedExercises).toHaveBeenCalledWith('strength'));
    expect(await screen.findByText('Back Squat')).toBeTruthy();
    expect(screen.getByText('Bench Press')).toBeTruthy();
  });

  /** No answer at all is a different error class than a real rejection; the fallback covers both. */
  it('falls back to the cache on OfflineError too', async () => {
    mockFetchExercises.mockRejectedValue(new OfflineError());
    mockCachedExercises.mockResolvedValue([SQUAT]);

    render(<AddExerciseToSessionScreen />);

    await waitFor(() => expect(mockCachedExercises).toHaveBeenCalledWith('strength'));
    expect(await screen.findByText('Back Squat')).toBeTruthy();
  });

  it('filters the cached fallback by the typed search, same as the live query would', async () => {
    mockFetchExercises.mockRejectedValue(new ApiError('boom', 'internal', 500));
    mockCachedExercises.mockResolvedValue([SQUAT, BENCH]);

    render(<AddExerciseToSessionScreen />);
    await waitFor(() => expect(screen.getByTestId('session-add-search')).toBeTruthy());

    await act(async () => {
      screen.getByTestId('session-add-search').props.onChangeText('bench');
    });

    await waitFor(() => expect(screen.queryByText('Back Squat')).toBeNull());
    expect(await screen.findByText('Bench Press')).toBeTruthy();
  });
});

it('renders the live catalog when the request succeeds', async () => {
  mockFetchExercises.mockResolvedValue([SQUAT]);
  render(<AddExerciseToSessionScreen />);
  expect(await screen.findByText('Back Squat')).toBeTruthy();
  expect(mockCachedExercises).not.toHaveBeenCalled();
});
