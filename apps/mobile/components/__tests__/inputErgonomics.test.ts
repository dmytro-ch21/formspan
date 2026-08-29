import {
  KEYBOARD_MARGIN,
  dismissModeFor,
  keyboardEventNames,
  keyboardInsetFor,
  nativeScrollsFocusedFieldClear,
  scrollTargetFor,
} from '../KeyboardAwareScroll';
import { shouldClaim, settleTarget } from '../SwipeToDelete';

/**
 * The two decisions behind the in-session input fixes.
 *
 * `apps/mobile` has no component test runner, so this cannot assert that a row
 * slides or that a field ends up on screen. It asserts the arithmetic and the
 * gesture predicate instead — which is where both features can actually be
 * wrong in a way a person would notice, and which is why they were extracted
 * from their components rather than left inline. The render path is task #129.
 */

const OPEN = -96;
const CLOSED = 0;

describe('lifting a field above the keyboard', () => {
  // Numbers chosen to read like a phone: an 812pt screen with the number pad
  // up puts the keyboard top around y=520.
  const kbTop = 520;
  // An iPhone-sized window: the scroll view runs to the bottom of the screen
  // and the keyboard sits over it, so the keyboard's edge is what binds.
  const SCREEN = 812;

  it('scrolls by exactly the overlap plus the margin', () => {
    // The field's bottom is at 560 — 40pt behind the keyboard.
    const target = scrollTargetFor({
      fieldY: 520, fieldHeight: 40, keyboardTop: kbTop, containerBottom: SCREEN, offset: 100,
    });
    expect(target).toBe(100 + 40 + KEYBOARD_MARGIN);
  });

  it('uses a margin of 24 — pinned to the NUMBER, not to the constant', () => {
    // Importing KEYBOARD_MARGIN on both sides of an assertion makes the test
    // agree with whatever the constant says, so a change to its value cannot
    // fail it. One literal somewhere is what actually pins the spacing.
    expect(KEYBOARD_MARGIN).toBe(24);
  });

  it('leaves a field that is already clear alone', () => {
    // Returning a target here would drag the list under the athlete's thumb
    // every time they moved between two fields that were both visible.
    expect(
      scrollTargetFor({ fieldY: 100, fieldHeight: 40, keyboardTop: kbTop, containerBottom: SCREEN, offset: 0 }),
    ).toBeNull();
  });

  it('treats the margin as part of the overlap, not a bonus', () => {
    // Bottom at 510 — visible, but only 10pt of air under it, less than the
    // margin. It should still lift, or the field sits flush against the
    // keyboard and reads as clipped.
    const target = scrollTargetFor({
      fieldY: 470, fieldHeight: 40, keyboardTop: kbTop, containerBottom: SCREEN, offset: 0,
    });
    expect(target).toBe(KEYBOARD_MARGIN - 10);
  });

  it('does nothing when the keyboard is down', () => {
    expect(
      scrollTargetFor({ fieldY: 700, fieldHeight: 40, keyboardTop: null, containerBottom: SCREEN, offset: 0 }),
    ).toBeNull();
  });

  it('does nothing for a zero-height node BELOW the keyboard', () => {
    // The coordinates matter. A node measuring all-zeros is already handled
    // by the overlap check (its bottom is above the keyboard), so testing
    // that proves nothing about the height guard — the first version of this
    // test did exactly that and passed with the guard deleted. A collapsed
    // field further down the list is the case only the height guard catches,
    // and scrolling to reveal something with no height is meaningless.
    expect(
      scrollTargetFor({ fieldY: 700, fieldHeight: 0, keyboardTop: kbTop, containerBottom: SCREEN, offset: 250 }),
    ).toBeNull();
  });

  it('uses the SCROLL VIEW\'s bottom when that is the higher edge — the Android case', () => {
    // Android's default `resize` mode shrinks the WINDOW instead of covering
    // it, so the scroll view ends where the keyboard begins and the field is
    // clipped rather than covered. Trusting `keyboardTop` alone would read
    // the field as comfortably visible and scroll nothing.
    const target = scrollTargetFor({
      fieldY: 480, fieldHeight: 40, keyboardTop: 900, containerBottom: 500, offset: 0,
    });
    expect(target).toBe(480 + 40 + KEYBOARD_MARGIN - 500);
  });

  it('uses the keyboard when THAT is the higher edge — the iOS case', () => {
    // Same field, same numbers, but now the window is full height and the
    // keyboard overlaps it. The binding edge swaps.
    const target = scrollTargetFor({
      fieldY: 480, fieldHeight: 40, keyboardTop: 500, containerBottom: 900, offset: 0,
    });
    expect(target).toBe(480 + 40 + KEYBOARD_MARGIN - 500);
  });

  it('adds to the current offset rather than replacing it', () => {
    // scrollTo is absolute. Forgetting the offset scrolls a deep list back to
    // near the top, which on a long session is the whole screen jumping.
    const a = scrollTargetFor({ fieldY: 600, fieldHeight: 40, keyboardTop: kbTop, containerBottom: SCREEN, offset: 0 });
    const b = scrollTargetFor({ fieldY: 600, fieldHeight: 40, keyboardTop: kbTop, containerBottom: SCREEN, offset: 900 });
    expect(b! - a!).toBe(900);
  });
});

describe('keeping a fixed footer clear of the keyboard', () => {
  const SCREEN = 812;

  it('lifts by the overlap when the keyboard covers the footer — the iOS case', () => {
    // The footer runs to the bottom of the screen and the keyboard sits over
    // it. This is the reflection wizard's Next button: without this it is
    // buried on the step where you type the session note, so the only control
    // that advances the wizard is unreachable.
    expect(keyboardInsetFor({ keyboardTop: 520, containerBottom: SCREEN })).toBe(SCREEN - 520);
  });

  it('lifts NOTHING when the window already shrank — the Android case', () => {
    // Android's default `resize` moves the footer up on its own. Reading the
    // keyboard's HEIGHT here instead of this overlap would push it a second
    // keyboard-height up the screen, leaving a gap the size of the keyboard.
    expect(keyboardInsetFor({ keyboardTop: 520, containerBottom: 520 })).toBe(0);
  });

  it('never returns a negative lift', () => {
    // A footer entirely above the keyboard must not be pulled DOWN into it.
    expect(keyboardInsetFor({ keyboardTop: 520, containerBottom: 300 })).toBe(0);
  });

  it('does nothing when the keyboard is down', () => {
    expect(keyboardInsetFor({ keyboardTop: null, containerBottom: SCREEN })).toBe(0);
  });
});

describe('which dismiss mode the platform honours', () => {
  it("refuses 'interactive' on Android, where it silently does nothing", () => {
    // Not a preference. Android does not implement `interactive`: it neither
    // errors nor warns, the keyboard just never dismisses on drag. Asserting
    // the Android value is what stops the iOS one being used for both.
    expect(dismissModeFor('android')).toBe('on-drag');
  });

  it("uses 'interactive' on iOS, where the keyboard follows the finger", () => {
    expect(dismissModeFor('ios')).toBe('interactive');
  });
});

describe('claiming a swipe without breaking the scroll', () => {
  it('claims a decisive horizontal drag', () => {
    expect(shouldClaim(-40, 3, true)).toBe(true);
  });

  it('REFUSES a vertical scroll that wanders sideways', () => {
    // The failure this guards: a list that intermittently will not scroll
    // because a row claimed a mostly-vertical drag.
    expect(shouldClaim(-20, 60, true)).toBe(false);
  });

  it('refuses a diagonal — |dx| must beat |dy|, not merely exist', () => {
    expect(shouldClaim(-30, 25, true)).toBe(false);
  });

  it('refuses a small twitch even when it is purely horizontal', () => {
    expect(shouldClaim(-6, 0, true)).toBe(false);
  });

  it('claims a rightward drag too, so an open row can be closed', () => {
    expect(shouldClaim(40, 2, true)).toBe(true);
  });
});

describe('where the row settles', () => {
  it('opens when dragged past halfway', () => {
    expect(settleTarget({ rest: CLOSED, dx: -60, vx: 0 })).toBe(OPEN);
  });

  it('springs back when dragged less than halfway', () => {
    expect(settleTarget({ rest: CLOSED, dx: -20, vx: 0 })).toBe(CLOSED);
  });

  it('opens on a fast flick that barely moved', () => {
    // Otherwise a quick swipe covering 40px snaps shut and reads as the
    // gesture not working at all.
    expect(settleTarget({ rest: CLOSED, dx: -20, vx: -1.2 })).toBe(OPEN);
  });

  it('closes on a fast flick back, even from fully open', () => {
    expect(settleTarget({ rest: OPEN, dx: 10, vx: 1.2 })).toBe(CLOSED);
  });

  it('continues from where the row was resting, not from zero', () => {
    // An already-open row nudged slightly must stay open. Ignoring `rest`
    // makes the second drag on any row snap it shut.
    expect(settleTarget({ rest: OPEN, dx: 5, vx: 0 })).toBe(OPEN);
  });

  it('closes an open row dragged most of the way back', () => {
    expect(settleTarget({ rest: OPEN, dx: 60, vx: 0 })).toBe(CLOSED);
  });
});

describe('which keyboard events to listen for', () => {
  it('uses Did* on Android, because Will* is never emitted there', () => {
    // Not a nicety. Android emits no `keyboardWillShow` at all, so the iOS
    // event names make the whole feature dead code on the platform — working
    // perfectly in review and doing nothing on a phone.
    const n = keyboardEventNames('android');
    expect([n.show, n.hide]).toEqual(['keyboardDidShow', 'keyboardDidHide']);
  });

  it('uses Will* on iOS, so the scroll moves WITH the keyboard', () => {
    const n = keyboardEventNames('ios');
    expect([n.show, n.hide]).toEqual(['keyboardWillShow', 'keyboardWillHide']);
  });

  it('only subscribes to changeFrame on iOS, which is the only place it fires', () => {
    expect(keyboardEventNames('ios').changeFrame).toBe('keyboardWillChangeFrame');
    expect(keyboardEventNames('android').changeFrame).toBeNull();
  });
});

describe('who lifts the field when the keyboard appears', () => {
  it('leaves it to iOS, which already does it', () => {
    // RCTScrollViewComponentView's _keyboardWillChangeFrame: measures the
    // first responder and scrolls it clear. Doing it again from JS races that
    // with a stale offset and can drag the field back behind the keyboard.
    expect(nativeScrollsFocusedFieldClear('ios')).toBe(true);
  });

  it('does it ourselves on Android, which has no equivalent', () => {
    // automaticallyAdjustKeyboardInsets is @platform ios. Assuming otherwise
    // means nothing ever lifts there.
    expect(nativeScrollsFocusedFieldClear('android')).toBe(false);
  });

  // N184 — a `KeyboardAwareFooter` on screen (e.g. the food-logging quantity
  // sheet's sticky Add, or the BJJ reflection wizard's Next — the strength
  // session screen reverted to no footer at all in N445, see its own
  // comment) runs `automaticallyAdjustKeyboardInsets` OFF on every platform,
  // including iOS — see `needsPlatformKeyboardInset`. Without this, iOS was
  // told "the platform already does it" on a screen where the platform had
  // just been switched off, and neither mechanism lifted the field. Found by
  // `frontend-reviewer` from this file's own doc comments, not from a device.
  it('does NOT leave it to iOS when a lifting footer has switched the platform mechanism off', () => {
    expect(nativeScrollsFocusedFieldClear('ios', true)).toBe(false);
  });

  it('still leaves it to iOS when there is no footer — the default, unchanged', () => {
    expect(nativeScrollsFocusedFieldClear('ios', false)).toBe(true);
    // And the parameter is optional, so every existing call site (none of
    // which knows about footers) keeps its old answer.
    expect(nativeScrollsFocusedFieldClear('ios')).toBe(true);
  });

  it('Android never leaves it to the platform, footer or not', () => {
    expect(nativeScrollsFocusedFieldClear('android', true)).toBe(false);
    expect(nativeScrollsFocusedFieldClear('android', false)).toBe(false);
  });
});

describe('the finished-session guard', () => {
  it('refuses to claim any swipe when disabled', () => {
    // A finished session is a record. This lives inside shouldClaim so it is
    // covered by tests at all — outside, it was the one thing that can
    // destroy a logged set with nothing able to reach it.
    expect(shouldClaim(-40, 3, false)).toBe(false);
  });

  it('refuses even a perfect swipe when disabled', () => {
    expect(shouldClaim(-200, 0, false)).toBe(false);
  });
});
