import { PixelRatio } from 'react-native';

import { CARD_EXPORT_WIDTH, cardCaptureSize, shareCard } from '../shareCard';

/**
 * The exported card has to be the same size from every phone.
 *
 * It was not, on iOS. `captureRef`'s `width`/`height` are POINTS there and the
 * renderer multiplies them by the device scale (`rendererFormat.scale = 0` in
 * `RNViewShot.mm`), so passing the pixel figure straight in exported
 * 3240 × 3240 at 10.5 MB from a 3× phone — and would have exported 2160 from a
 * 2× one. Exactly the density dependence the constant existed to prevent, and
 * that the comment above it claimed it did.
 *
 * **The same option means PIXELS on Android**, where `createScaledBitmap` makes
 * the output exactly that size. So the two platforms are tested apart: the
 * original constant was right on one and wrong on the other, and a single-
 * formula fix inverts the bug rather than removing it.
 *
 * The iOS cases assert on **pixels** — `points × scale` — never on the argument
 * passed. Asserting the argument pins whatever the code happens to send and
 * goes green against the original bug: 1080 points is a plausible-looking
 * number, and it *was* the bug. The product is what has to be constant.
 */

const iosPixels = (scale: number) => cardCaptureSize(scale, 'ios') * scale;

describe('cardCaptureSize on iOS — points, multiplied by the device scale', () => {
  it('exports the same pixel size on every density', () => {
    for (const scale of [2, 3]) {
      expect(iosPixels(scale)).toBe(CARD_EXPORT_WIDTH);
    }
  });

  it('lands within a pixel on a fractional scale', () => {
    // No shipping iOS device reports one, so this pins the ARITHMETIC rather
    // than a device: an implementation that rounded the point size before
    // handing it over would drift here while looking right at 2x and 3x, where
    // 1080 divides evenly. Deliberately no longer labelled "Android" — that
    // platform never divides, and the old name made this read as coverage of a
    // branch it does not touch.
    for (const scale of [1.5, 2.625, 3.5]) {
      expect(Math.abs(iosPixels(scale) - CARD_EXPORT_WIDTH)).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to a bounded size on a nonsense scale', () => {
    // Dividing by 0 exports an infinitely large image; NaN exports nothing at
    // all. `Infinity` is in the list because dropping `Number.isFinite` while
    // keeping `scale > 0` passes every other case here and returns 0.
    for (const scale of [0, -1, NaN, Infinity]) {
      expect(cardCaptureSize(scale, 'ios')).toBe(CARD_EXPORT_WIDTH);
    }
  });

  it('reads the device scale when not given one', () => {
    const spy = jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
    try {
      expect(cardCaptureSize(undefined, 'ios')).toBe(CARD_EXPORT_WIDTH / 3);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('cardCaptureSize elsewhere — pixels, already final', () => {
  /*
   * `RNViewShotModule.java` reads `width`/`height` with `getInt`, and
   * `ViewShot.java` finishes with `Bitmap.createScaledBitmap(bitmap, width,
   * height, true)`: the output is exactly that many pixels, density nowhere in
   * the chain. So the ORIGINAL constant was correct on Android, and the first
   * version of this fix broke it — a 3x phone would have exported 360px.
   *
   * jest-expo reports `ios`, so without passing the platform in, this branch is
   * both unobservable and untestable. That is why it is a parameter.
   */
  it('asks for the pixel size unchanged, whatever the density', () => {
    for (const scale of [1.5, 2, 2.625, 3, 3.5]) {
      expect(cardCaptureSize(scale, 'android')).toBe(CARD_EXPORT_WIDTH);
    }
  });

  it('treats any non-iOS platform as taking pixels', () => {
    // Written as "not ios" rather than "is android", so web and anything added
    // later follow the pixel reading rather than silently dividing.
    //
    // `web` is verified: the library's `RNViewShot.web.ts` sets
    // `resizedCanvas.width = options.width` — backing-store pixels, with
    // `devicePixelRatio` nowhere in the resize path.
    expect(cardCaptureSize(3, 'web')).toBe(CARD_EXPORT_WIDTH);

    // `windows` is NOT verified — nobody has read the package's C#. It is here
    // to pin the SHAPE rather than the set: an enumerated
    // `platform === 'android' || platform === 'web'` passes every other case
    // in this file while quietly inverting the default for any target not
    // listed. If Windows ever turns out to be points-based, this line should
    // fail and be rewritten — that is the point of it.
    expect(cardCaptureSize(3, 'windows')).toBe(CARD_EXPORT_WIDTH);
  });
});

/*
 * And the value actually reaches `captureRef`, which the pure tests above
 * cannot show: the export could compute the right number and still pass the
 * constant, which is the shape the bug had.
 */
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => {}),
}));

describe('shareCard', () => {
  it('captures at the converted size, not the pixel constant', async () => {
    const { captureRef } = jest.requireMock('react-native-view-shot');
    captureRef.mockResolvedValue('file:///tmp/card.png');
    const spy = jest.spyOn(PixelRatio, 'get').mockReturnValue(3);

    try {
      // A ref with a truthy `current` is all the capture path checks.
      const result = await shareCard({ current: {} } as never);

      expect(result).toEqual({ ok: true });
      const opts = captureRef.mock.calls[0][1];
      expect(opts.width).toBe(CARD_EXPORT_WIDTH / 3);
      expect(opts.height).toBe(opts.width);
      // The regression, stated as itself.
      expect(opts.width).not.toBe(CARD_EXPORT_WIDTH);
    } finally {
      spy.mockRestore();
    }
  });
});
