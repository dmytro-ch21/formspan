import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
 *
 * **N499/#870 added the tests below the first two.** N474 stopped the
 * screen from auto-starting a planned strength session but left
 * `plannedWorkoutId` referenced nowhere else — the template it names sat as
 * one more undifferentiated row in the full "From a workout" list, so the
 * athlete had to re-find and re-select the workout Plan had already named.
 * The first test's own comment ("the planned workout is in the ordinary
 * list") describes exactly that bug; the fix pulls the planned template out
 * into a distinct, one-tap card carrying the SAME `start-workout-<id>`
 * testID and accessibility label the generic row used, which is why that
 * test still passes unmodified rather than needing to change what it looks
 * for.
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
  // N499/#870: this is now the distinct "Start Squat Day" primary card, not
  // a row in the generic chooser — but it carries the SAME testID the
  // generic row always used, so this assertion (and this test) needed no
  // change when that moved.
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

it('renders a planned strength template as the distinct primary action, not the generic chooser (N499/#870)', async () => {
  const planned = workout({ id: 'w1', sport: 'strength', name: 'Squat Day' });
  const other = workout({ id: 'w3', sport: 'strength', name: 'Bench Day' });
  mockCachedWorkouts.mockResolvedValue([planned, other]);
  mockListWorkouts.mockResolvedValue([planned, other]);
  mockParams = { sport: 'strength', workout: 'w1' };

  render(<StartSessionScreen />);

  await waitFor(() => expect(screen.getByTestId('start-workout-w1')).toBeTruthy());
  // The whole bug report: Plan already named this template, so it must not
  // sit next to every other one in the full chooser — that chooser (and the
  // OTHER workout that isn't today's plan) must not be on screen at all.
  expect(screen.queryByText('From a workout')).toBeNull();
  expect(screen.queryByTestId('start-workout-w3')).toBeNull();
  expect(screen.getByText("Today's plan")).toBeTruthy();
});

it('starts the planned template with the selected intent in one tap — no re-selection, no chooser (N499/#870)', async () => {
  const planned = workout({ id: 'w1', sport: 'strength', name: 'Squat Day' });
  mockCachedWorkouts.mockResolvedValue([planned]);
  mockListWorkouts.mockResolvedValue([planned]);
  mockParams = { sport: 'strength', workout: 'w1' };

  render(<StartSessionScreen />);

  await waitFor(() => expect(screen.getByTestId('start-workout-w1')).toBeTruthy());
  // Mark today as a Light day BEFORE starting — the whole point of the
  // ticket is that this is reachable without re-picking the template.
  fireEvent.press(screen.getByTestId('session-intent-light'));
  fireEvent.press(screen.getByTestId('start-workout-w1'));

  await waitFor(() => expect(mockStartLocalSession).toHaveBeenCalledTimes(1));
  expect(mockStartLocalSession).toHaveBeenCalledWith(
    'u1',
    expect.objectContaining({ workout_id: 'w1', intent: 'light', name: 'Squat Day' }),
  );
  expect(mockReplace).toHaveBeenCalledTimes(1);
});

it('an ad-hoc strength session with no plan still shows the full chooser, unchanged (N499/#870)', async () => {
  const a = workout({ id: 'w4', sport: 'strength', name: 'Push Day' });
  const b = workout({ id: 'w5', sport: 'strength', name: 'Pull Day' });
  mockCachedWorkouts.mockResolvedValue([a, b]);
  mockListWorkouts.mockResolvedValue([a, b]);
  mockParams = { sport: 'strength' }; // no `workout` param at all

  render(<StartSessionScreen />);

  await waitFor(() => expect(screen.getByText('From a workout')).toBeTruthy());
  expect(screen.getByTestId('start-workout-w4')).toBeTruthy();
  expect(screen.getByTestId('start-workout-w5')).toBeTruthy();
  expect(screen.queryByText("Today's plan")).toBeNull();
  expect(mockStartLocalSession).not.toHaveBeenCalled();
});

it('falls through to the generic chooser when the plan points at a template that no longer exists', async () => {
  const other = workout({ id: 'w6', sport: 'strength', name: 'Deadlift Day' });
  mockCachedWorkouts.mockResolvedValue([other]);
  mockListWorkouts.mockResolvedValue([other]);
  // `workout=gone` matches nothing in the loaded list — a plan can outlive
  // the template it points at, since there is no foreign key by design.
  mockParams = { sport: 'strength', workout: 'gone' };

  render(<StartSessionScreen />);

  await waitFor(() => expect(screen.getByText('From a workout')).toBeTruthy());
  expect(screen.getByTestId('start-workout-w6')).toBeTruthy();
  expect(screen.queryByText("Today's plan")).toBeNull();
  expect(mockStartLocalSession).not.toHaveBeenCalled();
});
