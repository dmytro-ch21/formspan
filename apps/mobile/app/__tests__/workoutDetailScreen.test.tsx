import { render, screen, waitFor } from '@testing-library/react-native';

import WorkoutDetailScreen from '../workout/[id]';
import type { Workout } from '@/lib/workouts';

/**
 * An unpushed local edit must survive the screen refreshing.
 *
 * **These emit "not wrapped in act(...)" warnings, deliberately left alone.**
 * This screen chains its loads — cache, then `getWorkout`, then the exercise
 * catalog for whichever sport that returned — and the tail of that chain
 * resolves while the test body is still running. The fixes for it are worse
 * than the noise: act-wrapping `render` makes every assertion observe the
 * fully-settled state instead of the frame under test, and it collides with
 * RNTL's auto-cleanup ("Can't access .root on unmounted test renderer").
 * Extra flush rounds in shared setup were measured and do not help.
 *
 * So: seven warnings, no hidden failure — the assertions below are
 * mutation-verified, and reverting either fix they cover turns them red.
 *
 * A note on the assertions: the plan's NAME is displayed through
 * `Stack.Screen options={{ title }}`, i.e. the navigation header, which is
 * not rendered under test. So these assert on the "Start a session from
 * <name>" label instead — a real rendered element that derives from the same
 * `workout` state the bug corrupted. Asserting on the header would mean
 * asserting on the mock.
 *
 * The second PR #80 finding that lived only in the render path. The CAS in
 * SQLite correctly refuses to mark a newer edit as sent — and the screen then
 * undid that visually: `getWorkout` resolved and its result was adopted
 * unconditionally, so reopening an offline-edited plan while online, before
 * its push landed, made the edit vanish from the screen. Save went inactive
 * too (it compares against the same copy), and editing on from what was
 * displayed wrote server-derived stale items back over the local row.
 *
 * So the athlete's own work was lost with their unwitting help, while the
 * store was behaving perfectly. No SQLite-level test can see that.
 */

// Typed to accept args so the `(...a) => mock(...a)` forwarding below
// typechecks; a zero-arg jest.fn() rejects a spread call.
const mockCachedWorkouts = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockDirtyWorkoutIDs = jest.fn(
  (..._a: unknown[]): Promise<Set<string>> => Promise.resolve(new Set<string>()),
);
jest.mock('@/lib/sessionStore', () => ({
  cachedWorkouts: (...a: unknown[]) => mockCachedWorkouts(...a),
  dirtyWorkoutIDs: (...a: unknown[]) => mockDirtyWorkoutIDs(...a),
  deleteLocalWorkout: jest.fn(),
  saveLocalWorkoutItems: jest.fn(async () => {}),
  startLocalSession: jest.fn(),
  cacheExercises: jest.fn(async () => {}),
  cachedExercises: jest.fn(async () => []),
}));

const mockGetWorkout = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(null));
jest.mock('@/lib/workouts', () => ({
  ...jest.requireActual('@/lib/workouts'),
  getWorkout: (...a: unknown[]) => mockGetWorkout(...a),
}));

const mockFetchExercises = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/exercises', () => ({
  fetchExercises: (...a: unknown[]) => mockFetchExercises(...a),
}));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));
jest.mock('@/lib/sessions', () => ({
  applySuggestions: jest.fn(),
  fetchSuggestions: jest.fn(async () => new Map()),
  setsFromWorkout: jest.fn(() => []),
}));
jest.mock('@/lib/UnitsProvider', () => ({
  useUnits: () => ({ units: 'metric', unitsReady: true, setUnits: jest.fn(), unsynced: false }),
}));

jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    // The screen reads the workout id from the route.
    useLocalSearchParams: () => ({ id: 'w1' }),
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
    Link: ({ children }: { children: React.ReactNode }) => React.createElement(Text, null, children),
    Stack: { Screen: () => null },
  };
});

const plan = (name: string, over: Partial<Workout> = {}): Workout => ({
  id: 'w1',
  owner_user_id: 'u1',
  name,
  sport: 'strength',
  goal: 'hypertrophy',
  notes: '',
  visibility: 'private',
  items: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  ...over,
});

beforeEach(() => {
  mockFetchExercises.mockClear();
  mockCachedWorkouts.mockReset();
  mockGetWorkout.mockReset();
  mockDirtyWorkoutIDs.mockReset().mockResolvedValue(new Set<string>());
});

it('keeps the LOCAL copy on screen when the local row is dirty', async () => {
  // The edit is on the device and not yet pushed; the server still holds the
  // older name. Adopting the server's copy here is what made the edit vanish.
  mockCachedWorkouts.mockResolvedValue([plan('Edited In The Gym')]);
  mockGetWorkout.mockResolvedValue(plan('Old Server Name'));
  mockDirtyWorkoutIDs.mockResolvedValue(new Set(['w1']));

  render(<WorkoutDetailScreen />);

  await waitFor(() => expect(mockGetWorkout).toHaveBeenCalled());
  expect(await screen.findByLabelText('Start a session from Edited In The Gym')).toBeTruthy();
  expect(screen.queryByLabelText('Start a session from Old Server Name')).toBeNull();
});

it('DOES adopt the server copy when the local row is clean', async () => {
  // The other half, and the reason this cannot just always prefer the cache:
  // with nothing owed, the server is the newer source and an edit made on the
  // web must show up here.
  mockCachedWorkouts.mockResolvedValue([plan('Stale Cached Name')]);
  mockGetWorkout.mockResolvedValue(plan('Fresh From Server'));
  mockDirtyWorkoutIDs.mockResolvedValue(new Set<string>());

  render(<WorkoutDetailScreen />);

  expect(await screen.findByLabelText('Start a session from Fresh From Server')).toBeTruthy();
});

it('renders the cached plan before the network answers', async () => {
  // Offline, the cache IS the answer. A screen that waited for the network
  // would dead-end on an editable plan you cannot open.
  mockCachedWorkouts.mockResolvedValue([plan('Cached Plan')]);
  mockGetWorkout.mockRejectedValue(new Error('Network request failed'));

  render(<WorkoutDetailScreen />);

  expect(await screen.findByLabelText('Start a session from Cached Plan')).toBeTruthy();
});

it('does not treat a failed refresh as an error when a cached copy is showing', async () => {
  // Failing to refresh with something on screen is an ordinary offline state,
  // not a failure worth a red message over the athlete's plan.
  mockCachedWorkouts.mockResolvedValue([plan('Cached Plan')]);
  mockGetWorkout.mockRejectedValue(new Error('Network request failed'));

  render(<WorkoutDetailScreen />);

  await screen.findByLabelText('Start a session from Cached Plan');
  expect(screen.queryByText(/Network request failed/)).toBeNull();
});
