import { useCallback, useEffect, useRef } from 'react';
import { fireEvent, act, configure, render, screen, waitFor, within } from '@testing-library/react-native';

import YouScreen, { badgeText, rowLabelFor } from '../(tabs)/you';

/**
 * The waiting counts on the You tab.
 *
 * There was no screen-level test here when the badge shipped — its coverage
 * was all backend-side — and the property most worth pinning is the one a
 * first-load test cannot see: **a failed count must leave the previous number
 * alone.** Zeroing it renders no badge, and no badge is an assertion that
 * nothing is waiting. A gym dead-spot must not make that claim.
 *
 * That needs a SECOND focus, so `useFocusEffect` is mocked to hand the test a
 * `refocus()` rather than only firing on mount. Mocked to fire once, the
 * degradation rule is invisible: an implementation that zeroes on failure
 * looks identical to one that does not, because the starting value is already
 * 0 and both render no badge.
 *
 * The badge queries pass `includeHiddenElements` because the pill is
 * deliberately hidden from assistive tech — the row's own `accessibilityLabel`
 * already speaks the count, and announcing both would read the number twice.
 * Those assertions are about what a SIGHTED athlete sees; the spoken version
 * is checked through the labels.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockGetProfile = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({}));
jest.mock('@/lib/profile', () => ({
  getProfile: (...a: unknown[]) => mockGetProfile(...a),
}));

const mockCounts = jest.fn((..._a: unknown[]): Promise<Record<string, number>> =>
  Promise.resolve({}),
);
// Spread the real module rather than listing exports: this stubs the network
// call and nothing else, so a helper added to `lib/friends` later cannot
// silently arrive here as `undefined`. Listing them is how `anyArrived` became
// a hole that took the badge down in five of these tests.
const mockPlay = jest.fn();
jest.mock('@/lib/sounds', () => ({ playSound: (...a: unknown[]) => mockPlay(...a) }));

jest.mock('@/lib/friends', () => ({
  ...jest.requireActual('@/lib/friends'),
  getPendingCounts: (...a: unknown[]) => mockCounts(...a),
}));

// Mutable so a test can turn a discipline ON. The factory is evaluated once,
// at first require, so the arrow has to READ the variable rather than close
// over its value — and `beforeEach` puts it back to the bare account every
// other test in this file assumes.
let mockModules: { key: string; enabled: boolean }[] = [];
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true }),
}));
jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

// The heavy cards fetch on their own and are not what this file is about.
//
// `TrainingSummary` and `RecordsCard` USED to be stubbed here too, and their
// stubs are gone rather than kept: N178 (#583) moved both to the Progress tab,
// and a stub for a component this screen no longer renders would make the
// "moved, not copied" assertion at the foot of this file vacuous — it would
// pass against a You screen that still rendered them, because the stub draws
// nothing either way.
jest.mock('@/components/RoadmapSummary', () => ({ RoadmapSummary: () => null }));
jest.mock('@/components/BjjRankHeader', () => ({ BjjRankHeader: () => null }));

// `mock`-prefixed so jest's out-of-scope rule allows them in the factory, and
// so no `require('react')` is needed inside it (each one costs a lint warning
// against the mobile ratchet).
const mockUseCallback = useCallback;
const mockUseEffect = useEffect;
const mockUseRef = useRef;
let refocus: () => void = () => {};
// A STABLE push, not a fresh `jest.fn()` per call. The Library row's whole
// point is where it goes (N70), and a mock that hands out a new spy on every
// render can never be asserted against — the instance the component called is
// not the instance the test holds.
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  // Fires on mount like the real one, and keeps the callback so the test can
  // fire it again — running the previous cleanup first, as a real blur would.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const cleanup = mockUseRef<(() => void) | void>(undefined);
    const run = mockUseCallback(() => {
      if (typeof cleanup.current === 'function') cleanup.current();
      cleanup.current = cb();
    }, [cb]);
    mockUseEffect(() => {
      run();
      return () => {
        if (typeof cleanup.current === 'function') cleanup.current();
      };
    }, [run]);
    refocus = run;
  },
}));

beforeEach(() => {
  mockGetProfile.mockReset().mockResolvedValue({ display_name: 'Rhonda', unit_system: 'metric' });
  mockCounts.mockReset().mockResolvedValue({});
  // Reset too, or a future test added ABOVE the throwing-cue one could satisfy
  // its `toHaveBeenCalledWith` with somebody else's chime. No test can fire the
  // cue today, which is exactly when this is cheap to add.
  mockPlay.mockReset();
  // Back to the bare account. Every test in this file that predates the
  // mutable mock assumes nothing is enabled.
  mockModules = [];
});

describe('what a count renders as', () => {
  it('renders nothing at zero, rather than a zero', () => {
    // A badge is believed. "0" would assert that nothing is waiting, which is
    // a claim the screen must not make from a failed read.
    expect(badgeText(0)).toBeNull();
    // Defensive: a negative can only come from a server bug, and a "-1" badge
    // would be worse than none.
    expect(badgeText(-3)).toBeNull();
  });

  it('counts up to the cap and then stops claiming to be exact', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(99)).toBe('99');
    // The server caps at 100, so the value means "this many or more".
    expect(badgeText(100)).toBe('99+');
    expect(badgeText(4321)).toBe('99+');
  });

  it('says the number in words for a screen reader', () => {
    // "3" beside a label is obvious to look at and meaningless to hear, and
    // "99+" is not a phrase.
    //
    // The label is whatever the CALLER passes, so these are the function's own
    // cases rather than the screen's rows — they do not move when a row is
    // renamed, which is the point of testing the function and not the copy.
    expect(rowLabelFor('Friends', 0)).toBe('Friends');
    expect(rowLabelFor('Friends', 3)).toBe('Friends, 3 waiting');
    expect(rowLabelFor('Sharing', 100)).toBe('Sharing, over 99 waiting');
  });

  it('still speaks the detail line, as a hint', async () => {
    // An `accessibilityLabel` REPLACES the concatenation of child text, so the
    // second line of each row is invisible to a screen reader unless given its
    // own slot. Sighted users gained those lines when the controls became
    // rows; without this the trade would have been silent.
    mockCounts.mockResolvedValue({});
    render(<YouScreen />);

    const row = await screen.findByTestId('you-shared');
    expect(row.props.accessibilityHint).toBe('What partners sent you, and what you sent them');
  });
});

describe('the People rows', () => {
  it('badges friend requests and shares from their own keys', () => {
    // Crossed keys would be invisible to a test using one number for both.
    mockCounts.mockResolvedValue({ friend_requests: 2, shares: 5 });
    render(<YouScreen />);

    return waitFor(() => {
      expect(screen.getByTestId('you-social-badge', { includeHiddenElements: true })).toBeTruthy();
      expect(screen.getByLabelText('Social, 2 waiting')).toBeTruthy();
      expect(screen.getByLabelText('Sharing, 5 waiting')).toBeTruthy();
    });
  });

  it('badges shares at all, which is the gap this closes', () => {
    // The counts shipped with shares deliberately unbadged on mobile: there
    // was no sharing surface, so it would have been a number you could not
    // open. `app/shared/` closed that, and this is the assertion that the
    // badge actually arrived rather than the comment merely being deleted.
    mockCounts.mockResolvedValue({ friend_requests: 0, shares: 1 });
    render(<YouScreen />);

    return waitFor(() => {
      expect(screen.getByTestId('you-shared-badge', { includeHiddenElements: true })).toBeTruthy();
      expect(screen.queryByTestId('you-social-badge', { includeHiddenElements: true })).toBeNull();
    });
  });

  it('still badges when the arrival cue throws', async () => {
    // The PROPERTY this pins: a throwing cue cannot take the badge down.
    // Precisely, that is "committed before the cue, OR the cue is wrapped" —
    // both defences have to go for this to regress, which is what a regression
    // pin should ask. It does not pin the line order on its own.
    //
    // Written because it did exactly that. The chime was above `setWaiting`,
    // `anyArrived` arrived here as `undefined` through an incomplete mock, and
    // the throw was swallowed by the fetch's own `.catch` — five tests in this
    // file timed out waiting for a badge that was never going to render. The
    // mock hole is fixed above; this pins the code so the next hole is
    // survivable rather than silent.
    mockPlay.mockImplementationOnce(() => {
      throw new Error('audio is broken');
    });
    mockCounts.mockResolvedValue({ friend_requests: 0, shares: 0 });
    const { rerender } = render(<YouScreen />);
    await waitFor(() => expect(mockCounts).toHaveBeenCalled());

    // A rise, so the cue actually fires and actually throws.
    mockCounts.mockResolvedValue({ friend_requests: 2, shares: 0 });
    await act(async () => {
      refocus();
      rerender(<YouScreen />);
    });

    await waitFor(() => {
      expect(screen.getByTestId('you-social-badge', { includeHiddenElements: true })).toBeTruthy();
    });
    expect(mockPlay).toHaveBeenCalledWith('notification');
  });

  it('keeps the last known count when a refresh fails', async () => {
    // THE POINT OF THIS FILE. Zeroing on failure renders no badge, and no
    // badge asserts nothing is waiting — so a dead-spot would quietly tell an
    // athlete their inbox is clear.
    mockCounts.mockResolvedValue({ friend_requests: 3, shares: 0 });
    render(<YouScreen />);
    await screen.findByTestId('you-social-badge', { includeHiddenElements: true });

    mockCounts.mockRejectedValue(new Error('Network request failed'));
    await act(async () => {
      refocus();
    });

    expect(screen.getByTestId('you-social-badge', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByLabelText('Social, 3 waiting')).toBeTruthy();
  });

  it('takes the badge away once the count really is zero', async () => {
    // The arm that makes the previous test mean something: a SUCCESSFUL read
    // of 0 must clear it, or the badge would be permanent once lit.
    mockCounts.mockResolvedValue({ friend_requests: 3, shares: 0 });
    render(<YouScreen />);
    await screen.findByTestId('you-social-badge', { includeHiddenElements: true });

    mockCounts.mockResolvedValue({ friend_requests: 0, shares: 0 });
    await act(async () => {
      refocus();
    });

    await waitFor(() => expect(screen.queryByTestId('you-social-badge', { includeHiddenElements: true })).toBeNull());
  });
});

describe('the header', () => {
  it('leaves the header row empty, and moves every destination to a row', () => {
    // The fix: three text controls here (~173pt) overlapped the centred
    // wordmark, and `ScreenHeader` now drops a wordmark it cannot fit — so
    // leaving them would have cost this tab its wordmark permanently.
    //
    // The assertion is on the header's action CLUSTER being empty, not on the
    // wordmark being visible. `onLayout` never fires under RNTL, so nothing is
    // ever measured here and the wordmark renders optimistically whatever the
    // cluster holds — a wordmark assertion passes with the actions put back,
    // which is how the first version of this test proved nothing. Whether the
    // wordmark then survives is `screenHeader.test.tsx`'s job.
    //
    // Sync is online and clean in this file's mock, so `SyncChip` renders
    // null and the cluster should hold nothing at all.
    mockCounts.mockResolvedValue({});
    render(<YouScreen />);

    return waitFor(() => {
      // No TEXT in the header's action area. Counting `children` was tried and
      // does not work — a null-rendering `SyncChip` still leaves an instance
      // there, so the "empty" cluster is never length 0. Text is the thing the
      // old cluster actually put on the row ("Edit", "Friends", "Settings"),
      // and sync is online and clean in this file's mock, so the chip is
      // silent and there is nothing legitimate left to find.
      const cluster = screen.getByTestId('screen-header-actions');
      expect(within(cluster).queryByText(/\S/)).toBeNull();
      // And every destination the header used to carry is reachable as a row.
      expect(screen.getByTestId('you-edit')).toBeTruthy();
      expect(screen.getByTestId('you-settings')).toBeTruthy();
      expect(screen.getByTestId('you-social')).toBeTruthy();
      expect(screen.getByTestId('you-shared')).toBeTruthy();
    });
  });
});

describe('the Library row (N70)', () => {
  // The Library stopped being a tab and became a row here, on the user's own
  // call. The risk in that move is not that it looks wrong — it is that the
  // catalog becomes UNREACHABLE, which no typecheck can see: nothing in the
  // tree pushed `/library` before, because a tab is reached by tapping it.
  // So this row is now the only way in, and it is worth a test that fails if
  // somebody tidies it away.
  it('is present, and goes to the catalog', async () => {
    mockPush.mockClear();
    mockCounts.mockResolvedValue({});
    render(<YouScreen />);

    const row = await screen.findByTestId('you-library');
    fireEvent.press(row);
    expect(mockPush).toHaveBeenCalledWith('/library');
  });

  // Deliberately NOT gated on any module, unlike the tab it replaces — that
  // tab hid itself when no enabled discipline had a catalog, which is the
  // habit N61 is the bill for. This file's mock enables nothing in
  // particular, so a row that appears here is a row that appears for an
  // athlete with a bare account.
  it('does not hide itself when nothing is enabled', async () => {
    mockCounts.mockResolvedValue({});
    render(<YouScreen />);
    expect(await screen.findByTestId('you-library')).toBeTruthy();
  });
});

describe('the Sequences row (N80)', () => {
  // Same risk as the Library row above, and the reason #414 exists: accepting
  // a shared sequence now navigates straight to the copy, which answers the
  // athlete who just tapped Accept — and nobody else. Without this row a chain
  // is reachable only by having just arrived at it, which is the same
  // phone-impossible gap in a smaller form.
  it('is present for a BJJ account, and goes to the chain list', async () => {
    mockModules = [{ key: 'bjj', enabled: true }];
    render(<YouScreen />);

    fireEvent.press(await screen.findByTestId('you-sequences'));
    expect(mockPush).toHaveBeenCalledWith('/sequence');
  });

  it('is absent when BJJ is off', async () => {
    // The arm that makes the previous one mean anything — and the gate itself:
    // a strength-only account has no use for a list that can only be empty.
    // `beforeEach` has already cleared the modules.
    render(<YouScreen />);
    await screen.findByTestId('you-library');
    expect(screen.queryByTestId('you-sequences')).toBeNull();
  });
});

it('does not let a blurred count land on top of a newer one', async () => {
  /**
   * The abort the code advertises and nothing was checking.
   *
   * Leave the tab while a count is in flight, come back, get a fresh answer —
   * and then the FIRST request finally resolves. Without the abort guard its
   * stale number overwrites the newer one, and the badge shows a count from
   * before you looked. Deleting either `counting.abort()` or the
   * `signal.aborted` check leaves every other test in this file green.
   */
  let resolveFirst: (v: Record<string, number>) => void = () => {};
  mockCounts.mockImplementationOnce(
    (..._a: unknown[]) =>
      new Promise<Record<string, number>>((res) => {
        resolveFirst = res;
      }),
  );
  render(<YouScreen />);

  // Blur and return. The second read answers immediately with the truth.
  mockCounts.mockResolvedValue({ friend_requests: 1, shares: 0 });
  await act(async () => {
    refocus();
  });
  expect(await screen.findByLabelText('Social, 1 waiting')).toBeTruthy();

  // Now the abandoned first request comes back, claiming something else.
  await act(async () => {
    resolveFirst({ friend_requests: 9, shares: 9 });
  });

  expect(screen.getByLabelText('Social, 1 waiting')).toBeTruthy();
  expect(screen.queryByLabelText('Social, 9 waiting')).toBeNull();
});

/**
 * N61 — the Sports row was the answer to every silent absence, and was inert.
 *
 * Every module gate in this app renders NOTHING when its discipline is off:
 * the belt roadmaps, the Plan tab's Roadmaps strip, BJJ in the session picker,
 * and the Food and Goals TABS. This row already displayed which disciplines
 * were on — so it named the cause of all of them — while offering no way to
 * act on it. The user reported the roadmaps as missing from a real phone; they
 * exist and work.
 */
describe('the Sports row', () => {
  it('leads to the toggles rather than only naming them', async () => {
    render(<YouScreen />);
    const row = await screen.findByTestId('you-sports');
    fireEvent.press(row);
    // The destination screens explain themselves ("BJJ tracking is off, turn
    // it back on under Sports"). Nothing linked to them while they were off,
    // which is why the athlete never reached the screen that would say so.
    expect(mockPush).toHaveBeenCalledWith('/profile/edit');
  });
});

/**
 * N178 — the training summary, the records list and the position map MOVED.
 *
 * The ticket asks for a move rather than a duplication, and "moved" is only
 * checkable from the screen that lost them: `progressScreen.test.tsx` asserts
 * they render there, and this asserts they do not render here. Either half
 * alone is satisfied by a copy.
 *
 * Asserted on testIDs the components render UNCONDITIONALLY — `training-span-1m`
 * is TrainingSummary's span control and `records-manage` is RecordsCard's
 * "Choose", both outside every loading and empty branch — so re-adding either
 * component to this screen turns this red whatever state its fetch is in.
 * Neither is stubbed in this file any more, for the same reason.
 */
describe('what N178 moved to Progress', () => {
  it('no longer renders the training summary, the records or the position map', async () => {
    // With BJJ on, which is the only configuration in which the position map
    // row was ever drawn here — asserting its absence on a strength-only
    // account would be true by construction.
    mockModules = [{ key: 'bjj', enabled: true }];
    render(<YouScreen />);
    await screen.findByTestId('you-sports');

    expect(screen.queryByTestId('training-span-1m')).toBeNull();
    expect(screen.queryByTestId('records-manage')).toBeNull();
    expect(screen.queryByTestId('you-bjj-positions')).toBeNull();

    // And what stayed is still here, so this is a move rather than a cull.
    expect(screen.getByTestId('you-library')).toBeTruthy();
    expect(screen.getByTestId('you-sequences')).toBeTruthy();
  });
});
