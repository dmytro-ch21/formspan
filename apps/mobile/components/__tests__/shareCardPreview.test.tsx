import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import {
  ShareCardHost,
  ShareSessionButton,
  useSessionShare,
} from '@/components/SessionShare';
import type { SessionSummary } from '@/lib/celebration';

/**
 * F2: the card is seen before it is posted.
 *
 * The only look an athlete got at a shared card was the share sheet's
 * thumbnail — roughly 40pt square. The card carries a CALORIE FIGURE INFERRED
 * FROM BODY DATA and a VOLA score, so those were going out sight-unseen:
 * numbers about someone's body, published to whichever app they picked, with no
 * chance to read them first.
 *
 * What these pin is the ORDER — that tapping Share opens a preview and captures
 * nothing. A test that only asserted "the preview exists" would pass against a
 * build that showed the preview *and* posted anyway, which is the failure worth
 * preventing.
 */

const mockShareCard = jest.fn();
jest.mock('@/lib/shareCard', () => ({
  shareCard: (...a: unknown[]) => mockShareCard(...a),
}));

// The server's decorating numbers never arrive in this test — the card is
// complete without them, which is why the export does not wait on them.
jest.mock('@/lib/sessionCardApi', () => ({
  getSessionCard: jest.fn(() => new Promise(() => {})),
}));

const summary: SessionSummary = {
  title: 'Lower — Squat & Hinge',
  sport: 'strength',
  durationSeconds: 3600,
  exercises: 3,
  sets: 9,
  reps: 45,
  tonnageKg: 4200,
  hardestRpe: 8,
  records: [],
  recordExerciseIDs: [],
};

function Harness() {
  const share = useSessionShare({
    sessionID: 's1',
    summary,
    formatTonnage: (v) => `${v}kg`,
  });
  return (
    <>
      <ShareSessionButton share={share} testID="share-button" />
      <ShareCardHost share={share} />
    </>
  );
}

beforeEach(() => {
  mockShareCard.mockReset().mockResolvedValue({ ok: true });
});

it('opens the preview instead of posting, and captures nothing yet', async () => {
  render(<Harness />);

  // Not open until asked. The off-screen capture card is always mounted, so
  // asserting on the preview's own testID is what distinguishes them.
  expect(screen.queryByTestId('share-preview')).toBeNull();

  fireEvent.press(screen.getByTestId('share-button'));

  expect(await screen.findByTestId('share-preview')).toBeTruthy();
  // THE ASSERTION. Showing the card and posting it anyway would satisfy every
  // other check in this file.
  expect(mockShareCard).not.toHaveBeenCalled();
});

it('backs out without posting', async () => {
  render(<Harness />);
  fireEvent.press(screen.getByTestId('share-button'));
  fireEvent.press(await screen.findByTestId('share-preview-cancel'));

  await waitFor(() => expect(screen.queryByTestId('share-preview')).toBeNull());
  expect(mockShareCard).not.toHaveBeenCalled();
});

it('posts only from inside the preview', async () => {
  render(<Harness />);
  fireEvent.press(screen.getByTestId('share-button'));
  fireEvent.press(await screen.findByTestId('share-preview-confirm'));

  await waitFor(() => expect(mockShareCard).toHaveBeenCalledTimes(1));
  // Closed on success — the athlete is back where they were, having posted.
  await waitFor(() => expect(screen.queryByTestId('share-preview')).toBeNull());
});

it('keeps the preview up when the capture fails, with the reason on it', async () => {
  // A blank PNG is the failure this whole flow exists around. Dropping back to
  // the session screen would hide both the message and the card it is about.
  mockShareCard.mockResolvedValue({ ok: false, reason: 'capture', message: 'No image was produced.' });

  render(<Harness />);
  fireEvent.press(screen.getByTestId('share-button'));
  fireEvent.press(await screen.findByTestId('share-preview-confirm'));

  expect(await screen.findByText('No image was produced.')).toBeTruthy();
  expect(screen.getByTestId('share-preview')).toBeTruthy();
});

it('stays quiet when the share sheet is merely dismissed', async () => {
  // `failed` is the libraries disagreeing about whether a dismissal rejects.
  // Treating it as an error would accuse the athlete of a fault for changing
  // their mind — and the preview stays up, so they can simply try again.
  mockShareCard.mockResolvedValue({ ok: false, reason: 'failed', message: 'User dismissed' });

  render(<Harness />);
  fireEvent.press(screen.getByTestId('share-button'));
  fireEvent.press(await screen.findByTestId('share-preview-confirm'));

  await waitFor(() => expect(mockShareCard).toHaveBeenCalled());
  expect(screen.queryByText('User dismissed')).toBeNull();
});
