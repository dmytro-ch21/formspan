import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import WorkoutsScreen from '../../app/(tabs)/workouts';
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
  // Read by `lib/useTrainBoard.ts`, which this screen calls for the "beyond
  // this week" block (N182). Stubbed rather than left out: a missing export
  // here throws inside the hook's focus effect and takes down every test in
  // this file, none of which is about sessions. `planNextUp.test.tsx` is where
  // that block's behaviour is actually asserted.
  listLocalSessions: jest.fn(async () => []),
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
  mockListWorkouts.mockReset();
  // `mockReset`, not `mockClear`. `mockClear` only wipes the call log — it
  // leaves a `mockRejectedValue` in place, so the failed-cache-write test below
  // leaked its rejection into every test DECLARED AFTER IT, permanently. That
  // was silently weakening the shared-scope test (which ran its `mine` phase
  // through the failure path instead of the write-then-read-back path) and
  // would have failed any future test added at the end of this file, for a
  // reason nowhere near where it was written.
  //
  // `mockReset` drops the implementation `jest.fn()` was constructed with too,
  // so the resolved default has to be restored explicitly — which is presumably
  // why `mockClear` was reached for in the first place.
  mockCacheWorkouts.mockReset();
  mockCacheWorkouts.mockResolvedValue(undefined);
  // Same asymmetry, same reason: after `mockReset` this returns `undefined`,
  // and the cache-first read does `cached.length` inside a `catch`-all — so a
  // future test that forgets to set it renders nothing, silently.
  mockCachedWorkouts.mockResolvedValue([]);
});

// `console.warn` is spied on in two tests below. `mockRestore` at the end of a
// test only runs if its assertions passed, so a failure would otherwise leave
// `console.warn` stubbed for every test after it — the same leak class the
// `beforeEach` above exists to close. `restoreMocks` is not set in jest.config.
afterEach(() => {
  jest.restoreAllMocks();
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

it('renders the plan when the cache write fails, instead of a SQLite error', async () => {
  // The Plan tab showed "cannot rollback - no transaction is active" where the
  // week's training goes. The database error was real (two transactions
  // colliding on expo-sqlite's one connection — fixed in `lib/db.ts`), but the
  // screen amplified it: by this point `listWorkouts` had already ANSWERED, so
  // the athlete's plan was in hand and got replaced by a red banner about a
  // failed write to a cache that exists purely to help next time.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockListWorkouts.mockResolvedValue([workout({ id: 'w1', name: 'Legs' })]);
  mockCacheWorkouts.mockRejectedValue(
    new Error("Calling the 'execAsync' function has failed: cannot rollback - no transaction is active"),
  );
  // Empty, so nothing else could be supplying the row under test — and so the
  // empty-cache guard is the thing being exercised.
  mockCachedWorkouts.mockResolvedValue([]);

  render(<WorkoutsScreen />);

  expect(await screen.findByText('Legs')).toBeTruthy();
  expect(screen.queryByText(/cannot rollback/)).toBeNull();
  // Invisible to the athlete, but not invisible. A cache failing every write
  // would otherwise rot the offline plan behind a screen that looks healthy.
  // Matched on the message, so an unrelated React Native warning cannot
  // satisfy this the day one starts firing on this screen.
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('[plan] cache write failed'),
    expect.any(Error),
    undefined,
  );
});

it('falls back to READING the cache when the cache WRITE fails', async () => {
  // What failed is a write; `cachedWorkouts` is a plain SELECT with no
  // transaction and still answers. Falling back to the network list instead
  // would drop exactly the rows the list structurally cannot contain — a
  // workout created offline and not yet pushed — and, with an empty server
  // list, would show "No workouts yet" to someone holding one.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockListWorkouts.mockResolvedValue([]);
  mockCacheWorkouts.mockRejectedValue(new Error('cannot rollback - no transaction is active'));
  mockCachedWorkouts.mockResolvedValue([workout({ id: 'local-1', name: 'Made In The Gym' })]);

  render(<WorkoutsScreen />);

  expect(await screen.findByText('Made In The Gym')).toBeTruthy();
  expect(warn).toHaveBeenCalled();
});

it('drops a superseded load instead of overwriting the newer one', async () => {
  // The abort re-check that sits AFTER the cache awaits, which nothing covered.
  //
  // It matters more since the transaction queue landed: `cacheWorkouts` can now
  // sit behind another screen's catalog write, so a load superseded by a scope
  // switch can resume long after the newer one has rendered. Without the check
  // it then calls `setWorkouts` and the athlete watches the VOLA Workouts tab
  // flip back to their own templates.
  let releaseWrite: () => void = () => {};
  const parked = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  mockListWorkouts.mockImplementation(async (...a: unknown[]) =>
    a[1] === 'public'
      ? [workout({ id: 's1', name: 'Someone Else Plan', owner_user_id: 'u2' })]
      : [workout({ id: 'w1', name: 'Legs' })],
  );
  // The `mine` load parks mid-flight, exactly where the queue would park it.
  mockCacheWorkouts.mockImplementation(() => parked);
  mockCachedWorkouts.mockResolvedValue([workout({ id: 'w1', name: 'Legs' })]);

  render(<WorkoutsScreen />);
  await waitFor(() => expect(mockCacheWorkouts).toHaveBeenCalled());

  // Supersede it before it can finish.
  fireEvent.press(screen.getByText('VOLA Workouts'));
  expect(await screen.findByText('Someone Else Plan')).toBeTruthy();

  // Now let the stale load resume. Waited on as an INCREASE from a baseline,
  // not an absolute count: the focus effect can run the load more than once,
  // so pinning a number makes this depend on how many times it happened to
  // fire — the same reason the ordering test above asserts a pattern.
  const readsBefore = mockCachedWorkouts.mock.calls.length;
  releaseWrite();
  await waitFor(() =>
    expect(mockCachedWorkouts.mock.calls.length).toBeGreaterThan(readsBefore),
  );

  expect(screen.queryByText('Someone Else Plan')).toBeTruthy();
  expect(screen.queryByText('Legs')).toBeNull();
});

it('still renders the network list for the shared scope, which has no cache', async () => {
  // `mine` is the only scope cached — caching other athletes' public
  // templates under this user's rows would make them look like their own. So
  // the cache-first path must NOT swallow the shared tab, and the only way to
  // check that is to actually switch to it.
  mockCachedWorkouts.mockResolvedValue([workout({ id: 'w1', name: 'Legs' })]);
  mockListWorkouts.mockImplementation(async (...a: unknown[]) =>
    a[1] === 'public'
      ? [workout({ id: 's1', name: 'Someone Else Plan', owner_user_id: 'u2' })]
      : [workout({ id: 'w1', name: 'Legs' })],
  );

  render(<WorkoutsScreen />);
  await screen.findByText('Legs');

  fireEvent.press(screen.getByText('VOLA Workouts'));

  expect(await screen.findByText('Someone Else Plan')).toBeTruthy();
  // And the cached `mine` row must not leak into the shared tab.
  expect(screen.queryByText('Legs')).toBeNull();
});

it('marks a community plan on the shelf that carries VOLA’s name', async () => {
  // The shelf is called VOLA Workouts and most of it is ours, but the scope is
  // `owner_user_id IS DISTINCT FROM $1 AND visibility = 'public'` — so it also
  // carries whatever any athlete has published. Unmarked, the rename would put
  // the brand's name on a stranger's plan, and nothing on the tile would say
  // otherwise until you opened it.
  mockCachedWorkouts.mockResolvedValue([]);
  mockListWorkouts.mockImplementation(async (...a: unknown[]) =>
    a[1] === 'public'
      ? [
          workout({ id: 'p1', name: 'Ours', owner_user_id: null, items: [{}, {}] as never }),
          workout({ id: 'p2', name: 'Theirs', owner_user_id: 'u2', items: [{}, {}] as never }),
        ]
      : [],
  );

  render(<WorkoutsScreen />);
  fireEvent.press(screen.getByText('VOLA Workouts'));
  await screen.findByText('Ours');

  // Scoped to each tile, not to the screen. Asserting both strings exist
  // somewhere passes just as happily when the marker is on the WRONG tile —
  // inverting the condition only swaps which plan carries it — so a
  // screen-wide query would certify the one thing that actually goes wrong.
  //
  // Marking the exception rather than the rule: seventeen "by VOLA" labels
  // would be noise, so the VOLA-authored tile carries the count alone.
  expect(within(screen.getByTestId('workout-p1')).getByText('2 exercises')).toBeTruthy();
  expect(
    within(screen.getByTestId('workout-p2')).getByText('Community · 2 exercises'),
  ).toBeTruthy();
});

it('says "1 exercise" on a one-movement plan', async () => {
  // Reachable: anyone can publish a single-movement plan. The tile had this
  // wrong while the row card beside it had it right.
  mockCachedWorkouts.mockResolvedValue([]);
  mockListWorkouts.mockImplementation(async (...a: unknown[]) =>
    a[1] === 'public'
      ? [workout({ id: 'p1', name: 'Just Squats', owner_user_id: null, items: [{}] as never })]
      : [],
  );

  render(<WorkoutsScreen />);
  fireEvent.press(screen.getByText('VOLA Workouts'));

  expect(await screen.findByText('1 exercise')).toBeTruthy();
});

/**
 * N498 moved `ScreenHeader` from a pinned sibling into the FlatList's own
 * `ListHeaderComponent`, so it scrolls away like every other tab. A first
 * pass at that left the error banner behind as a sibling ABOVE the list —
 * which put it above the (now list-internal) header too, flush against the
 * screen's top edge with none of `ScreenHeader`'s safe-area padding. Fixed
 * by moving the banner into `ListHeaderComponent`, below the header and the
 * scope strip — this pins the fix, not just the presence of the text.
 */
it('renders the error banner below the header, not flush against the safe area', async () => {
  mockCachedWorkouts.mockResolvedValue([]);
  mockListWorkouts.mockRejectedValue(new Error('offline'));

  render(<WorkoutsScreen />);

  await screen.findByTestId('workouts-error');

  const order: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { props?: { testID?: string }; children?: unknown[] };
    if (n.props?.testID) order.push(n.props.testID);
    n.children?.forEach(walk);
  };
  walk(screen.toJSON());

  const headerIndex = order.indexOf('screen-header');
  const errorIndex = order.indexOf('workouts-error');
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  expect(errorIndex).toBeGreaterThan(headerIndex);
});
