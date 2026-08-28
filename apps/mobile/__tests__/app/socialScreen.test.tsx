import { useCallback, useEffect } from 'react';
import { configure, render, screen, waitFor, within } from '@testing-library/react-native';

import SocialScreen from '../../app/social/index';
import { ApiError } from '@/lib/apiError';

/**
 * The Social screen, tested where it reconciles state rather than where it draws.
 *
 * The property that matters most here has no visual tell: **a failed feed load
 * must never render as "nobody has trained".** That is a claim about other
 * people, invented from a failed request — and `items` starting empty makes
 * the honest implementation and the wrong one look identical unless the test
 * distinguishes them.
 *
 * Second: **a first-run account has no profile row**, so `getProfile` 404s.
 * Left to reject, it takes the whole `Promise.all` with it and a brand new
 * athlete sees "not found" where the feed should be — with the feed, friends
 * and counts calls having all succeeded. That shipped, and review caught it.
 *
 * ## NOT covered here: the single-flight guard
 *
 * A stale load resolving after a refresh must not repaint over fresh rows.
 * A test for it was written and REMOVED rather than left in: with the
 * `useFocusEffect` mock this file uses, the re-focus fired but the screen's
 * `load` did not run for it, so the test failed against correct code and I
 * could not establish why. A test I cannot explain is worse than an
 * acknowledged gap — it would go green one day for a reason nobody chose.
 *
 * The guard itself is the pattern `app/friends/index.tsx` documents and
 * `app/__tests__/sharedScreen.test.tsx` exercises on the same shape, so it is
 * not unexamined; it is untested HERE. Worth a second attempt with a different
 * re-focus mechanism.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockFeed = jest.fn((..._a: unknown[]): Promise<unknown> =>
  Promise.resolve({ items: [], total: 0, limit: 30, offset: 0, window_days: 3 }),
);
jest.mock('@/lib/feed', () => ({
  ...jest.requireActual('@/lib/feed'),
  fetchFeed: (...a: unknown[]) => mockFeed(...a),
}));

const mockFriends = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockCounts = jest.fn((..._a: unknown[]): Promise<Record<string, number>> =>
  Promise.resolve({}),
);
jest.mock('@/lib/friends', () => ({
  listFriends: (...a: unknown[]) => mockFriends(...a),
  getPendingCounts: (...a: unknown[]) => mockCounts(...a),
}));

const mockProfile = jest.fn((..._a: unknown[]): Promise<unknown> =>
  Promise.resolve({ share_training_with_friends: true }),
);
jest.mock('@/lib/profile', () => ({
  getProfile: (...a: unknown[]) => mockProfile(...a),
}));

jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => ({ modules: [], ready: true }) }));
jest.mock('@/lib/UnitsProvider', () => ({
  useUnits: () => ({ units: 'metric', unitsReady: true, setUnits: jest.fn(), unsynced: false }),
}));
jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

const mockPush = jest.fn();
// `mock`-prefixed so jest's out-of-scope rule allows them inside the factory,
// and so no `require('react')` is needed there (each costs a lint warning
// against the mobile ratchet).
//
// Fires once on mount, which is all these tests need. The re-focus apparatus
// `youScreen.test.tsx` uses is deliberately absent — see the note about the
// single-flight test in the header.
const mockUseCallback = useCallback;
const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
  useFocusEffect: (cb: () => void | (() => void)) => {
    const run = mockUseCallback(() => cb(), [cb]);
    mockUseEffect(() => run(), [run]);
  },
}));

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  from: 'rhonda',
  display_name: 'Rhonda',
  sport: 'strength',
  name: 'Push day',
  started_at: '2026-08-07T10:00:00Z',
  ended_at: '2026-08-07T11:00:00Z',
  working_sets: 12,
  tonnage_kg: 4200,
  ...over,
});

beforeEach(() => {
  mockFeed.mockReset().mockResolvedValue({ items: [], total: 0, limit: 30, offset: 0, window_days: 3 });
  mockFriends.mockReset().mockResolvedValue([]);
  mockCounts.mockReset().mockResolvedValue({});
  mockProfile.mockReset().mockResolvedValue({ share_training_with_friends: true });
  mockPush.mockReset();
});

it('says the load failed rather than claiming nobody has trained', async () => {
  // THE POINT OF THIS FILE. "Nothing here yet" is a statement about other
  // people's training; making it from a failed request is the app inventing
  // the absence of something.
  mockFeed.mockRejectedValue(new Error('Network request failed'));

  render(<SocialScreen />);

  expect(await screen.findByTestId('social-error')).toBeTruthy();
  expect(screen.queryByTestId('social-empty')).toBeNull();
});

it('shows the empty state when the feed really is empty', async () => {
  // The arm that makes the previous test mean something.
  mockFriends.mockResolvedValue([{ username: 'rhonda', display_name: null, since: '2026-01-01' }]);
  render(<SocialScreen />);

  expect(await screen.findByTestId('social-empty')).toBeTruthy();
  expect(screen.queryByTestId('social-error')).toBeNull();
});

it('still loads for a first-run account with no profile yet', async () => {
  // `getProfile` 404s until an athlete saves one. Inside a `Promise.all` that
  // rejected the whole load, so the feed — which had succeeded — never showed.
  mockProfile.mockRejectedValue(new ApiError('profile not found', 'not_found', 404));
  mockFeed.mockResolvedValue({ items: [session()], total: 1, limit: 30, offset: 0, window_days: 3 });

  render(<SocialScreen />);

  expect(await screen.findByTestId('feed-s1')).toBeTruthy();
  expect(screen.queryByTestId('social-error')).toBeNull();
  // And with no profile, nothing has been opted into — so the nudge shows.
  expect(screen.getByTestId('social-nudge')).toBeTruthy();
});

it('renders who trained, not just what', async () => {
  mockFeed.mockResolvedValue({ items: [session()], total: 1, limit: 30, offset: 0, window_days: 3 });
  render(<SocialScreen />);

  await screen.findByTestId('feed-s1');
  // One composed label per row: walking who/when/what/chips as separate stops
  // is four-plus swipes to read one card on a screen that is nothing but cards.
  const row = screen.getByTestId('feed-s1');
  expect(row.props.accessibilityLabel).toContain('Rhonda');
  expect(row.props.accessibilityLabel).toContain('Push day');
  expect(row.props.accessibilityLabel).toContain('12 sets');
});

it('offers the nudge only to someone who has not opted in', async () => {
  // Seeing a friend's training does not require sharing your own — the gate is
  // entirely on the OWNER's opt-in — so this is an offer, and it must not
  // appear to somebody who already accepted it.
  mockProfile.mockResolvedValue({ share_training_with_friends: true });
  render(<SocialScreen />);

  await waitFor(() => expect(screen.queryByTestId('social-empty')).toBeTruthy());
  expect(screen.queryByTestId('social-nudge')).toBeNull();
});

// N13 (#379): the window used to be two hardcoded "3 days" strings on this
// screen, tied to nothing. These pin the copy to `window_days` FROM THE
// RESPONSE, not to the number 3 itself — changing the server's window (the
// acceptance criteria's own worked example is 7) must change what these
// render, with no touch to this file.
it('states the feed window using window_days from the response, not a hardcoded number', async () => {
  mockFriends.mockResolvedValue([{ username: 'rhonda', display_name: null, since: '2026-01-01' }]);
  mockFeed.mockResolvedValue({ items: [], total: 0, limit: 30, offset: 0, window_days: 7 });

  render(<SocialScreen />);

  const empty = await screen.findByTestId('social-empty');
  // A plain string here would be checked for an EXACT match against the
  // testID's full text content (RN's toHaveTextContent, unlike jest-dom's,
  // does not default to substring) — a regex is what asks "does this text
  // appear anywhere", which is the actual question.
  expect(empty).toHaveTextContent(/7 days/);
  expect(empty).not.toHaveTextContent(/3 days/);
});

it('pluralizes a one-day window correctly', async () => {
  mockFeed.mockResolvedValue({
    items: [session()],
    total: 1,
    limit: 30,
    offset: 0,
    window_days: 1,
  });

  render(<SocialScreen />);

  await screen.findByTestId('feed-s1');
  const note = await screen.findByText(/Showing the last/);
  // toHaveTextContent, not `.props.children.join('')` — the latter assumes
  // the Text node's children arrive as an array, which is true today only
  // because the copy is interpolated JSX; toHaveTextContent reads the
  // rendered text regardless of how it got composed. `\b` after each pattern
  // is what tells "1 day" and "1 days" apart — a plain `toContain('1 day')`
  // would also match "1 days", so the negative assertion is load-bearing
  // (mutation-verified: an always-plural windowLabel fails this test).
  expect(note).toHaveTextContent(/1 day\b/);
  expect(note).not.toHaveTextContent(/1 days\b/);
});

/**
 * N205: `FeedRow` must render the REAL Avatar component instead of calling
 * `monogramFor` directly. `Avatar`'s own testIDs (`avatar-photo` /
 * `avatar-monogram`, pinned in `components/__tests__/Avatar.test.tsx`) are
 * the evidence — a hand-rolled disc computed inline would produce neither.
 */
describe('avatars (N205)', () => {
  it('renders the uploaded avatar for a friend who has one', async () => {
    mockFeed.mockResolvedValue({
      items: [session({ avatar_url: 'https://example.test/rhonda.jpg' })],
      total: 1,
      limit: 30,
      offset: 0,
      window_days: 3,
    });

    render(<SocialScreen />);

    const row = await screen.findByTestId('feed-s1');
    expect(within(row).getByTestId('avatar-photo')).toBeTruthy();
    expect(within(row).queryByTestId('avatar-monogram', { includeHiddenElements: true })).toBeNull();
  });

  it('falls back to the monogram for a friend with no avatar', async () => {
    mockFeed.mockResolvedValue({ items: [session()], total: 1, limit: 30, offset: 0, window_days: 3 });

    render(<SocialScreen />);

    const row = await screen.findByTestId('feed-s1');
    expect(within(row).getByTestId('avatar-monogram', { includeHiddenElements: true })).toBeTruthy();
    expect(within(row).queryByTestId('avatar-photo')).toBeNull();
  });
});
