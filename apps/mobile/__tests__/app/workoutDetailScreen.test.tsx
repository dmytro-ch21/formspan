import { useEffect, useState } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import WorkoutDetailScreen from '../../app/workout/[id]';
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

/**
 * …and `jest.setTimeout` alone did not do it, which is why the FIRST test in
 * this file failed on any cold cache.
 *
 * It raises the ceiling on the whole test. RNTL's `findBy*` and `waitFor` have
 * their own, separate 1000ms budget that it does not touch — so the first
 * render paid ~2s of module-graph instantiation and the first `findByLabelText`
 * gave up at one second, inside a test allowed thirty. Reproduced against
 * `origin/main`'s copy of this file with `jest --clearCache`: same failure,
 * same test, so it long predates the sharing work that ran into it.
 *
 * It passed on every warm run, which is precisely why it survived — a
 * developer's second run is always warm, and CI's cache usually is too.
 */
configure({ asyncUtilTimeout: 10_000 });

// Typed to accept args so the `(...a) => mock(...a)` forwarding below
// typechecks; a zero-arg jest.fn() rejects a spread call.
const mockCachedWorkouts = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockDirtyWorkoutIDs = jest.fn(
  (..._a: unknown[]): Promise<Set<string>> => Promise.resolve(new Set<string>()),
);
const mockUnsyncedWorkoutIDs = jest.fn(
  (..._a: unknown[]): Promise<Set<string>> => Promise.resolve(new Set<string>()),
);
const mockStartLocalSession = jest.fn(
  (..._a: unknown[]): Promise<{ id: string }> => Promise.resolve({ id: 'new-session' }),
);
jest.mock('@/lib/sessionStore', () => ({
  cachedWorkouts: (...a: unknown[]) => mockCachedWorkouts(...a),
  dirtyWorkoutIDs: (...a: unknown[]) => mockDirtyWorkoutIDs(...a),
  unsyncedWorkoutIDs: (...a: unknown[]) => mockUnsyncedWorkoutIDs(...a),
  deleteLocalWorkout: jest.fn(),
  renameLocalWorkout: (...a: unknown[]) => mockRenameLocal(...a),
  saveLocalWorkoutItems: jest.fn(async () => {}),
  startLocalSession: (...a: unknown[]) => mockStartLocalSession(...a),
  cacheExercises: jest.fn(async () => {}),
  cachedExercises: jest.fn(async () => []),
}));

const mockRenameLocal = jest.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(true));

const mockGetWorkout = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(null));
jest.mock('@/lib/workouts', () => ({
  ...jest.requireActual('@/lib/workouts'),
  getWorkout: (...a: unknown[]) => mockGetWorkout(...a),
}));

const mockFetchExercises = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/exercises', () => ({
  fetchExercises: (...a: unknown[]) => mockFetchExercises(...a),
}));
/**
 * A SUBSCRIBABLE sync mock, not a frozen object.
 *
 * The share gate depends on `lastSyncAt`, and a fixed value cannot express
 * "the background push has now finished" — which is the exact transition a bug
 * shipped in. So this mirrors the real hook's shape (`lib/sync.ts:415`:
 * `useState(syncState)` plus `useEffect(() => subscribeSync(setS), [])`), and
 * `emitSync` is the test's stand-in for a completed push.
 *
 * `mock`-prefixed aliases rather than `require('react')` inside the factory:
 * jest allows out-of-scope names beginning with `mock`, and the require costs a
 * lint warning against the mobile ratchet.
 */
const mockUseState = useState;
const mockUseEffect = useEffect;
const mockSyncState = {
  syncing: false,
  pending: 0,
  deferred: 0,
  lastSyncAt: null as string | null,
  lastError: null,
  online: true,
};
const mockSyncListeners = new Set<(s: typeof mockSyncState) => void>();
jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  // The shared ScreenHeader renders the sync chip now, so every screen test
  // needs this — a screen that could not read sync state would fail on the
  // header before reaching anything it asserts.
  useSyncState: () => {
    const [s, setS] = mockUseState(mockSyncState);
    mockUseEffect(() => {
      mockSyncListeners.add(setS);
      return () => {
        mockSyncListeners.delete(setS);
      };
    }, []);
    return s;
  },
}));

/** A background push completing, as the screen would see it. */
function emitSync(next: Partial<typeof mockSyncState>) {
  Object.assign(mockSyncState, next);
  const snapshot = { ...mockSyncState };
  mockSyncListeners.forEach((l) => l(snapshot));
}
jest.mock('@/lib/sessions', () => ({
  applySuggestions: jest.fn(),
  fetchSuggestions: jest.fn(async () => new Map()),
  setsFromWorkout: jest.fn(() => []),
  // N474: real values, not a mock — every fixture in this file is
  // `sport: 'strength'`, so the picker this module feeds renders on every
  // test here. `requireActual` would also work; a literal copy is cheaper
  // and this is pure static data with nothing worth mocking.
  SESSION_INTENTS: [
    { key: 'normal', label: 'Normal' },
    { key: 'light', label: 'Light' },
    { key: 'deload', label: 'Deload' },
  ],
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
  mockRenameLocal.mockReset();
  mockRenameLocal.mockResolvedValue(true);
  mockGetWorkout.mockReset();
  mockDirtyWorkoutIDs.mockReset().mockResolvedValue(new Set<string>());
  mockUnsyncedWorkoutIDs.mockReset().mockResolvedValue(new Set<string>());
  mockSyncState.lastSyncAt = null;
  mockStartLocalSession.mockReset().mockResolvedValue({ id: 'new-session' });
});

// N474: this screen's "Start session" is a SIBLING entry point to
// `session/start.tsx`'s own picker — its whole design point is "performing
// a template is one tap away" (see the screen's own `start()` comment), so
// the fix here is a second copy of the picker rather than rerouting through
// the other screen and losing that tap. ac-verifier and frontend-reviewer
// both caught this as the same reachability class as the start.tsx fix.
it('the intent picker defaults to Normal and is not shown for a non-strength plan', async () => {
  mockCachedWorkouts.mockResolvedValue([plan('Squat Day')]);
  mockGetWorkout.mockResolvedValue(plan('Squat Day'));

  render(<WorkoutDetailScreen />);
  await waitFor(() => expect(screen.getByTestId('workout-intent-picker')).toBeTruthy());
  expect(screen.getByTestId('workout-intent-normal')).toBeTruthy();

  await act(async () => {});
  const bjjPlan = plan('Rolling', { sport: 'bjj' });
  mockCachedWorkouts.mockResolvedValue([bjjPlan]);
  mockGetWorkout.mockResolvedValue(bjjPlan);
  render(<WorkoutDetailScreen />);
  await waitFor(() => expect(screen.getByLabelText('Start a session from Rolling')).toBeTruthy());
  expect(screen.queryByTestId('workout-intent-picker')).toBeNull();
});

it('starting a session from a template sends the chosen intent, not always normal', async () => {
  mockCachedWorkouts.mockResolvedValue([plan('Squat Day')]);
  mockGetWorkout.mockResolvedValue(plan('Squat Day'));

  render(<WorkoutDetailScreen />);
  await waitFor(() => expect(screen.getByTestId('workout-intent-picker')).toBeTruthy());

  fireEvent.press(screen.getByTestId('workout-intent-light'));
  fireEvent.press(screen.getByTestId('workout-start-session'));

  await waitFor(() => expect(mockStartLocalSession).toHaveBeenCalled());
  expect(mockStartLocalSession).toHaveBeenCalledWith(
    'u1',
    expect.objectContaining({ intent: 'light' }),
  );
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

/**
 * Renaming, at the screen.
 *
 * The store and the migration are covered elsewhere; what only exists here is
 * which branch renders and whether the commit path reaches the store at all. A
 * review caught the Done button silently eating its first tap (RN spends it
 * dismissing the keyboard unless `keyboardShouldPersistTaps` is set) — a defect
 * with no possible SQLite-level test, and one that hides on the Simulator,
 * where a hardware keyboard means the soft keyboard is never up.
 */
describe('renaming', () => {
  const openEditor = async () => {
    mockCachedWorkouts.mockResolvedValue([plan('Legs')]);
    mockGetWorkout.mockResolvedValue(plan('Legs'));
    render(<WorkoutDetailScreen />);
    await waitFor(() => expect(screen.getByTestId('workout-rename')).toBeTruthy());
    fireEvent.press(screen.getByTestId('workout-rename'));
    await waitFor(() => expect(screen.getByTestId('workout-name-input')).toBeTruthy());
  };

  it('writes the new name to the store', async () => {
    await openEditor();
    fireEvent.changeText(screen.getByTestId('workout-name-input'), 'Legs B');
    fireEvent.press(screen.getByTestId('workout-name-save'));

    await waitFor(() => expect(mockRenameLocal).toHaveBeenCalledTimes(1));
    expect(mockRenameLocal.mock.calls[0][2]).toBe('Legs B');
  });

  it('commits on blur and closes the field', async () => {
    // Losing focus is the other way out — before `onBlur` the heading stayed
    // replaced by an unfocused field holding an uncommitted draft, with Done
    // the only exit.
    //
    // NOT a test of `commitRename`'s re-entrancy guard, though an earlier
    // version of this claimed to be. The pair that guard exists for — Done
    // pressed while the field still has focus, so blur and the press both
    // land — cannot be staged here, because the first blur unmounts the
    // button. Firing blur twice does not substitute: the second event hits a
    // detached node, so it passes with the guard deleted. Verified by
    // mutation, which is the only reason it is not still written that way.
    await openEditor();
    const input = screen.getByTestId('workout-name-input');
    fireEvent.changeText(input, 'Legs B');
    fireEvent(input, 'blur');

    await waitFor(() => expect(mockRenameLocal).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('workout-name-input')).toBeNull();
  });

  it('does not write a blank name', async () => {
    await openEditor();
    fireEvent.changeText(screen.getByTestId('workout-name-input'), '   ');
    fireEvent.press(screen.getByTestId('workout-name-save'));

    await waitFor(() => expect(screen.queryByTestId('workout-name-input')).toBeNull());
    expect(mockRenameLocal).not.toHaveBeenCalled();
  });

  it("offers no rename control on a workout that is not yours, but still shows its name", async () => {
    // A VOLA template. The API refuses the write, so the affordance must not
    // be there — and the name still has to render, or the screen loses its
    // heading entirely for every shared and official template.
    const official = plan('VOLA Full Body', { owner_user_id: null, visibility: 'public' });
    mockCachedWorkouts.mockResolvedValue([official]);
    mockGetWorkout.mockResolvedValue(official);
    render(<WorkoutDetailScreen />);

    await waitFor(() => expect(screen.getByTestId('workout-readonly')).toBeTruthy());
    expect(screen.queryByTestId('workout-rename')).toBeNull();
    expect(screen.getAllByText('VOLA Full Body').length).toBeGreaterThan(0);
  });
});

/**
 * The share gate: what it sends is what the SERVER holds.
 *
 * These are the arms `shareBlockedReason` exists for, asserted where the flags
 * are actually read off SQLite — a pure test of the function proves the
 * wording, not the wiring, and the wiring is what would silently ship a share
 * button on a plan the server has never heard of.
 *
 * The failure is invisible from inside the app: the sender sees "Sent ✓" and
 * the recipient gets nothing, or gets a version of the plan neither of them is
 * looking at. Nobody reports that; they both assume it worked.
 */
describe('sharing a plan the server does not have', () => {
  it('refuses, and says syncing rather than saving, when the row is local-only', async () => {
    // A plan built in a gym with no signal. Its id is client-generated, so a
    // share would come back a flat 404 naming nothing the athlete did wrong —
    // and telling them to Save what they already saved is worse than useless.
    //
    // BOTH flags, because that is the real shape of this state: a row created
    // offline has never reached the server AND owes it everything. With only
    // `unsynced` set, the two reasons could be checked in either order and
    // this test could not tell — which is the version of it that passes while
    // every offline plan says "Save your changes first".
    mockCachedWorkouts.mockResolvedValue([plan('Made In The Gym')]);
    mockGetWorkout.mockRejectedValue(new Error('offline'));
    mockUnsyncedWorkoutIDs.mockResolvedValue(new Set(['w1']));
    mockDirtyWorkoutIDs.mockResolvedValue(new Set(['w1']));

    render(<WorkoutDetailScreen />);

    // `includeHiddenElements`, because the visible reason is deliberately
    // hidden from assistive tech — the button's own accessibilityLabel carries
    // the same sentence, and RNTL excludes a11y-hidden nodes by default. The
    // assertion is about what a SIGHTED athlete reads.
    const reason = await screen.findByTestId('share-disabled-reason', {
      includeHiddenElements: true,
    });
    expect(reason.props.children).toMatch(/Not synced yet/);
    expect(screen.getByTestId('workout-share').props.accessibilityState.disabled).toBe(true);
  });

  it('refuses, and says SAVE, when the row is on the server but owes it an edit', async () => {
    // Pushed once, edited since. The recipient would get the old version, and
    // this one really is fixed by saving — so the copy must not say "sync".
    mockCachedWorkouts.mockResolvedValue([plan('Push Day A')]);
    mockGetWorkout.mockResolvedValue(plan('Push Day A'));
    mockDirtyWorkoutIDs.mockResolvedValue(new Set(['w1']));

    render(<WorkoutDetailScreen />);

    const reason = await screen.findByTestId('share-disabled-reason', {
      includeHiddenElements: true,
    });
    expect(reason.props.children).toMatch(/Save your changes first/);
  });

  it('allows it once the server holds the same plan', async () => {
    mockCachedWorkouts.mockResolvedValue([plan('Push Day A')]);
    mockGetWorkout.mockResolvedValue(plan('Push Day A'));

    render(<WorkoutDetailScreen />);

    await screen.findByTestId('workout-share');
    await waitFor(() =>
      expect(screen.getByTestId('workout-share').props.accessibilityState.disabled).toBe(false),
    );
    // And no reason line at all, because there is nothing to explain.
    expect(
      screen.queryByTestId('share-disabled-reason', { includeHiddenElements: true }),
    ).toBeNull();
  });

  it('offers Share on a plan that is not yours, unlike Save and Delete', async () => {
    // Passing on a plan you can READ is not a write to it — the server tests
    // visibility rather than ownership for exactly this reason, and a VOLA
    // Workout is already one tap from "Copy to my workouts". A share button
    // gated on `canEdit` would have looked correct and quietly removed the
    // only way to hand a training partner the plan you are both following.
    const theirs = plan('VOLA Full Body', { owner_user_id: null });
    mockCachedWorkouts.mockResolvedValue([theirs]);
    mockGetWorkout.mockResolvedValue(theirs);

    render(<WorkoutDetailScreen />);

    await screen.findByTestId('workout-readonly');
    // PRESENT AND USABLE. Asserting presence alone left this green against a
    // `canEdit` gate, because a disabled button is still in the tree — so the
    // assertion covered nothing that could actually go wrong.
    await waitFor(() =>
      expect(screen.getByTestId('workout-share').props.accessibilityState.disabled).toBe(false),
    );
  });
});

it('re-enables Share once the background push lands', async () => {
  /**
   * The bug review caught, and the reason this effect keys on `lastSyncAt`.
   *
   * `requestSync()` returns IMMEDIATELY and pushes in the background, so at
   * `setSaving(false)` the row is still `dirty` in SQLite. Keyed on `saving`,
   * the flags were read at exactly the moment they were guaranteed stale and
   * then never again — Share stayed disabled telling the athlete to "Save your
   * changes first" seconds after the push had landed and the Save button
   * itself had disappeared. Advice pointing at a control that is no longer on
   * screen, on the feature's headline flow: edit, save, share.
   */
  mockCachedWorkouts.mockResolvedValue([plan('Push Day A')]);
  mockGetWorkout.mockResolvedValue(plan('Push Day A'));
  // Saved locally, push still in flight.
  mockDirtyWorkoutIDs.mockResolvedValue(new Set(['w1']));

  render(<WorkoutDetailScreen />);
  expect(
    (await screen.findByTestId('share-disabled-reason', { includeHiddenElements: true }))
      .props.children,
  ).toMatch(/Save your changes first/);

  // The push lands: SQLite is clean, and sync announces it.
  mockDirtyWorkoutIDs.mockResolvedValue(new Set<string>());
  act(() => emitSync({ lastSyncAt: '2026-08-07T12:00:00Z' }));

  await waitFor(() =>
    expect(screen.getByTestId('workout-share').props.accessibilityState.disabled).toBe(false),
  );
  expect(
    screen.queryByTestId('share-disabled-reason', { includeHiddenElements: true }),
  ).toBeNull();
});
