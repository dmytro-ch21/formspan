import { Text } from 'react-native';
import { configure, render, screen } from '@testing-library/react-native';

import {
  KeyboardAwareFooter,
  KeyboardAwareScreen,
  KeyboardAwareScrollView,
  needsPlatformKeyboardInset,
} from '../KeyboardAwareScroll';

/**
 * Only one thing compensates for the keyboard per scroll view.
 *
 * The bug this pins: the reflection wizard's footer pads itself by the
 * keyboard's height, which shrinks its sibling scroll view clear of the
 * keyboard — but `automaticallyAdjustKeyboardInsets` had already inset that
 * scroll view using the frame it had one layout pass earlier, before the
 * footer grew. The scroll view kept a keyboard-height of inset it no longer
 * overlapped, which is scroll range with nothing in it: focusing the note
 * field scrolled the wizard's title off the top and left ~200pt of blank
 * between the last line of content and the footer. Measured on an iPhone
 * 15 Pro at 393x852: footer lift 328pt, surplus inset 246pt.
 *
 * ## What this proves, precisely
 *
 * That the presence of a `KeyboardAwareFooter` reaches the scroll view beside
 * it and turns the platform inset off — and, just as importantly, that a
 * scroll view WITHOUT one still gets it, since that inset is the entire fix
 * for problem 2 on the twelve screens that have no footer. Turning it off
 * everywhere would trade this bug for the worse one it was written to solve.
 *
 * **What it cannot prove:** that the resulting scroll position has no void in
 * it. jest runs no Yoga pass and has no keyboard, so there are no frames to
 * measure and `automaticallyAdjustKeyboardInsets` is inert here — it is a prop
 * consumed by native code. The arithmetic that decides the footer's own lift
 * is covered in `inputErgonomics.test.ts`; the void itself is only observable
 * on a device, and a Simulator screenshot is the evidence for it.
 */

jest.setTimeout(30_000);
// RNTL's async utilities keep their own 1000ms budget that `jest.setTimeout`
// does not raise — same note as `screenHeader.test.tsx`.
configure({ asyncUtilTimeout: 10_000 });

/** Reads the prop the native side acts on, off the rendered scroll view. */
function platformInsetOn(testID: string): unknown {
  return screen.getByTestId(testID).props.automaticallyAdjustKeyboardInsets;
}

describe('needsPlatformKeyboardInset', () => {
  // Literal booleans rather than a re-derivation, so the predicate cannot
  // agree with itself.
  it('is on when nothing else has shortened the scroll view', () => {
    expect(needsPlatformKeyboardInset({ hasLiftingFooter: false })).toBe(true);
  });

  it('is off when a lifting footer has already shortened it', () => {
    expect(needsPlatformKeyboardInset({ hasLiftingFooter: true })).toBe(false);
  });
});

describe('a scroll view sharing a screen with a lifting footer', () => {
  it('stands down, because the footer already clears the keyboard', () => {
    render(
      <KeyboardAwareScreen>
        <KeyboardAwareScrollView testID="scroller">
          <Text>note</Text>
        </KeyboardAwareScrollView>
        <KeyboardAwareFooter>
          <Text>Save it</Text>
        </KeyboardAwareFooter>
      </KeyboardAwareScreen>,
    );

    expect(platformInsetOn('scroller')).toBe(false);
  });

  it('keeps the inset when the screen has no footer', () => {
    render(
      <KeyboardAwareScreen>
        <KeyboardAwareScrollView testID="scroller">
          <Text>note</Text>
        </KeyboardAwareScrollView>
      </KeyboardAwareScreen>,
    );

    expect(platformInsetOn('scroller')).toBe(true);
  });

  /**
   * The twelve screens that never heard of `KeyboardAwareScreen`.
   *
   * They are the reason the context defaults to "no footer" rather than
   * throwing or defaulting the other way: this fix must be invisible to every
   * screen that does not have a footer, and there are twelve of those.
   */
  it('keeps the inset when rendered outside a KeyboardAwareScreen entirely', () => {
    render(
      <KeyboardAwareScrollView testID="scroller">
        <Text>note</Text>
      </KeyboardAwareScrollView>,
    );

    expect(platformInsetOn('scroller')).toBe(true);
  });

  /**
   * Registration is counted, not latched.
   *
   * A screen that renders its footer only on the last step is the obvious next
   * call site, and a latched boolean would leave the scroll view insetless on
   * every earlier step — a silent return of problem 2 on exactly the steps
   * with the most content.
   */
  it('takes the inset back when the footer unmounts', () => {
    function Wizard({ onLastStep }: { onLastStep: boolean }) {
      return (
        <KeyboardAwareScreen>
          <KeyboardAwareScrollView testID="scroller">
            <Text>note</Text>
          </KeyboardAwareScrollView>
          {onLastStep && (
            <KeyboardAwareFooter>
              <Text>Save it</Text>
            </KeyboardAwareFooter>
          )}
        </KeyboardAwareScreen>
      );
    }

    const view = render(<Wizard onLastStep />);
    expect(platformInsetOn('scroller')).toBe(false);

    view.rerender(<Wizard onLastStep={false} />);
    expect(platformInsetOn('scroller')).toBe(true);
  });
});
