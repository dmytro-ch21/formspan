import { KEYBOARD_MARGIN, scrollTargetFor } from '../../components/KeyboardAwareScroll';
import { shouldClaim, settleTarget } from '../../components/SwipeToDelete';

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

  it('scrolls by exactly the overlap plus the margin', () => {
    // The field's bottom is at 560 — 40pt behind the keyboard.
    const target = scrollTargetFor({
      fieldY: 520, fieldHeight: 40, keyboardTop: kbTop, offset: 100,
    });
    expect(target).toBe(100 + 40 + KEYBOARD_MARGIN);
  });

  it('leaves a field that is already clear alone', () => {
    // Returning a target here would drag the list under the athlete's thumb
    // every time they moved between two fields that were both visible.
    expect(
      scrollTargetFor({ fieldY: 100, fieldHeight: 40, keyboardTop: kbTop, offset: 0 }),
    ).toBeNull();
  });

  it('treats the margin as part of the overlap, not a bonus', () => {
    // Bottom at 510 — visible, but only 10pt of air under it, less than the
    // margin. It should still lift, or the field sits flush against the
    // keyboard and reads as clipped.
    const target = scrollTargetFor({
      fieldY: 470, fieldHeight: 40, keyboardTop: kbTop, offset: 0,
    });
    expect(target).toBe(KEYBOARD_MARGIN - 10);
  });

  it('does nothing when the keyboard is down', () => {
    expect(
      scrollTargetFor({ fieldY: 700, fieldHeight: 40, keyboardTop: null, offset: 0 }),
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
      scrollTargetFor({ fieldY: 700, fieldHeight: 0, keyboardTop: kbTop, offset: 250 }),
    ).toBeNull();
  });

  it('adds to the current offset rather than replacing it', () => {
    // scrollTo is absolute. Forgetting the offset scrolls a deep list back to
    // near the top, which on a long session is the whole screen jumping.
    const a = scrollTargetFor({ fieldY: 600, fieldHeight: 40, keyboardTop: kbTop, offset: 0 });
    const b = scrollTargetFor({ fieldY: 600, fieldHeight: 40, keyboardTop: kbTop, offset: 900 });
    expect(b! - a!).toBe(900);
  });
});

describe('claiming a swipe without breaking the scroll', () => {
  it('claims a decisive horizontal drag', () => {
    expect(shouldClaim(-40, 3)).toBe(true);
  });

  it('REFUSES a vertical scroll that wanders sideways', () => {
    // The failure this guards: a list that intermittently will not scroll
    // because a row claimed a mostly-vertical drag.
    expect(shouldClaim(-20, 60)).toBe(false);
  });

  it('refuses a diagonal — |dx| must beat |dy|, not merely exist', () => {
    expect(shouldClaim(-30, 25)).toBe(false);
  });

  it('refuses a small twitch even when it is purely horizontal', () => {
    expect(shouldClaim(-6, 0)).toBe(false);
  });

  it('claims a rightward drag too, so an open row can be closed', () => {
    expect(shouldClaim(40, 2)).toBe(true);
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
