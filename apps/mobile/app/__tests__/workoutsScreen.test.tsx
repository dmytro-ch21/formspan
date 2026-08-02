import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import WorkoutsScreen from '../(tabs)/workouts';
import type { Workout } from '@/lib/workouts';

/**
 * The list must show what is on disk, not what the network last said.
 *
 * This is one of the two PR #80 findings that existed ONLY in the render
 * path. `cacheWorkouts` reconciles correctly — it keeps rows the server has
 * never heard of and drops ones it has deleted — and the screen then threw
 * that away by rendering the raw `listWorkouts` response. A workout created
 * offline vanished the moment a stale list response landed, and came back on
 * the next focus.
 *
 * It was not a race in the unlucky sense: creating a workout fires
 * `requestSync` and this reload together, so the two are always in flight at
 * once. A SQLite-level test could not see any of it, which is exactly why
 * this file exists.
 *
 * The store is mocked here rather than driven through the real fixture on
 * purpose: what is under test is which of two already-correct sources the
 * screen chooses to render. Using the real store would make the assertion
 * depend on reconciliation logic that has its own tests, and a failure could
 * then mean either thing.
 */

/**
 * Jest's 5s default is not enough for the FIRST render in a component file.
 *
 * It is not this test being slow — it is the one-off cost of instantiating the
 * React Native module graph under `jest-expo` before anything can render at
 * all. Locally that first test takes ~0.4s; on a cold CI runner it went past
 * 5s and failed there while passing on every developer machine, which is the
 * worst kind of flake.
 *
 * Raised here rather than globally: the pure-logic suites run in
 * milliseconds, and leaving their timeout at 5s keeps a genuine hang in them
 * failing fast.
 */
jest.setTimeout(30_000);

// Typed to accept args so the `(...a) => mock(...a)` forwarding below
// typechecks; a zero-arg jest.fn() rejects a spread call.
const mockCachedWorkouts = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockCacheWorkouts = jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
jest.mock('@/lib/sessionStore', () => ({
  cachedWorkouts: (...a: unknown[]) => mockCachedWorkouts(...a),
  cacheWorkouts: (...a: unknown[]) => mockCacheWorkouts(...a),
  createLocalWorkout: jest.fn(),
}));

const mockListWorkouts = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/workouts', () => ({
  ...jest.requireActual('@/lib/workouts'),
  listWorkouts: (...a: unknown[]) => mockListWorkouts(...a),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  // The shared ScreenHeader renders the sync chip now, so every screen test
  // needs this — a screen that could not read sync state would fail on the
  // header before reaching anything it asserts.
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({
    modules: [
      {
        key: 'strength',
        label: 'Strength',
        is_sport: true,
        enabled: true,
        capabilities: { catalog: 'exercises', facets: [], record_kinds: ['heaviest_weight'] },
      },
    ],
    known: true,
  }),
}));

const workout = (over: Partial<Workout> = {}): Workout => ({
  id: 'w1',
  owner_user_id: 'u1',
  name: 'Legs',
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
  mockCachedWorkouts.mockReset();
  mockCacheWorkouts.mockClear();
  mockListWorkouts.mockReset();
});

it('keeps an offline-created workout the server has never heard of', async () => {
  // The cache holds both; the network response predates the local creation.
  // Rendering the response is what made the new plan disappear.
  mockListWorkouts.mockResolvedValue([workout({ id: 'w1', name: 'Legs' })]);
  mockCachedWorkouts.mockResolvedValue([
    workout({ id: 'w1', name: 'Legs' }),
    workout({ id: 'local-1', name: 'Made In The Gym' }),
  ]);

  render(<WorkoutsScreen />);

  await waitFor(() => expect(mockCacheWorkouts).toHaveBeenCalled());
  expect(await screen.findByText('Made In The Gym')).toBeTruthy();
});

it('re-reads the cache AFTER writing the response to it', async () => {
  // Order is the mechanism: reading before the write would render a cache
  // that predates the refresh, so the screen would lag one fetch behind.
  const order: string[] = [];
  mockListWorkouts.mockResolvedValue([workout()]);
  mockCacheWorkouts.mockImplementation(async () => void order.push('write'));
  mockCachedWorkouts.mockImplementation(async () => {
    order.push('read');
    return [workout()];
  });

  render(<WorkoutsScreen />);

  await waitFor(() => expect(order).toContain('write'));
  // Asserted as a PATTERN, not as the whole sequence: a focus effect can run
  // the load more than once, so pinning the exact array makes the test depend
  // on how many times the screen happened to reload. The invariant is that a
  // read follows every write — reading before it would render a cache that
  // predates the refresh, leaving the screen one fetch behind.
  const firstWrite = order.indexOf('write');
  expect(order[firstWrite + 1]).toBe('read');
});

it('still renders the network list for the shared scope, which has no cache', async () => {
  // `mine` is the only scope cached — caching other athletes' public
  // templates under this user's rows would make them look like their own. So
  // the cache-first path must NOT swallow the shared tab, and the only way to
  // check that is to actually switch to it.
  mockCachedWorkouts.mockResolvedValue([workout({ id: 'w1', name: 'Legs' })]);
  mockListWorkouts.mockImplementation(async (...a: unknown[]) =>
    a[1] === 'shared'
      ? [workout({ id: 's1', name: 'Someone Else Plan', owner_user_id: 'u2' })]
      : [workout({ id: 'w1', name: 'Legs' })],
  );

  render(<WorkoutsScreen />);
  await screen.findByText('Legs');

  fireEvent.press(screen.getByText('Shared'));

  expect(await screen.findByText('Someone Else Plan')).toBeTruthy();
  // And the cached `mine` row must not leak into the shared tab.
  expect(screen.queryByText('Legs')).toBeNull();
});
