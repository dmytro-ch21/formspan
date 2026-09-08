import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ShareBell } from '../ShareBell';
import { publishShareInboxCount, setShareInboxIdentity } from '@/lib/shareInbox';

/**
 * The bell (N529/#960) — the three states it can be in, and the one it must
 * never be in.
 *
 * Unknown and zero both render the bell with no badge; a count renders the
 * badge. The state that must not exist is a badge reading "0" after a failed
 * read — that is a claim that nothing is waiting, made from not having asked.
 * `badgeLabel` is pinned in `lib/__tests__/shareInbox.test.ts`; this file
 * proves the decision reaches the render, and that the bell is a real
 * control that goes somewhere.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockList = jest.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
jest.mock('@/lib/shares', () => ({
  listShareInbox: (...a: unknown[]) => mockList(...a),
}));

const mockPush = jest.fn();
const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  // Runs the callback as an effect, so "on focus" is "on mount" here — which
  // is what lets the failed-read test drive a real refresh through the bell.
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
}));

const token = async () => 'tok';
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

// The badge is hidden from assistive technology on purpose (the pressable's
// own label already says "3 waiting"), and RNTL excludes hidden elements by
// default — so every badge query, INCLUDING the ones asserting absence, opts
// in. A `queryByText('0')` that could not see a hidden "0" would pass the
// failed-read test for the wrong reason.
const hidden = { includeHiddenElements: true } as const;

beforeEach(async () => {
  mockList.mockReset().mockResolvedValue([]);
  mockPush.mockReset();
  setShareInboxIdentity(null);
  await settle();
});

it('is always there, with no badge while nothing is known', () => {
  render(<ShareBell />);
  expect(screen.getByTestId('share-bell')).toBeTruthy();
  expect(screen.queryByTestId('share-bell-badge', hidden)).toBeNull();
  expect(screen.getByLabelText('Shares')).toBeTruthy();
});

it('shows the count as a badge and says it as a sentence', async () => {
  render(<ShareBell />);
  act(() => publishShareInboxCount(3));

  expect(await screen.findByTestId('share-bell-badge', hidden)).toHaveTextContent('3');
  expect(screen.getByLabelText('Shares, 3 waiting')).toBeTruthy();
});

it('shows no badge at zero — not a "0"', async () => {
  render(<ShareBell />);
  act(() => publishShareInboxCount(3));
  await screen.findByTestId('share-bell-badge', hidden);

  act(() => publishShareInboxCount(0));
  await waitFor(() => expect(screen.queryByTestId('share-bell-badge', hidden)).toBeNull());
  expect(screen.queryByText('0', hidden)).toBeNull();
  expect(screen.getByLabelText('Shares')).toBeTruthy();
});

it('shows no badge after a FAILED read — and not "0" either', async () => {
  // The read goes through the bell's own focus refresh: identity set, the
  // store asks, the server says no. What renders must be the bell alone.
  mockList.mockRejectedValue(new Error('Network request failed'));
  setShareInboxIdentity(token);
  await settle();

  render(<ShareBell />);
  await waitFor(() => expect(mockList).toHaveBeenCalled());
  await settle();

  expect(screen.getByTestId('share-bell')).toBeTruthy();
  expect(screen.queryByTestId('share-bell-badge', hidden)).toBeNull();
  expect(screen.queryByText('0', hidden)).toBeNull();
  expect(screen.getByLabelText('Shares')).toBeTruthy();
});

it('reflects a count the read did find', async () => {
  // The arm that makes the failed-read test mean something: the same path,
  // with the server answering.
  mockList.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
  setShareInboxIdentity(token);

  render(<ShareBell />);

  expect(await screen.findByTestId('share-bell-badge', hidden)).toHaveTextContent('2');
});

it('opens the share inbox', () => {
  render(<ShareBell />);
  fireEvent.press(screen.getByTestId('share-bell'));
  expect(mockPush).toHaveBeenCalledWith('/shared');
});

it('refreshes on focus', async () => {
  setShareInboxIdentity(token);
  await settle();
  const before = mockList.mock.calls.length;

  // Past the throttle window, so the focus read is not skipped.
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  render(<ShareBell />);
  await waitFor(() => expect(mockList.mock.calls.length).toBe(before + 1));
  now.mockRestore();
});
