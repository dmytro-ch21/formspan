import { Keyboard, Platform, Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';

import { AmountSheet } from '../AmountSheet';
import { keyboardInsetForScreenBottom } from '@/components/KeyboardAwareScroll';

/**
 * The barcode-scan amount editor's Done button, and the keyboard over it —
 * N493 part 3 (#858 item 7).
 *
 * **What this pins, and why it is worth pinning.** The sheet already had a
 * `KeyboardAwareFooter` when the athlete reported the Done button covered:
 * N426 added it on 2026-08-28, the report is 2026-09-04. So "the component is
 * there" was already true and already not enough — which is exactly the
 * shape of bug a reading of the code cannot settle, and the reason this file
 * exists rather than a comment.
 *
 * **The reproduction is real, not a stand-in.** Under jest `measureInWindow`
 * reports zeros, so `keyboardInsetFor` computes `0 - keyboardTop` → clamped
 * to 0, and the footer takes **no padding at all** for a keyboard that is
 * genuinely up. That is the device symptom with the measurement error at its
 * maximum: on an iOS `pageSheet` the measurement is short by the sheet's own
 * top inset rather than by everything, and a Done button lifted by less than
 * the keypad's height is still under it. Same mechanism, same outcome.
 *
 * **What it cannot prove:** the pixel position on a real display. jest runs no
 * Yoga pass and has no keyboard, so this shows the footer is told to lift by
 * at least the keyboard's height — not that it visually clears it. The issue
 * keeps a `NEEDS HUMAN EVIDENCE` criterion for that, and it should.
 */

/** The 15 Pro's keypad, measured: 336pt tall on an 852pt display. */
const KEYPAD_HEIGHT = 336;
const SCREEN_HEIGHT = 852;

/**
 * Captures the footer's own keyboard listeners so the test can drive them.
 *
 * `Keyboard.emit` is not part of the public surface (and is absent under this
 * RN version — verified by trying it), so the listener side is the seam.
 */
function captureKeyboard(): Record<string, (e: unknown) => void> {
  const listeners: Record<string, (e: unknown) => void> = {};
  jest
    .spyOn(Keyboard, 'addListener')
    .mockImplementation(((name: string, cb: (e: unknown) => void) => {
      listeners[name] = cb;
      return { remove: () => {} };
    }) as never);
  return listeners;
}

/** The `paddingBottom` the footer actually rendered with, or 0. */
function footerPadding(): number {
  const styles = screen.getByTestId('amount-sheet-footer').props.style as unknown[];
  for (const entry of styles.flat(Infinity)) {
    if (entry && typeof entry === 'object' && 'paddingBottom' in entry) {
      return (entry as { paddingBottom: number }).paddingBottom;
    }
  }
  return 0;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('keyboardInsetForScreenBottom', () => {
  // Literal expectations rather than a re-derivation, so the function cannot
  // agree with itself.
  it('lifts by the keyboard height when the measurement came back short', () => {
    expect(
      keyboardInsetForScreenBottom({ os: 'ios', keyboardHeight: 336, measuredInset: 0 }),
    ).toBe(336);
  });

  it('keeps the measured answer when it is the larger of the two', () => {
    // The ordinary case: the footer is where the measurement said, the two
    // agree, and nothing about the existing screens changes. A measurement
    // that somehow exceeded the keyboard height is still honoured.
    expect(
      keyboardInsetForScreenBottom({ os: 'ios', keyboardHeight: 336, measuredInset: 340 }),
    ).toBe(340);
  });

  it('is zero when the keyboard is down', () => {
    expect(
      keyboardInsetForScreenBottom({ os: 'ios', keyboardHeight: null, measuredInset: 0 }),
    ).toBe(0);
  });

  it('leaves Android on the measured answer, because its window already shrank', () => {
    // `keyboardInsetFor`'s own doc comment is explicit that reading the height
    // on Android `resize` pushes the footer a second keyboard up the screen.
    // This is that refusal, stated as a test rather than trusted to a comment.
    expect(
      keyboardInsetForScreenBottom({ os: 'android', keyboardHeight: 336, measuredInset: 0 }),
    ).toBe(0);
  });
});

describe("the scan sheet's Done button", () => {
  it('is lifted clear when the keypad opens over it', async () => {
    expect(Platform.OS).toBe('ios');
    const listeners = captureKeyboard();

    await render(
      <AmountSheet visible onClose={() => {}}>
        <Text>amount control</Text>
      </AmountSheet>,
    );

    // Nothing has happened yet: no keyboard, no lift.
    expect(footerPadding()).toBe(0);

    await act(async () => {
      listeners.keyboardWillShow?.({
        endCoordinates: { screenY: SCREEN_HEIGHT - KEYPAD_HEIGHT, height: KEYPAD_HEIGHT },
      });
    });

    // At LEAST the keypad's height — the footer clears it rather than sitting
    // on its edge, so there is also a margin on top. `>=` rather than an exact
    // figure because the margin is `KeyboardAwareScroll`'s to choose; what
    // this test is about is that the lift is not zero and not short.
    expect(footerPadding()).toBeGreaterThanOrEqual(KEYPAD_HEIGHT);
  });

  it('drops the lift again when the keypad goes away', async () => {
    const listeners = captureKeyboard();

    await render(
      <AmountSheet visible onClose={() => {}}>
        <Text>amount control</Text>
      </AmountSheet>,
    );

    await act(async () => {
      listeners.keyboardWillShow?.({
        endCoordinates: { screenY: SCREEN_HEIGHT - KEYPAD_HEIGHT, height: KEYPAD_HEIGHT },
      });
    });
    expect(footerPadding()).toBeGreaterThanOrEqual(KEYPAD_HEIGHT);

    await act(async () => {
      listeners.keyboardWillHide?.({});
    });
    // A footer that lifted and never came back down would leave a keypad-sized
    // hole under the sheet for the rest of its life.
    expect(footerPadding()).toBe(0);
  });
});
