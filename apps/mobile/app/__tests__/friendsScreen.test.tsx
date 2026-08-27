/**
 * Which friend actions confirm out loud, and — more importantly — which do not.
 *
 * Five actions route through this screen's `act()` helper and THREE of them are
 * removals: decline a request, cancel one you sent, unfriend someone. A
 * confirmation chime on any of those celebrates ending a relationship, which is
 * the kind of thing nobody notices in review and everybody notices on a phone.
 *
 * `confirms` is opt-in per call site precisely so that cannot happen by
 * accident, and this file is what stops the opt-in spreading. If a future
 * change keys the chime off the action name or moves it into `act` itself,
 * the removal tests below go red.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import FriendsScreen from '../friends/index';

const mockPlay = jest.fn();
jest.mock('@/lib/sounds', () => ({ playSound: (...a: unknown[]) => mockPlay(...a) }));

const mockListFriends = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockListRequests = jest.fn((..._a: unknown[]): Promise<unknown> =>
  Promise.resolve({ incoming: [], outgoing: [] }),
);
const mockAcceptRequest = jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const mockRemoveFriend = jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const mockSendFriendRequest = jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const mockLookupUser = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(null));

// Spread the real module rather than listing exports: a helper added to
// `lib/friends` later must not silently arrive here as `undefined`. That
// mistake cost five timing-out tests on the YOU screen once already.
jest.mock('@/lib/friends', () => ({
  ...jest.requireActual('@/lib/friends'),
  listFriends: (...a: unknown[]) => mockListFriends(...a),
  listRequests: (...a: unknown[]) => mockListRequests(...a),
  acceptRequest: (...a: unknown[]) => mockAcceptRequest(...a),
  removeFriend: (...a: unknown[]) => mockRemoveFriend(...a),
  sendFriendRequest: (...a: unknown[]) => mockSendFriendRequest(...a),
  lookupUser: (...a: unknown[]) => mockLookupUser(...a),
}));

const card = (username: string, over: Record<string, unknown> = {}) => ({
  username,
  display_name: null,
  since: '2026-08-01T00:00:00Z',
  ...over,
});

beforeEach(() => {
  mockPlay.mockReset();
  mockListFriends.mockReset().mockResolvedValue([]);
  mockListRequests.mockReset().mockResolvedValue({ incoming: [card('rhonda')], outgoing: [] });
  mockAcceptRequest.mockReset().mockResolvedValue(undefined);
  mockRemoveFriend.mockReset().mockResolvedValue(undefined);
  mockSendFriendRequest.mockReset().mockResolvedValue(undefined);
  mockLookupUser.mockReset().mockResolvedValue(null);
});

it('confirms accepting a friend request', async () => {
  render(<FriendsScreen />);
  fireEvent.press(await screen.findByTestId('friends-accept-rhonda'));

  await waitFor(() => expect(mockAcceptRequest).toHaveBeenCalled());
  expect(mockPlay).toHaveBeenCalledWith('success');
});

it('stays SILENT when declining a request', async () => {
  // The one that matters. Declining runs through the same `act()` helper as
  // accepting and calls `removeFriend` — so anything that confirms on "the
  // action succeeded" rather than on an explicit opt-in chimes here too.
  render(<FriendsScreen />);
  fireEvent.press(await screen.findByTestId('friends-decline-rhonda'));

  await waitFor(() => expect(mockRemoveFriend).toHaveBeenCalled());
  expect(mockPlay).not.toHaveBeenCalled();
});

it('stays silent when a request genuinely fails', async () => {
  // A confirmation that also plays on failure is not a confirmation.
  mockAcceptRequest.mockRejectedValue(new Error('offline'));

  render(<FriendsScreen />);
  fireEvent.press(await screen.findByTestId('friends-accept-rhonda'));

  await waitFor(() => expect(mockAcceptRequest).toHaveBeenCalled());
  expect(mockPlay).not.toHaveBeenCalled();
});

it('confirms SENDING a friend request', async () => {
  // The fourth moment. Without this, dropping `confirms: true` from the add
  // call site reddens nothing and the chime silently disappears.
  mockLookupUser.mockResolvedValue({ username: 'kai', display_name: null });

  render(<FriendsScreen />);
  fireEvent.changeText(await screen.findByTestId('friends-search'), 'kai');
  fireEvent.press(screen.getByTestId('friends-search-go'));
  fireEvent.press(await screen.findByTestId('friends-add'));

  await waitFor(() => expect(mockSendFriendRequest).toHaveBeenCalled());
  expect(mockPlay).toHaveBeenCalledWith('success');
});

/**
 * N205: this screen must render the REAL Avatar component for each row —
 * friends, incoming requests, and outgoing requests all share `FriendCard` —
 * not a monogram computed inline. `Avatar`'s own testIDs (`avatar-photo` /
 * `avatar-monogram`, pinned in `components/__tests__/Avatar.test.tsx`) are
 * the evidence: a hand-rolled disc would not produce either one.
 */
describe('avatars (N205)', () => {
  it('renders the uploaded avatar for a friend who has one', async () => {
    mockListFriends.mockResolvedValue([card('gina', { avatar_url: 'https://example.test/gina.jpg' })]);

    render(<FriendsScreen />);

    const row = await screen.findByTestId('friends-row-gina');
    expect(within(row).getByTestId('avatar-photo')).toBeTruthy();
    expect(within(row).queryByTestId('avatar-monogram', { includeHiddenElements: true })).toBeNull();
  });

  it('falls back to the monogram for a friend with no avatar', async () => {
    mockListFriends.mockResolvedValue([card('hank')]);

    render(<FriendsScreen />);

    const row = await screen.findByTestId('friends-row-hank');
    expect(within(row).getByTestId('avatar-monogram', { includeHiddenElements: true })).toBeTruthy();
    expect(within(row).queryByTestId('avatar-photo')).toBeNull();
  });

  it('renders avatars on incoming and outgoing request rows too', async () => {
    mockListRequests.mockResolvedValue({
      incoming: [card('rhonda', { avatar_url: 'https://example.test/rhonda.jpg' })],
      outgoing: [card('sam')],
    });

    render(<FriendsScreen />);

    const incoming = await screen.findByTestId('friends-incoming-rhonda');
    expect(within(incoming).getByTestId('avatar-photo')).toBeTruthy();

    const outgoing = await screen.findByTestId('friends-outgoing-sam');
    expect(within(outgoing).getByTestId('avatar-monogram', { includeHiddenElements: true })).toBeTruthy();
  });

  // The fourth wiring site: the search-result card is fed by `PublicProfile`
  // (lookupUser), not `FriendCard` — a different type sharing the same
  // `avatar_url` field, so this is not redundant with the three tests above.
  it('renders the real avatar on the search-result card too', async () => {
    mockLookupUser.mockResolvedValue({
      username: 'kai',
      display_name: null,
      avatar_url: 'https://example.test/kai.jpg',
    });

    render(<FriendsScreen />);
    fireEvent.changeText(await screen.findByTestId('friends-search'), 'kai');
    fireEvent.press(screen.getByTestId('friends-search-go'));

    const result = await screen.findByTestId('friends-result');
    expect(within(result).getByTestId('avatar-photo')).toBeTruthy();
    expect(within(result).queryByTestId('avatar-monogram', { includeHiddenElements: true })).toBeNull();
  });

  it('falls back to the monogram on the search-result card for someone with no avatar', async () => {
    mockLookupUser.mockResolvedValue({ username: 'leo', display_name: null });

    render(<FriendsScreen />);
    fireEvent.changeText(await screen.findByTestId('friends-search'), 'leo');
    fireEvent.press(screen.getByTestId('friends-search-go'));

    const result = await screen.findByTestId('friends-result');
    expect(within(result).getByTestId('avatar-monogram', { includeHiddenElements: true })).toBeTruthy();
    expect(within(result).queryByTestId('avatar-photo')).toBeNull();
  });
});
