import { useCallback, useEffect, useRef } from 'react';
import { fireEvent, act, configure, render, screen, waitFor, within } from '@testing-library/react-native';

import YouScreen, { badgeText, friendCountLabel, phaseValue, rowLabelFor } from '../../app/(tabs)/you';
import type { Phase } from '@/lib/body';

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

// The phase read, which N181 put on this screen so the Phase row shows the live
// phase instead of listing the kinds. Spread the real module, like the friends
// mock below and for the same reason: `PHASE_LABELS` is the table the row's
// wording comes from, and a listed-exports mock would deliver it as `undefined`
// and read as a rendering bug.
const mockPhases = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/body', () => ({
  ...jest.requireActual('@/lib/body'),
  listPhases: (...a: unknown[]) => mockPhases(...a),
}));

// The friend count behind the header's `/friends` entry point (N509) — a
// SEPARATE mock target from `getPendingCounts` above, on the real module's own
// `FriendCard[]` shape, so a test can set how many friends this account has
// without touching the unrelated pending-request counts.
const mockListFriends = jest.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
jest.mock('@/lib/friends', () => ({
  ...jest.requireActual('@/lib/friends'),
  getPendingCounts: (...a: unknown[]) => mockCounts(...a),
  listFriends: (...a: unknown[]) => mockListFriends(...a),
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
// Rendered as a real (stub) element rather than `() => null`, deliberately —
// the whole point of N181's device-pass fix is WHERE this renders relative to
// the athlete's name, and a component that renders nothing can never fail an
// order assertion. `testID="bjj-rank-header"` matches the real component's own
// outer testID, so this stands in for it in the order checks below without
// inventing a second name for the same thing.
jest.mock('@/components/BjjRankHeader', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return {
    BjjRankHeader: () => React.createElement(Text, { testID: 'bjj-rank-header' }, 'Belt'),
  };
});

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
  mockListFriends.mockReset().mockResolvedValue([]);
  // Reset too, or a future test added ABOVE the throwing-cue one could satisfy
  // its `toHaveBeenCalledWith` with somebody else's chime. No test can fire the
  // cue today, which is exactly when this is cheap to add.
  mockPlay.mockReset();
  // An athlete on no phase, which is the common case and the one every test
  // here that is not about the phase should assume.
  mockPhases.mockReset().mockResolvedValue([]);
  // Back to the bare account. Every test in this file that predates the
  // mutable mock assumes nothing is enabled.
  mockModules = [];
});

/** A live phase — no `ended_on`, which is what `you.tsx` filters on. */
function livePhase(kind: Phase['kind']): Phase {
  return {
    id: 'p1',
    user_id: 'u1',
    kind,
    started_on: '2026-08-01',
    target_on: null,
    target_weight_kg: null,
    ended_on: null,
    notes: '',
  };
}

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

/**
 * N181 — the Phase row shows the live phase.
 *
 * It was a `NavRow` whose detail line listed the kinds ("Cutting, bulking, or
 * holding where you are") and never said which one was running, so the one fact
 * it existed to carry was the one thing it did not show. The ticket puts
 * training phase in athlete identity; a link is not identity, an answer is.
 *
 * The three outcomes below are pinned on the pure helper AND through the
 * screen, because the helper cannot see the thing most likely to go wrong: a
 * failed read that clears the state feeding it.
 */
describe('what the Phase row says', () => {
  it('withholds until the server has answered, and does not guess', () => {
    // `'—'` and `'None'` are both "no phase to show", and only one of them is a
    // claim about the athlete. Collapsing them would tell somebody on week six
    // of a cut that they are on no phase.
    expect(phaseValue(null, false)).toBe('—');
    expect(phaseValue(livePhase('cut'), false)).toBe('—');
  });

  it('says None once the server has answered and there is none', () => {
    expect(phaseValue(null, true)).toBe('None');
  });

  it('names the live phase from the registry, not from a copy of its words', () => {
    // `PHASE_LABELS` is the same table `app/phase/index.tsx` renders from, so
    // renaming a kind moves both. A literal here would be the two-modules-drift
    // shape the Units row was fixed for.
    expect(phaseValue(livePhase('cut'), true)).toBe('Cut');
    expect(phaseValue(livePhase('making_weight'), true)).toBe('Making weight');
  });

  it('renders the live phase on the row, and opens the phase screen', async () => {
    mockPhases.mockResolvedValue([livePhase('lean_bulk')]);
    render(<YouScreen />);

    const row = await screen.findByTestId('you-phase');
    await waitFor(() => expect(row.props.accessibilityValue?.text).toBe('Lean bulk'));
    fireEvent.press(row);
    expect(mockPush).toHaveBeenCalledWith('/phase');
  });

  it('ignores a phase that has ended', async () => {
    // `ended_on` is stamped rather than the row deleted, so every target
    // derived during it keeps its frozen basis — which means the list this
    // screen reads is a HISTORY, and taking its first entry would show a cut
    // that finished in March as live.
    mockPhases.mockResolvedValue([{ ...livePhase('cut'), ended_on: '2026-03-01' }]);
    render(<YouScreen />);

    const row = await screen.findByTestId('you-phase');
    await waitFor(() => expect(row.props.accessibilityValue?.text).toBe('None'));
  });

  it('keeps the phase on screen when a refresh fails', async () => {
    // The same rule as the counts below, for the same reason: failing to
    // re-read a fact about the athlete is not evidence that it changed. Zeroing
    // it here would render "None" — an assertion, from a dead-spot.
    mockPhases.mockResolvedValue([livePhase('cut')]);
    render(<YouScreen />);
    const row = await screen.findByTestId('you-phase');
    await waitFor(() => expect(row.props.accessibilityValue?.text).toBe('Cut'));

    mockPhases.mockRejectedValue(new Error('Network request failed'));
    await act(async () => {
      refocus();
    });

    expect(screen.getByTestId('you-phase').props.accessibilityValue?.text).toBe('Cut');
  });

  it('speaks its own hint, not the Sports row hint', async () => {
    // `NavValueRow` hard-coded "Opens your sport toggles" while it had one call
    // site. Harmless then, and silently wrong the moment a second row used it —
    // which is this one.
    render(<YouScreen />);
    const phase = await screen.findByTestId('you-phase');
    const sports = screen.getByTestId('you-sports');
    expect(phase.props.accessibilityHint).not.toBe(sports.props.accessibilityHint);
    expect(sports.props.accessibilityHint).toContain('sport');
  });
});

/**
 * N509 — the header's friends entry point.
 *
 * Same two-piece shape as the Phase row above (`friendCountLabel` mirrors
 * `phaseValue`), so the tests mirror that file's structure: the pure helper
 * on its own, then the same three outcomes through the screen. The property
 * most worth pinning is the one a first-load test cannot see — a failed
 * count must leave `'—'` rather than claiming zero.
 */
describe('what the friends pill says', () => {
  it('withholds until the server has answered, and does not guess', () => {
    expect(friendCountLabel(null, false)).toBe('—');
    expect(friendCountLabel(3, false)).toBe('—');
  });

  it('says "No friends yet" only once the server has confirmed zero', () => {
    expect(friendCountLabel(0, true)).toBe('No friends yet');
  });

  it('counts friends, singular and plural', () => {
    expect(friendCountLabel(1, true)).toBe('1 Friend');
    expect(friendCountLabel(4, true)).toBe('4 Friends');
  });
});

describe('the friends entry point', () => {
  it('shows the confirmed count and opens /friends', async () => {
    mockListFriends.mockResolvedValue([
      { username: 'a', display_name: null, since: '2026-01-01' },
      { username: 'b', display_name: null, since: '2026-01-02' },
    ]);
    render(<YouScreen />);

    const chip = await screen.findByTestId('you-friends');
    await waitFor(() => expect(chip.props.accessibilityValue?.text).toBe('2 Friends'));
    fireEvent.press(chip);
    expect(mockPush).toHaveBeenCalledWith('/friends');
  });

  it('keeps the last known count when a refresh fails', async () => {
    // The same rule the phase and waiting-counts chains already carry: a dead
    // spot must not tell an athlete their friend list emptied.
    mockListFriends.mockResolvedValue([{ username: 'a', display_name: null, since: '2026-01-01' }]);
    render(<YouScreen />);
    const chip = await screen.findByTestId('you-friends');
    await waitFor(() => expect(chip.props.accessibilityValue?.text).toBe('1 Friend'));

    mockListFriends.mockRejectedValue(new Error('Network request failed'));
    await act(async () => {
      refocus();
    });

    expect(screen.getByTestId('you-friends').props.accessibilityValue?.text).toBe('1 Friend');
  });
});

/**
 * N509 — the masthead's avatar.
 *
 * `Avatar` already carries its own coverage (`components/__tests__/Avatar.test.tsx`)
 * for the photo/monogram/failed-load behaviour itself; what is worth pinning
 * HERE is the WIRING — that this screen actually hands it the profile's own
 * `avatar_url` and `username`, not that the component works in isolation.
 */
describe('the masthead avatar', () => {
  it('falls back to the monogram when no avatar has been uploaded', async () => {
    // `Avatar` hides both its own renders from assistive tech (the athlete's
    // name is read right beside it), so — same as the belt render and every
    // badge in this file — the query needs `includeHiddenElements`.
    mockGetProfile.mockResolvedValue({ display_name: 'Rhonda', username: 'rhonda', unit_system: 'metric' });
    render(<YouScreen />);

    expect(
      await screen.findByTestId('avatar-monogram', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.queryByTestId('avatar-photo', { includeHiddenElements: true })).toBeNull();
  });

  it('shows the uploaded photo once the profile carries one', async () => {
    mockGetProfile.mockResolvedValue({
      display_name: 'Rhonda',
      username: 'rhonda',
      unit_system: 'metric',
      avatar_url: 'https://example.com/rhonda.jpg',
    });
    render(<YouScreen />);

    expect(
      await screen.findByTestId('avatar-photo', { includeHiddenElements: true }),
    ).toBeTruthy();
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

/**
 * N181 — what the restructure moved OFF this screen.
 *
 * Two rows left, for two different reasons, and both are asserted from this
 * side because "moved" is only checkable from the screen that lost them. The
 * other side is `libraryBjjEntries.test.tsx` (sequences) and settings' own
 * screen (units); either half alone is satisfied by a copy, which is exactly
 * the point N178's move made and this one inherits.
 */
describe('what N181 moved off You', () => {
  it('no longer carries a Sequences row, with BJJ on', async () => {
    // With BJJ ON, which is the only configuration in which that row was ever
    // drawn here — asserting its absence on a bare account would be true by
    // construction, which is the vacuous-test shape this file already carries a
    // note about for the N178 move.
    mockModules = [{ key: 'bjj', enabled: true }];
    render(<YouScreen />);
    await screen.findByTestId('you-sports');

    expect(screen.queryByTestId('you-sequences')).toBeNull();
    // The Library row is what now stands between this screen and the chains,
    // and its detail line has to say so — a route that exists behind a label
    // nobody reads as "my chains live here" is the #414 gap wearing a hat.
    expect(screen.getByTestId('you-library').props.accessibilityHint).toContain('chains');
  });

  it('no longer carries an inert Units row', async () => {
    // It displayed a preference it could not change, one tap above a Settings
    // row whose own detail line names units. Settings › Preferences › Units is
    // the single home now, and the Settings row here says so.
    mockGetProfile.mockResolvedValue({ display_name: 'Rhonda', unit_system: 'metric' });
    render(<YouScreen />);
    await screen.findByTestId('you-sports');

    expect(screen.queryByText('Units')).toBeNull();
    expect(screen.getByTestId('you-settings').props.accessibilityHint).toContain('Units');
  });
});

/**
 * N181 — the order of the screen IS the product requirement.
 *
 * You answers two questions, in this order: who am I as an athlete, then how is
 * VOLA configured for me. Identity first is an acceptance criterion of #586 and
 * is the thing a refactor silently loses — every row still renders, every test
 * still passes, and the athlete's name has drifted below a settings menu.
 *
 * Asserted on document order rather than on pixel position, which is what RNTL
 * can actually see: `onLayout` never fires here, so nothing is ever measured.
 */
describe('the order of the sections', () => {
  it('leads with the athlete and puts the app last', async () => {
    mockModules = [{ key: 'bjj', enabled: true }];
    render(<YouScreen />);
    await screen.findByTestId('you-section-identity');

    const order = ['you-section-identity', 'you-section-people', 'you-section-app'];
    const found = screen
      .getAllByTestId(/^you-section-/)
      .map((n) => String(n.props.testID));
    expect(found).toEqual(order);
  });

  it('puts the identity block above every destination row', async () => {
    // The criterion in words: "athlete identity is primary — the first thing
    // seen". A section list alone does not pin that, because the identity
    // section could be first and empty.
    mockModules = [{ key: 'bjj', enabled: true }];
    render(<YouScreen />);
    await screen.findByTestId('you-section-identity');

    const ids = screen
      .getAllByTestId(/^you-(section-identity|library|social|shared|settings)$/)
      .map((n) => String(n.props.testID));
    expect(ids[0]).toBe('you-section-identity');
  });

  /**
   * N181 device pass, item 6 (#586) — the belt card shipped ABOVE the name,
   * not below it, and every check above still passed: the belt carries no
   * `you-section-*` testID, so a screen leading with rank instead of name is
   * invisible to them. Updated (not replaced) to close that gap by including
   * `bjj-rank-header` — see the `BjjRankHeader` mock above, which now renders
   * a real testID rather than `null` specifically so this can fail.
   *
   * The user's own words, from the annotated screenshot: *"I think its better
   * to place the name on top."* A name is more identity than a rank — "who am
   * I" reads as a name first, a rank second — so the name has to render
   * before the belt, never after it.
   */
  it("puts the athlete's name above the belt card", async () => {
    mockModules = [{ key: 'bjj', enabled: true }];
    render(<YouScreen />);
    await screen.findByTestId('you-section-identity');

    const ids = screen
      .getAllByTestId(/^(you-section-identity|bjj-rank-header)$/)
      .map((n) => String(n.props.testID));
    expect(ids).toEqual(['you-section-identity', 'bjj-rank-header']);
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
    // it back on under What you train" — N471/#471). Nothing linked to them
    // while they were off, which is why the athlete never reached the screen
    // that would say so.
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
    //
    // `you-sequences` used to be named here as the second survivor. N181 moved
    // that row into the Library, so this line now names the Library row alone —
    // and the sequences half of the claim is made by the two tests above and by
    // `libraryBjjEntries.test.tsx`, which is where a moved thing's presence is
    // supposed to be asserted from.
    expect(screen.getByTestId('you-library')).toBeTruthy();
  });
});
