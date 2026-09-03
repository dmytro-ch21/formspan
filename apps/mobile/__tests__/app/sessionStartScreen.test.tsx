import { render, screen, waitFor } from '@testing-library/react-native';

import StartSessionScreen from '../../app/session/start';
import type { Workout } from '@/lib/workouts';

/**
 * `/session/start` — N474's own regression, caught in frontend review.
 *
 * The picker this ticket adds sits ABOVE the workout list, but the screen
 * has always auto-started a session the instant a planned `?workout=` param
 * resolves against the loaded list (`autoStarted` in `start.tsx`) — which is
 * exactly the path Today's "start today's session" button takes for a
 * planned strength day. Before the fix this pinned, that effect fired
 * before the picker could ever be touched: the athlete never got a chance
 * to mark a planned deload day as anything but Normal, which is the whole
 * scenario N474 exists for.
 *
 * Everything else about the auto-start (BJJ/running keep it, a template
 * that doesn't match falls through to the chooser) is pre-existing
 * behaviour with no test of its own before this file; this is scoped to
 * the one property N474 changed.
 */

jest.setTimeout(15_000);

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockParams: { sport?: string; workout?: string; date?: string } = {};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  Stack: { Screen: () => null },
}));

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));
const mockGetToken = () => Promise.resolve('tok');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockGetToken }));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ label: 'VOLA', accent: '#D3EC52', ink: '#D3EC52', on: '#080B12' }),
}));
jest.mock('@/lib/UnitsProvider', () => ({
  useUnits: () => ({ units: 'metric', unitsReady: true, setUnits: jest.fn(), unsynced: false }),
}));
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
          has_goals: true,
          has_progression: true,
          has_food_log: false,
          record_kinds: [],
        },
      },
    ],
    ready: true,
  }),
}));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

const mockStartLocalSession = jest.fn();
const mockCachedWorkouts = jest.fn((..._a: unknown[]): Promise<Workout[]> => Promise.resolve([]));
jest.mock('@/lib/sessionStore', () => ({
  cachedWorkouts: (...a: unknown[]) => mockCachedWorkouts(...a),
  cacheWorkouts: jest.fn(),
  cachedExercises: () => Promise.resolve([]),
  startLocalSession: (...a: unknown[]) => mockStartLocalSession(...a),
}));

const mockListWorkouts = jest.fn((..._a: unknown[]): Promise<Workout[]> => Promise.resolve([]));
jest.mock('@/lib/workouts', () => ({
  ...jest.requireActual('@/lib/workouts'),
  listWorkouts: (...a: unknown[]) => mockListWorkouts(...a),
}));

function workout(over: Partial<Workout> & { id: string; sport: Workout['sport'] }): Workout {
  return {
    owner_user_id: 'u1',
    name: 'Push Day',
    goal: null,
    notes: '',
    visibility: 'private',
    // Empty on purpose: begin() only calls fetchSuggestions when there are
    // sets to prescribe, and that path isn't what this file is testing.
    items: [],
    created_at: '',
    updated_at: '',
    ...over,
  };
}

beforeEach(() => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockStartLocalSession.mockReset().mockResolvedValue({ id: 'new-session' });
  mockCachedWorkouts.mockReset().mockResolvedValue([]);
  mockListWorkouts.mockReset().mockResolvedValue([]);
});

it('does NOT auto-start a planned STRENGTH session — the picker must be reachable first', async () => {
  const planned = workout({ id: 'w1', sport: 'strength', name: 'Squat Day' });
  mockCachedWorkouts.mockResolvedValue([planned]);
  mockListWorkouts.mockResolvedValue([planned]);
  mockParams = { sport: 'strength', workout: 'w1' };

  render(<StartSessionScreen />);

  await waitFor(() => expect(screen.getByTestId('session-intent-picker')).toBeTruthy());
  // The planned workout is in the ordinary list, tappable — not started for
  // the athlete without a chance to touch the picker above it.
  await waitFor(() => expect(screen.getByTestId('start-workout-w1')).toBeTruthy());
  expect(mockStartLocalSession).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('still auto-starts a planned BJJ session — only strength gained a picker', async () => {
  const planned = workout({ id: 'w2', sport: 'bjj', name: 'Rolling' });
  mockCachedWorkouts.mockResolvedValue([planned]);
  mockListWorkouts.mockResolvedValue([planned]);
  mockParams = { sport: 'bjj', workout: 'w2' };

  render(<StartSessionScreen />);

  await waitFor(() => expect(mockStartLocalSession).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('session-intent-picker')).toBeNull();
});
