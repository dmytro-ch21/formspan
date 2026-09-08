import { useEffect } from 'react';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SharedScreen from '../../app/shared/index';
import { shareInboxCount } from '@/lib/shareInbox';

/**
 * The share inbox, which is what makes the Share button a whole feature.
 *
 * The social graph lives on the phone — you add a training partner here — so
 * until this screen existed you could be SENT a plan with no way on this
 * device to answer. What is worth pinning is not the rendering but three
 * pieces of state reconciliation, each of which fails silently:
 *
 *   - accepting must navigate to the RECIPIENT'S new copy. The sender's id is
 *     right there in the card and is the natural thing to reach for, and the
 *     recipient has no permission to open it — a 404 at the end of a
 *     successful accept.
 *   - the accepted row must go BEFORE the navigation, or it stays on screen
 *     and tappable through the transition, and a second tap 404s against a
 *     share that no longer exists.
 *   - a failed LOAD must not render as an empty inbox, which reads as "nobody
 *     sent you anything" when the truth is "we could not ask".
 */

jest.setTimeout(30_000);
// RNTL's async utilities keep their own 1000ms budget, which `jest.setTimeout`
// does not raise — see the note in `workoutDetailScreen.test.tsx`, where the
// first render's module-graph cost blew through it on a cold cache.
configure({ asyncUtilTimeout: 10_000 });

const mockInbox = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockSent = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockAccept = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({}));
const mockDismiss = jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
jest.mock('@/lib/shares', () => ({
  listShareInbox: (...a: unknown[]) => mockInbox(...a),
  listSentShares: (...a: unknown[]) => mockSent(...a),
  acceptShare: (...a: unknown[]) => mockAccept(...a),
  dismissShare: (...a: unknown[]) => mockDismiss(...a),
}));

// `useAuthToken` is deliberately NOT mocked here — `jest.setup.js` provides one
// whose getter is identity-STABLE, and that matters rather than being tidy.
// The obvious local `useAuthToken: () => async () => 'token'` hands back a
// fresh arrow per render, which turns this screen's `load` callback (and the
// effect depending on it) into an infinite refetch loop. Written that way
// first: the accepted row was cleared correctly and then re-fetched back onto
// the screen, and the failure read exactly like a bug in the accept path.
const mockRequestSync = jest.fn();
const mockPlay = jest.fn();
jest.mock('@/lib/sounds', () => ({ playSound: (...a: unknown[]) => mockPlay(...a) }));

jest.mock('@/lib/sync', () => ({
  request: (...a: unknown[]) => mockRequestSync(...a),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

const mockPush = jest.fn();
// `useFocusEffect` is needed even though this screen never calls it —
// `KeyboardAwareScrollView` does, and without a stub every test here dies at
// render with "useFocusEffect is not a function". Dropping it to avoid the
// mock was tried and is what that error was.
//
// `mockUseEffect` rather than `require('react')` inside the factory: the
// sibling test files use the require and each pays a lint warning for it
// against the mobile ratchet. The factory is lazy — it runs at first require,
// after imports have evaluated — and jest's out-of-scope rule allows names
// beginning with `mock`.
const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
}));

const card = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  resource_type: 'workout',
  resource_label: 'Push Day A',
  from: 'rhonda',
  created_at: '2026-08-01T00:00:00Z',
  ...over,
});

beforeEach(() => {
  mockInbox.mockReset().mockResolvedValue([]);
  mockSent.mockReset().mockResolvedValue([]);
  mockAccept.mockReset().mockResolvedValue({ resource_type: 'workout', resource_id: 'new-copy' });
  mockDismiss.mockReset().mockResolvedValue(undefined);
  mockPush.mockReset();
  mockRequestSync.mockReset();
  mockPlay.mockReset();
});

it('opens the RECIPIENT’S copy after accepting, never the sender’s', async () => {
  // `s1` is the share, `w-hers` is the plan on the sender's account, and
  // `new-copy` is what the server just made for this athlete. Only the last
  // one is theirs to open — navigating to either of the others is a 404 at the
  // end of an accept that actually worked.
  mockInbox.mockResolvedValue([card({ id: 's1', resource_id: 'w-hers' })]);

  render(<SharedScreen />);
  fireEvent.press(await screen.findByTestId('share-accept-s1'));

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/workout/new-copy'));
  // And the pull that makes the copy exist on THIS device. It was made
  // server-side, so without this the new plan is absent from the Workouts tab
  // until something else happens to refresh — which reads as a failed accept.
  expect(mockRequestSync).toHaveBeenCalledWith('share-accepted');
});

it('drops the accepted row locally, rather than waiting for a refetch', async () => {
  // A route transition is not instant, so until it lands the accepted card is
  // still on screen and still tappable — and a second tap 404s against a share
  // that no longer exists. Clearing it locally is the honest state anyway: the
  // server has accepted it.
  //
  // The fixture is the assertion. `listShareInbox` KEEPS returning the card, so
  // an implementation that leaned on `reload()` instead would paint it straight
  // back — which is exactly what happens against a server that has not caught
  // up, and what a fixture returning [] afterwards would have hidden.
  //
  // What this does NOT claim is statement order relative to `router.push`.
  // React has not re-rendered by then, so the row is still mounted at that
  // instant whichever way round the two lines go; asserting it from inside a
  // mocked `push` was tried and fails against the correct code.
  mockInbox.mockResolvedValue([card({ id: 's1' })]);

  render(<SharedScreen />);
  fireEvent.press(await screen.findByTestId('share-accept-s1'));

  await waitFor(() => expect(screen.queryByTestId('share-card-s1')).toBeNull());
});

it('accepts a kind it has never heard of, and simply does not navigate', async () => {
  // The right failure for a client older than its server: the copy is made
  // either way, so refusing to accept would strand a real share behind an app
  // update. It just has nowhere to send you.
  mockInbox.mockResolvedValue([card({ id: 's9', resource_type: 'spaceship' })]);
  mockAccept.mockResolvedValue({ resource_type: 'spaceship', resource_id: 'x' });

  render(<SharedScreen />);
  fireEvent.press(await screen.findByTestId('share-accept-s9'));

  await waitFor(() => expect(mockAccept).toHaveBeenCalled());
  expect(mockPush).not.toHaveBeenCalled();
  // And it SAYS the copy is yours. Without this the row simply vanishes and
  // the only signal is its absence, which reads as the tap having failed —
  // the accept is the one thing that definitely worked.
  expect(await screen.findByTestId('shared-landed')).toBeTruthy();
});

it('opens an accepted sequence, rather than describing where it went', async () => {
  // **This test used to assert the opposite**, and it passed: it pinned the
  // copy "your copy is in the Library", which was false in two directions —
  // this app had no sequence route at all, and the Library tab is the
  // technique and exercise catalog, which has never held a chain. Issue #414
  // was filed above every other phone-impossible gap for that reason: the
  // others omit a surface, that one made a claim an athlete would act on.
  //
  // `seq-copy` is the RECIPIENT'S id, same rule as the workout case above.
  mockInbox.mockResolvedValue([card({ id: 's8', resource_type: 'sequence' })]);
  mockAccept.mockResolvedValue({ resource_type: 'sequence', resource_id: 'seq-copy' });

  render(<SharedScreen />);
  fireEvent.press(await screen.findByTestId('share-accept-s8'));

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/sequence/seq-copy'));
  // And nothing is said about where it went, because it went there.
  expect(screen.queryByTestId('shared-landed')).toBeNull();
});

it('never names the Library as where an accepted thing lands', async () => {
  // The fallback message is the surviving half of #414, and it is the half
  // that can rot silently: a `sequence` arm pointing at a screen that never
  // held one sat here for months without a test that could see it. Pinned to
  // the LITERAL word rather than to the message constant — asserting the
  // component renders `LANDED_MESSAGE` would be true however that constant
  // read, which is the true-by-construction shape review caught elsewhere in
  // this repo the day before this landed.
  //
  // Run against the unknown kind, because that is the only arm that still
  // reaches the message at all now that sequences navigate.
  mockInbox.mockResolvedValue([card({ id: 's7', resource_type: 'spaceship' })]);
  mockAccept.mockResolvedValue({ resource_type: 'spaceship', resource_id: 'x' });

  render(<SharedScreen />);
  fireEvent.press(await screen.findByTestId('share-accept-s7'));

  const landed = await screen.findByTestId('shared-landed');
  expect(landed).toHaveTextContent('Accepted — the copy is yours now.');
  expect(screen.queryByText(/Library/)).toBeNull();
});

it('says the load failed rather than showing an empty inbox', async () => {
  // "Nothing waiting" is a claim about other people's actions. Making it when
  // the request failed is the app inventing the absence of a message.
  mockInbox.mockRejectedValue(new Error('Network request failed'));
  mockSent.mockRejectedValue(new Error('Network request failed'));

  render(<SharedScreen />);

  expect(await screen.findByTestId('shared-load-error')).toBeTruthy();
  expect(screen.queryByTestId('shared-inbox-empty')).toBeNull();
});

it('shows the empty inbox when it really is empty', async () => {
  // The arm that makes the previous test mean anything.
  render(<SharedScreen />);
  expect(await screen.findByTestId('shared-inbox-empty')).toBeTruthy();
});

it('says shares vanish either way, even with nothing sent', async () => {
  // Declining DELETES, so a sender who comes back to an empty list is exactly
  // the person about to conclude they were turned down. Rendering the note
  // only beside surviving rows put it everywhere except the moment it is for.
  render(<SharedScreen />);
  await screen.findByTestId('shared-sent-empty');
  expect(await screen.findByText(/don't say which way/)).toBeTruthy();
});

it('confirms an accept out loud, because the row vanishing is otherwise the whole signal', async () => {
  // Accepting navigates away, so the only other feedback is a row
  // disappearing — which reads as much like a failure as a success.
  mockInbox.mockResolvedValue([card({ id: 's1' })]);

  render(<SharedScreen />);
  fireEvent.press(await screen.findByTestId('share-accept-s1'));

  await waitFor(() => expect(mockPlay).toHaveBeenCalledWith('success'));
});

describe('Accept all (N529/#960)', () => {
  it('is absent with one waiting, present with two', async () => {
    // "Accept all" over a single card is a second button for the same tap.
    mockInbox.mockResolvedValue([card({ id: 's1' })]);
    render(<SharedScreen />);
    await screen.findByTestId('share-card-s1');
    expect(screen.queryByTestId('share-accept-all')).toBeNull();
  });

  it('accepts every card, navigates NOWHERE, syncs once, and reports the count', async () => {
    mockInbox.mockResolvedValue([card({ id: 's1' }), card({ id: 's2' }), card({ id: 's3' })]);

    render(<SharedScreen />);
    const all = await screen.findByTestId('share-accept-all');
    expect(all).toHaveTextContent('Accept all 3');
    fireEvent.press(all);

    await waitFor(() => expect(mockAccept).toHaveBeenCalledTimes(3));
    expect(await screen.findByTestId('shared-landed')).toHaveTextContent(
      'Accepted 3 — the copies are yours now.',
    );
    // Three accepts cannot land on three copies, so nobody is sent anywhere.
    expect(mockPush).not.toHaveBeenCalled();
    // ONE pull for all of them, not one per card.
    expect(mockRequestSync).toHaveBeenCalledTimes(1);
    expect(mockRequestSync).toHaveBeenCalledWith('share-accepted');
    expect(mockPlay).toHaveBeenCalledTimes(1);
    // Every card is gone, and so is the button.
    expect(screen.queryByTestId('share-card-s1')).toBeNull();
    expect(screen.queryByTestId('share-card-s3')).toBeNull();
    expect(screen.queryByTestId('share-accept-all')).toBeNull();
    expect(screen.queryByTestId('shared-action-error')).toBeNull();
  });

  it('accepts one after another, never in parallel', async () => {
    // Hold the first accept open and check the second has not been asked for.
    let releaseFirst: (() => void) | undefined;
    mockAccept.mockImplementation((_t: unknown, id: unknown) =>
      id === 's1'
        ? new Promise((res) => {
            releaseFirst = () => res({ resource_type: 'workout', resource_id: 'c1' });
          })
        : Promise.resolve({ resource_type: 'workout', resource_id: 'c2' }),
    );
    mockInbox.mockResolvedValue([card({ id: 's1' }), card({ id: 's2' })]);

    render(<SharedScreen />);
    fireEvent.press(await screen.findByTestId('share-accept-all'));

    await waitFor(() => expect(mockAccept).toHaveBeenCalledTimes(1));
    expect(mockAccept.mock.calls[0][1]).toBe('s1');
    // Both rows are disabled while it runs, and the button says so.
    expect(screen.getByTestId('share-accept-all')).toHaveTextContent('Accepting…');
    expect(screen.getByTestId('share-accept-s2')).toBeDisabled();
    expect(screen.getByTestId('share-decline-s2')).toBeDisabled();

    releaseFirst!();
    await waitFor(() => expect(mockAccept).toHaveBeenCalledTimes(2));
    expect(mockAccept.mock.calls[1][1]).toBe('s2');
  });

  it('keeps a failed card on screen with its error, and reports only what succeeded', async () => {
    // The state this feature exists to get right. s2 is a ghost — taken
    // back a minute ago — and the athlete wants the other two regardless.
    mockAccept.mockImplementation((_t: unknown, id: unknown) =>
      id === 's2'
        ? Promise.reject(new Error('share is gone'))
        : Promise.resolve({ resource_type: 'workout', resource_id: `copy-${String(id)}` }),
    );
    mockInbox.mockResolvedValue([card({ id: 's1' }), card({ id: 's2' }), card({ id: 's3' })]);

    render(<SharedScreen />);
    fireEvent.press(await screen.findByTestId('share-accept-all'));

    await waitFor(() => expect(mockAccept).toHaveBeenCalledTimes(3));
    // The count on screen is the count that happened — "2 of 3", never "2".
    const landed = await screen.findByTestId('shared-landed');
    expect(landed).toHaveTextContent('Accepted 2 of 3 — the copies are yours now.');
    expect(landed).not.toHaveTextContent(/Accepted 2 —/);
    expect(screen.getByTestId('shared-action-error')).toHaveTextContent(/1 didn't go through/);
    // The failed card is still there, wearing its own reason; the others are not.
    expect(screen.getByTestId('share-card-s2')).toBeTruthy();
    expect(screen.getByTestId('share-card-error-s2')).toHaveTextContent('share is gone');
    expect(screen.queryByTestId('share-card-s1')).toBeNull();
    expect(screen.queryByTestId('share-card-s3')).toBeNull();
    // And it is usable again: the loop did not leave the screen stuck busy.
    expect(screen.getByTestId('share-accept-s2')).not.toBeDisabled();
    // The sync still fires once — two copies were made.
    expect(mockRequestSync).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('claims nothing, syncs nothing and stays silent when nothing went through', async () => {
    mockAccept.mockRejectedValue(new Error('offline'));
    mockInbox.mockResolvedValue([card({ id: 's1' }), card({ id: 's2' })]);

    render(<SharedScreen />);
    fireEvent.press(await screen.findByTestId('share-accept-all'));

    await waitFor(() => expect(mockAccept).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('shared-action-error')).toHaveTextContent(
      /None of the 2 went through/,
    );
    expect(screen.queryByTestId('shared-landed')).toBeNull();
    expect(screen.getByTestId('share-card-error-s1')).toHaveTextContent('offline');
    expect(screen.getByTestId('share-card-error-s2')).toHaveTextContent('offline');
    expect(mockRequestSync).not.toHaveBeenCalled();
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('publishes what it shows to the bell, after loading and after accepting', async () => {
    // The badge on every other screen is this list's length — no second
    // request, and no lag behind a card that just vanished.
    mockInbox.mockResolvedValue([card({ id: 's1' }), card({ id: 's2' })]);

    render(<SharedScreen />);
    await screen.findByTestId('share-accept-all');
    expect(shareInboxCount()).toBe(2);

    fireEvent.press(screen.getByTestId('share-accept-all'));
    await waitFor(() => expect(screen.queryByTestId('share-card-s2')).toBeNull());
    await waitFor(() => expect(shareInboxCount()).toBe(0));
  });

  it('publishes to the bell after a DISMISS too, not only after an accept', async () => {
    // The criterion names dismissing as well as accepting, and the two take
    // different routes to the same state: accept filters `inbox` in place,
    // dismiss goes through `reload()`. Only the accept route was pinned, so a
    // change that published from that path alone would have left half the
    // criterion green by accident.
    mockInbox
      .mockResolvedValueOnce([card({ id: 's1' }), card({ id: 's2' })])
      .mockResolvedValue([card({ id: 's1' })]);

    render(<SharedScreen />);
    await screen.findByTestId('share-card-s2');
    expect(shareInboxCount()).toBe(2);

    fireEvent.press(screen.getByTestId('share-decline-s2'));
    await waitFor(() => expect(mockDismiss).toHaveBeenCalled());
    await waitFor(() => expect(shareInboxCount()).toBe(1));
  });
});

it('stays silent when the accept fails', async () => {
  // Without this, moving the chime ABOVE `await acceptShare` reddens nothing —
  // the accept-chime test passes either way. A confirmation that also plays on
  // failure is not a confirmation.
  mockInbox.mockResolvedValue([card({ id: 's1' })]);
  mockAccept.mockRejectedValue(new Error('offline'));

  render(<SharedScreen />);
  fireEvent.press(await screen.findByTestId('share-accept-s1'));

  await waitFor(() => expect(mockAccept).toHaveBeenCalled());
  expect(mockPlay).not.toHaveBeenCalled();
});
