import { PixelRatio } from 'react-native';

import { CARD_EXPORT_WIDTH, cardCaptureSize, shareCard } from '../shareCard';

/**
 * The exported card has to be the same size from every phone.
 *
 * It was not. `captureRef`'s `width`/`height` are POINTS, and the renderer
 * multiplies them by the device scale (`rendererFormat.scale = 0` in
 * `RNViewShot.mm`), so passing the pixel figure straight in exported
 * 3240 × 3240 at 10.5 MB from a 3× phone — and would have exported 2160 from a
 * 2× one. That is exactly the density dependence the constant existed to
 * prevent, and the comment above it claimed it did.
 *
 * **These assert on PIXELS — `points × scale` — not on the points.** Asserting
 * the argument alone would pin whatever the code happens to pass and go green
 * against the bug: 1080 points is a perfectly plausible-looking number, and it
 * was the bug. The product is the thing that has to be constant.
 */

const scaled = (scale: number) => cardCaptureSize(scale) * scale;

describe('cardCaptureSize', () => {
  it('exports the same pixel size on every density', () => {
    // The two iOS scales, and the ones an Android phone can report.
    for (const scale of [2, 3]) {
      expect(scaled(scale)).toBe(CARD_EXPORT_WIDTH);
    }
  });

  it('lands within a pixel on non-integer Android scales', () => {
    // 2.625 and 3.5 are real device scales and do not divide 1080 evenly. A
    // pixel either way is a rounding error; a different SIZE is the bug.
    for (const scale of [1.5, 2.625, 3.5]) {
      expect(Math.abs(scaled(scale) - CARD_EXPORT_WIDTH)).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to a bounded size on a nonsense scale', () => {
    // Dividing by 0 exports an infinitely large image; NaN exports nothing at
    // all. Neither fails in a way anyone could diagnose from a share sheet.
    for (const scale of [0, -1, NaN]) {
      expect(cardCaptureSize(scale)).toBe(CARD_EXPORT_WIDTH);
    }
  });

  it('reads the device scale when not given one', () => {
    const spy = jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
    try {
      expect(cardCaptureSize()).toBe(CARD_EXPORT_WIDTH / 3);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
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
