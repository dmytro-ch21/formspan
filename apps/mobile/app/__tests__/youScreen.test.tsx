import { useCallback, useEffect, useRef } from 'react';
import { act, configure, render, screen, waitFor, within } from '@testing-library/react-native';

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

jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: [], ready: true }),
}));
jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

// The heavy cards fetch on their own and are not what this file is about.
jest.mock('@/components/TrainingSummary', () => ({ TrainingSummary: () => null }));
jest.mock('@/components/RecordsCard', () => ({ RecordsCard: () => null }));
jest.mock('@/components/RoadmapSummary', () => ({ RoadmapSummary: () => null }));
jest.mock('@/components/BjjRankHeader', () => ({ BjjRankHeader: () => null }));

// `mock`-prefixed so jest's out-of-scope rule allows them in the factory, and
// so no `require('react')` is needed inside it (each one costs a lint warning
// against the mobile ratchet).
const mockUseCallback = useCallback;
const mockUseEffect = useEffect;
const mockUseRef = useRef;
let refocus: () => void = () => {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
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
