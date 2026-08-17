import { useEffect } from 'react';
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

// The ref the OFF-SCREEN card is attached to, lifted out so a test can assert
// which card was captured — see the capture-source test below.
let captureRef: unknown = null;

function Harness() {
  const share = useSessionShare({
    sessionID: 's1',
    summary,
    formatTonnage: (v) => `${v}kg`,
  });
  // In an effect, not during render. Assigning a module variable while
  // rendering is a side effect, and `react-hooks` treats it as an ERROR in this
  // app — rightly, and it caught this. The ref object identity is stable
  // (`useRef`), so one pass is enough.
  useEffect(() => {
    captureRef = share.cardRef;
  }, [share.cardRef]);
  return (
    <>
      <ShareSessionButton share={share} testID="share-button" />
      <ShareCardHost share={share} />
    </>
  );
}

beforeEach(() => {
  captureRef = null;
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

it('captures the off-screen card, not the one on screen', async () => {
  /*
    The load-bearing decision of this whole change, and until this test it was
    only a comment. Every other case here passes against a build that captures
    the VISIBLE preview card — or a ref that was never attached to anything —
    because none of them looks at what `shareCard` was handed.

    That matters because the off-screen path is the measured one: an off-screen
    card at a known size, which produced a verified 1080x1080 PNG. A card laid
    out inside a `Modal` reopens the "is it genuinely laid out" question that
    hands the athlete a blank image and fails without a word.
  */
  render(<Harness />);
  fireEvent.press(screen.getByTestId('share-button'));
  fireEvent.press(await screen.findByTestId('share-preview-confirm'));

  await waitFor(() => expect(mockShareCard).toHaveBeenCalledTimes(1));

  // Compared as a BOOLEAN, deliberately. `toHaveBeenCalledWith(captureRef)` is
  // the natural way to write this and it aborts the whole runner when it fails:
  // a ref holding a mounted host component is full of circular fiber
  // references, and jest's deep-equality printer walks them until the process
  // dies with SIGABRT and a hex stack. Measured — the mutation that swaps the
  // capture source produced exactly that. Reducing to `=== ` first means a
  // break reports "expected true, received false" and the test name says the
  // rest.
  const capturedTheOffscreenCard = mockShareCard.mock.calls[0][0] === captureRef;
  expect(capturedTheOffscreenCard).toBe(true);
  // And it is genuinely attached — a ref pointing at nothing captures nothing.
  expect((captureRef as { current: unknown }).current == null).toBe(false);
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
  // And it stays OPEN. Reading a dismissal as "they are done" is a plausible
  // implementation that every other assertion here tolerates — and it would
  // make a second attempt cost the whole journey back rather than one tap.
  expect(screen.getByTestId('share-preview')).toBeTruthy();
});

it('does not show a stale error when the preview is reopened', async () => {
  // Cancel after a failure, open again: the old message must be gone. Nothing
  // else here fails a share and then reopens, so `setError(null)` in `preview()`
  // was unpinned.
  mockShareCard.mockResolvedValue({ ok: false, reason: 'capture', message: 'No image was produced.' });
  render(<Harness />);
  fireEvent.press(screen.getByTestId('share-button'));
  fireEvent.press(await screen.findByTestId('share-preview-confirm'));
  expect(await screen.findByText('No image was produced.')).toBeTruthy();

  fireEvent.press(screen.getByTestId('share-preview-cancel'));
  await waitFor(() => expect(screen.queryByTestId('share-preview')).toBeNull());
  fireEvent.press(screen.getByTestId('share-button'));

  expect(await screen.findByTestId('share-preview')).toBeTruthy();
  expect(screen.queryByText('No image was produced.')).toBeNull();
});
