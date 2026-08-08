import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ShareToFriend } from '../ShareToFriend';
import { ApiError } from '@/lib/apiError';

/**
 * The share sheet, tested where it reconciles state rather than where it draws.
 *
 * Two of these three are cases the sheet reports the OPPOSITE of the truth if
 * written the obvious way, and neither is visible by using the app:
 *
 *   - a 409 means "already unanswered in their inbox" — the outcome the sender
 *     wanted. Rendered as an error it makes a successful no-op look broken, and
 *     the sender re-sends, and it 409s again.
 *   - a FAILED friends load rendered as the empty state says "you have no
 *     friends" when the truth is "we could not ask". That one is not merely
 *     wrong, it is unkind, and it is the natural shape: `friends` starts empty.
 */

jest.setTimeout(30_000);
// The module-graph instantiation cost, which `jest.setTimeout` does NOT cover
// — RNTL's async utilities keep their own 1000ms budget. See the long note in
// `app/__tests__/workoutDetailScreen.test.tsx`, where it failed on a cold cache.
configure({ asyncUtilTimeout: 10_000 });

const mockListFriends = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/friends', () => ({
  listFriends: (...a: unknown[]) => mockListFriends(...a),
}));

const mockPlay = jest.fn();
jest.mock('@/lib/sounds', () => ({ playSound: (...a: unknown[]) => mockPlay(...a) }));

const mockShareResource = jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
jest.mock('@/lib/shares', () => ({
  ...jest.requireActual('@/lib/shares'),
  shareResource: (...a: unknown[]) => mockShareResource(...a),
}));

// `useAuthToken` is deliberately NOT mocked — `jest.setup.js` provides an
// identity-STABLE getter, and a local `() => async () => 'token'` returns a
// fresh arrow per render, which turns the friends-load effect into a refetch
// loop. `lib/useAuthToken.ts` exists for that reason and records three live
// bugs it caused.

const friend = (username: string, display_name: string | null = null) => ({
  username,
  display_name,
  since: '2026-08-01T00:00:00Z',
});

beforeEach(() => {
  mockListFriends.mockReset().mockResolvedValue([friend('rhonda')]);
  mockShareResource.mockReset().mockResolvedValue(undefined);
  mockPlay.mockReset();
});

async function openSheet() {
  render(<ShareToFriend resourceType="workout" resourceId="w1" />);
  fireEvent.press(screen.getByTestId('share-open'));
  return screen.findByTestId('share-sheet');
}

it('does not fetch the friends list until the sheet is opened', async () => {
  // Most visits to a plan are not visits to share it, and the friends list is
  // somebody else's data — fetched when it is about to be shown, not on mount.
  render(<ShareToFriend resourceType="workout" resourceId="w1" />);
  expect(mockListFriends).not.toHaveBeenCalled();

  fireEvent.press(screen.getByTestId('share-open'));
  await waitFor(() => expect(mockListFriends).toHaveBeenCalled());
});

it('treats "already sent" as sent, not as a failure', async () => {
  // The server's 409 says it is ALREADY sitting unanswered in their inbox,
  // which is exactly what the sender wanted. `code` is contract; the message
  // is not, so this must not pattern-match the text.
  mockShareResource.mockRejectedValue(
    new ApiError("you already sent them this, and they haven't answered yet", 'already_exists', 409),
  );

  await openSheet();
  fireEvent.press(await screen.findByTestId('share-to-rhonda'));

  expect(await screen.findByText('Sent ✓')).toBeTruthy();
  expect(screen.queryByText(/already sent them this/)).toBeNull();
});

it('reports a real failure rather than claiming it sent', async () => {
  // The other side of the same branch: any code that is NOT already_exists is
  // a genuine miss, and swallowing it would tell the sender their plan went to
  // somebody who never received it.
  mockShareResource.mockRejectedValue(
    new ApiError('no such share, or nothing to share it with', 'not_found', 404),
  );

  await openSheet();
  fireEvent.press(await screen.findByTestId('share-to-rhonda'));

  expect(await screen.findByText(/nothing to share it with/)).toBeTruthy();
  expect(screen.queryByText('Sent ✓')).toBeNull();
});

it('says the list could not be loaded, never that you have no friends', async () => {
  // `friends` is null until it loads and [] when it is genuinely empty. Ship
  // one variable for both and a network failure renders as "Nobody yet" — an
  // app telling a person they have no training partners because its own
  // request timed out.
  mockListFriends.mockRejectedValue(new Error('Network request failed'));

  await openSheet();

  expect(await screen.findByText('Network request failed')).toBeTruthy();
  expect(screen.queryByText(/Nobody yet/)).toBeNull();
  // And a way out that is not close-and-reopen, which nothing announces.
  expect(screen.getByTestId('share-retry')).toBeTruthy();
});

it('does show the empty state when the list really is empty', async () => {
  // The arm that makes the previous test mean something: [] must still say so.
  mockListFriends.mockResolvedValue([]);

  await openSheet();

  expect(await screen.findByText(/Nobody yet/)).toBeTruthy();
});

it('sends the resource it was given, not one it inferred', async () => {
  await openSheet();
  fireEvent.press(await screen.findByTestId('share-to-rhonda'));

  await waitFor(() =>
    expect(mockShareResource).toHaveBeenCalledWith(
      expect.any(Function),
      'rhonda',
      'workout',
      'w1',
    ),
  );
});

it('confirms a send out loud — there is no toast, only a row changing to "Sent ✓"', async () => {
  await openSheet();
  fireEvent.press(await screen.findByTestId('share-to-rhonda'));

  expect(await screen.findByText('Sent ✓')).toBeTruthy();
  expect(mockPlay).toHaveBeenCalledWith('success');
});

it('confirms an "already sent" the same way, because the outcome is the same', async () => {
  // A 409 means it is already sitting unanswered in their inbox — what the
  // sender wanted, and what the UI already renders identically. A silent
  // second tap would read as the press having missed.
  mockShareResource.mockRejectedValue(
    new ApiError("you already sent them this, and they haven't answered yet", 'already_exists', 409),
  );

  await openSheet();
  fireEvent.press(await screen.findByTestId('share-to-rhonda'));

  expect(await screen.findByText('Sent ✓')).toBeTruthy();
  expect(mockPlay).toHaveBeenCalledWith('success');
});

it('stays silent when the send really failed', async () => {
  // The case that makes the other two mean anything: a confirmation that also
  // plays on failure is not a confirmation.
  mockShareResource.mockRejectedValue(new ApiError('the server fell over', 'internal', 500));

  await openSheet();
  fireEvent.press(await screen.findByTestId('share-to-rhonda'));

  await waitFor(() => expect(screen.getByText(/fell over/)).toBeTruthy());
  expect(mockPlay).not.toHaveBeenCalled();
});
