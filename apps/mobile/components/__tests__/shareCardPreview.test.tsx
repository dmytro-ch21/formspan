import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import {
  ShareCardHost,
  ShareSessionButton,
  useSessionShare,
} from '@/components/SessionShare';
import type { SessionSummary } from '@/lib/celebration';
import { MOUNTAINS, mountainFor } from '@/lib/mountains';

const mockManipulate = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...a: unknown[]) => mockManipulate(...a),
}));

const mockRequestCamera = jest.fn();
const mockLaunchCamera = jest.fn();
const mockRequestLibrary = jest.fn();
const mockLaunchLibrary = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: (...a: unknown[]) => mockRequestCamera(...a),
  launchCameraAsync: (...a: unknown[]) => mockLaunchCamera(...a),
  requestMediaLibraryPermissionsAsync: (...a: unknown[]) => mockRequestLibrary(...a),
  launchImageLibraryAsync: (...a: unknown[]) => mockLaunchLibrary(...a),
}));

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
  // Real value, not a mock: N449's resize call (`pickBackgroundPhoto` in
  // `SessionShare.tsx`) imports this from the same module, and mocking the
  // whole module out from under it would silently turn the resize target
  // into `undefined` rather than the real export width — see the "resizes"
  // test below, which is the one this would otherwise defeat.
  CARD_EXPORT_WIDTH: 1080,
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

function Harness({ sessionID = 's1' }: { sessionID?: string } = {}) {
  const share = useSessionShare({
    sessionID,
    summary,
    formatTonnage: (v) => `${v}kg`,
    formatWeight: (v) => `${v}kg`,
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
  mockManipulate.mockReset().mockResolvedValue({ uri: 'file:///cache/resized-1080.jpg' });
  mockRequestCamera.mockReset().mockResolvedValue({ granted: true });
  mockRequestLibrary.mockReset().mockResolvedValue({ granted: true });
  mockLaunchCamera.mockReset();
  mockLaunchLibrary
    .mockReset()
    .mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///picked-from-library.jpg' }] });
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

/**
 * N449 (#747): an athlete's own photo, in place of the deterministic
 * mountain.
 *
 * These pin the thing `sessionCardBackgroundPhoto.test.tsx` cannot reach —
 * the picker's wiring through `useSessionShare` and into the actual card
 * `ShareCardHost` mounts — rather than `SessionCard`'s own rendering of a
 * `backgroundUri` prop it is simply handed. Between the two: a build that
 * wired the picker to the wrong piece of state, or that mutated the wrong
 * card, still fails here even though `SessionCard` itself is innocent.
 */
describe('replacing the mountain with a photo (N449/#747)', () => {
  /**
   * Every `SessionCard` mount in the tree — the off-screen capture source
   * AND, once the preview is open, the visible one — shares the SAME `card`
   * object from the hook. Asserting on all of them (rather than picking one
   * by position) is what makes this test agnostic to which one `captureRef`
   * actually reads, while still proving the off-screen one is among them.
   */
  function photoSources() {
    // `includeHiddenElements` — the off-screen host is deliberately marked
    // hidden from assistive tech (see `ShareCardHost`'s own comment on why),
    // and RNTL's default queries skip anything behind that flag, the same
    // reason `Avatar.test.tsx` needs it for the hidden monogram.
    return screen
      .getAllByTestId('session-card-photo', { includeHiddenElements: true })
      .map((el) => el.props.source);
  }

  it('starts on the deterministic mountain, before any photo is picked', async () => {
    render(<Harness />);
    // The off-screen host is mounted unconditionally, before the preview is
    // ever opened — see ShareCardHost's file comment.
    expect(photoSources()).toEqual([MOUNTAINS[mountainFor('s1')]]);
  });

  it('threads a library photo onto every mount of the card, including the off-screen one captureRef reads', async () => {
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-library'));
    });

    await waitFor(() =>
      expect(photoSources().every((s) => s?.uri === 'file:///cache/resized-1080.jpg')).toBe(true),
    );
    // Never posted on its own — picking a photo is not sharing.
    expect(mockShareCard).not.toHaveBeenCalled();
  });

  it('threads a camera photo the same way, via the camera permission/launch pair', async () => {
    mockLaunchCamera.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///camera/IMG_1.heic' }],
    });
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-camera'));
    });

    await waitFor(() =>
      expect(photoSources().every((s) => s?.uri === 'file:///cache/resized-1080.jpg')).toBe(true),
    );
    expect(mockRequestCamera).toHaveBeenCalled();
    expect(mockLaunchCamera).toHaveBeenCalled();
    expect(mockRequestLibrary).not.toHaveBeenCalled();
  });

  it('resizes the picked frame to the export width rather than rendering the raw camera frame', async () => {
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-library'));
    });

    await waitFor(() => expect(mockManipulate).toHaveBeenCalled());
    expect(mockManipulate).toHaveBeenCalledWith(
      'file:///picked-from-library.jpg',
      [{ resize: { width: 1080 } }],
      // `compress: 1` — deliberately not the network path's 0.8: this photo
      // never leaves the phone, so there is nothing to shrink a transfer for.
      { compress: 1 },
    );
  });

  it('lets the athlete go back to the mountain after picking a photo', async () => {
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');
    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-library'));
    });
    await waitFor(() =>
      expect(photoSources().every((s) => s?.uri === 'file:///cache/resized-1080.jpg')).toBe(true),
    );

    fireEvent.press(screen.getByTestId('share-photo-clear'));

    await waitFor(() =>
      expect(photoSources().every((s) => s === MOUNTAINS[mountainFor('s1')])).toBe(true),
    );
  });

  it('declines the library picker when photo-library permission is refused, and leaves the mountain in place', async () => {
    mockRequestLibrary.mockResolvedValue({ granted: false });
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-library'));
    });

    expect(await screen.findByText(/needs access to your photos/i)).toBeTruthy();
    expect(mockLaunchLibrary).not.toHaveBeenCalled();
    expect(mockManipulate).not.toHaveBeenCalled();
    expect(photoSources().every((s) => s === MOUNTAINS[mountainFor('s1')])).toBe(true);
  });

  it('declines the camera when camera permission is refused, and does not crash', async () => {
    mockRequestCamera.mockResolvedValue({ granted: false });
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-camera'));
    });

    expect(await screen.findByText(/needs camera access/i)).toBeTruthy();
    expect(mockLaunchCamera).not.toHaveBeenCalled();
    expect(photoSources().every((s) => s === MOUNTAINS[mountainFor('s1')])).toBe(true);
  });

  it('shows the picker/permission rejection as an error rather than an unhandled rejection', async () => {
    // Both the permission request and the picker itself can reject outright
    // (an OS-level failure, a Simulator with no camera) rather than merely
    // resolve `canceled: true` — the same gap `food/describe.tsx`'s own
    // `photograph` guards against. This button is `void`-called from a
    // `Pressable`, so an unguarded throw here would be a silent no-op, not a
    // visible error.
    mockRequestLibrary.mockRejectedValue(new Error('picker unavailable'));
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-library'));
    });

    expect(await screen.findByText('picker unavailable')).toBeTruthy();
  });

  it('the "Replace photo" label only appears once a photo has actually been picked', async () => {
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    expect(screen.getByText('Choose photo')).toBeTruthy();
    expect(screen.queryByText('Replace photo')).toBeNull();
    expect(screen.queryByTestId('share-photo-clear')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-library'));
    });

    await waitFor(() => expect(screen.getByText('Replace photo')).toBeTruthy());
    expect(screen.queryByText('Choose photo')).toBeNull();
    expect(screen.getByTestId('share-photo-clear')).toBeTruthy();
  });

  /**
   * The scoping guard itself — `background.id === sessionID` in
   * `useSessionShare`. Same reasoning as `numbers`' own `{id, value}` state:
   * a screen instance that moves to a DIFFERENT session (`router.replace`
   * onto the same route) must not decorate the new card with the photo that
   * was picked for the one it left. Nothing above exercises a sessionID
   * change — every other test in this file picks a photo and reads it back
   * for the SAME session.
   */
  it('does not carry a picked photo onto a different session', async () => {
    const { rerender } = render(<Harness sessionID="s1" />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');
    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-library'));
    });
    await waitFor(() =>
      expect(photoSources().every((s) => s?.uri === 'file:///cache/resized-1080.jpg')).toBe(true),
    );

    // A different session, same mounted hook instance — the shape a
    // `router.replace` onto the same route produces.
    rerender(<Harness sessionID="s2" />);

    expect(photoSources().every((s) => s === MOUNTAINS[mountainFor('s2')])).toBe(true);
  });

  /**
   * Cancelling out of the OS picker (`canceled: true`) is not a failure —
   * `pickBackgroundPhoto` returns early on it, same as the app's other four
   * picker sites. Nothing above exercises this path; every other test's
   * `mockLaunchLibrary`/`mockLaunchCamera` resolves with a real asset.
   */
  it('leaves the mountain in place, with no error, when the picker is dismissed', async () => {
    // A stale `assets` entry alongside `canceled: true` — deliberately, not
    // the more typical `assets: null` a real cancellation returns. This is
    // what actually pins the `canceled` check ITSELF: `assets: null` alone
    // would make even a guard that dropped `picked.canceled` and kept only
    // `!picked.assets[0]` return early too (a null-assets read throws, which
    // the outer catch also turns into "no photo set"), so that shape cannot
    // tell the two guards apart. With a real asset present, only checking
    // `canceled` stops it.
    mockLaunchLibrary.mockResolvedValue({
      canceled: true,
      assets: [{ uri: 'file:///should-not-be-used.jpg' }],
    });
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    await act(async () => {
      fireEvent.press(screen.getByTestId('share-photo-library'));
    });

    // No manipulator call — there was never an asset to resize.
    await waitFor(() => expect(mockRequestLibrary).toHaveBeenCalled());
    expect(mockManipulate).not.toHaveBeenCalled();
    expect(photoSources().every((s) => s === MOUNTAINS[mountainFor('s1')])).toBe(true);
    // Still "Choose photo", not "Replace photo" — nothing was actually picked.
    expect(screen.getByText('Choose photo')).toBeTruthy();
    expect(screen.getByTestId('share-preview-cancel').props.accessibilityState?.disabled).toBe(
      false,
    );
  });

  /**
   * The race this closes: `pickBackgroundPhoto` awaits a permission prompt,
   * an OS picker AND a resize before `setBackground` ever runs — none of
   * that is instant, and `sharing` alone does not cover it. A Share tap that
   * lands in that window would capture the card BEFORE the just-picked photo
   * is on it, exporting the outgoing mountain instead.
   */
  it('disables Share and Not now while a photo is still being resized, not only while sharing', async () => {
    let resolveManipulate: (v: { uri: string }) => void;
    mockManipulate.mockReturnValue(
      new Promise((resolve) => {
        resolveManipulate = resolve;
      }),
    );
    render(<Harness />);
    fireEvent.press(screen.getByTestId('share-button'));
    await screen.findByTestId('share-preview');

    fireEvent.press(screen.getByTestId('share-photo-library'));

    // Mid-resize: the picker and permission prompt have both already
    // resolved (they're separately-mocked immediate promises), the resize
    // has not.
    await waitFor(() =>
      expect(screen.getByTestId('share-preview-confirm').props.accessibilityState?.disabled).toBe(
        true,
      ),
    );
    expect(screen.getByTestId('share-preview-cancel').props.accessibilityState?.disabled).toBe(
      true,
    );
    // And nothing was captured while disabled — the guard is pointless if a
    // disabled button's press handler still fires.
    expect(mockShareCard).not.toHaveBeenCalled();

    await act(async () => {
      resolveManipulate({ uri: 'file:///cache/resized-1080.jpg' });
    });

    await waitFor(() =>
      expect(screen.getByTestId('share-preview-confirm').props.accessibilityState?.disabled).toBe(
        false,
      ),
    );
  });
});
