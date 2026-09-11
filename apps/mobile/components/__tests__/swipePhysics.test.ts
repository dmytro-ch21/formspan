import { rubberband, springVelocity } from '../SwipeToDelete';

/**
 * F45 — the two things that make a drag feel physical rather than merely
 * correct: resistance at an edge, and the velocity handoff at release.
 *
 * `settleTarget` and `shouldClaim` — the gesture's DECISIONS — are tested in
 * `inputErgonomics.test.ts` and are deliberately untouched by F45. What changed
 * is only what gets drawn during the drag and how the settle starts, so this
 * file tests exactly that and nothing else.
 */

const ACTION_WIDTH = 96;

describe('rubberband — an edge that gives rather than a wall', () => {
  it('does nothing at all at the boundary itself', () => {
    expect(rubberband(0, ACTION_WIDTH)).toBe(0);
  });

  it('always moves LESS than the finger — that is the resistance', () => {
    for (const overshoot of [1, 5, 20, 60, 200, 1000]) {
      expect(rubberband(overshoot, ACTION_WIDTH)).toBeLessThan(overshoot);
    }
  });

  it('never stops responding, however hard it is pulled', () => {
    // The property that distinguishes this from a clamp: the row keeps moving
    // for every additional pixel of finger, forever. A clamp returns the same
    // number once you pass it, and that is what reads as the gesture breaking.
    let previous = 0;
    for (const overshoot of [1, 10, 50, 100, 500, 5000]) {
      const moved = rubberband(overshoot, ACTION_WIDTH);
      expect(moved).toBeGreaterThan(previous);
      previous = moved;
    }
  });

  it('approaches a ceiling it never reaches', () => {
    // The limit is `dimension` — as the overshoot grows the expression reduces
    // to (x·d·c)/(c·x) = d. So a finger dragged a mile moves the row at most
    // one action-width past the edge, and never off screen.
    //
    // This assertion was written against `dimension * constant` first, matching
    // a claim in the function's own doc comment. Both were wrong; this test is
    // what found it.
    expect(rubberband(100_000, ACTION_WIDTH)).toBeLessThan(ACTION_WIDTH);
    expect(rubberband(100_000, ACTION_WIDTH)).toBeGreaterThan(ACTION_WIDTH * 0.99);
  });

  it('is symmetric, so both edges resist identically', () => {
    // The left edge passes a negative overshoot. Resistance must not depend on
    // which way the finger went.
    expect(rubberband(-40, ACTION_WIDTH)).toBeCloseTo(-rubberband(40, ACTION_WIDTH), 10);
  });

  it('resists harder the further it is pushed', () => {
    // Not just "less than the finger" — the RATIO falls as the overshoot grows.
    // A constant fraction would feel like slow dragging, not like resistance.
    const near = rubberband(10, ACTION_WIDTH) / 10;
    const far = rubberband(200, ACTION_WIDTH) / 200;
    expect(far).toBeLessThan(near);
  });
});

describe('springVelocity — the unit contract that is the whole risk', () => {
  it('converts px/ms to px/s', () => {
    // `gestureState.vx` of 1.2 is a brisk flick: 1.2 px per millisecond, i.e.
    // 1200 px per second, which is what the spring must be handed.
    expect(springVelocity(1.2)).toBe(1200);
  });

  it('keeps the sign, because direction is half the handoff', () => {
    expect(springVelocity(-0.8)).toBe(-800);
  });

  it('passes a standing finger through as zero', () => {
    // A termination and a programmatic close call `settle` with no argument,
    // which defaults to 0 — this asserts the conversion does not invent motion.
    expect(springVelocity(0)).toBe(0);
  });

  it('is off by a factor of 1000 if anyone "simplifies" it away', () => {
    // The regression this exists to catch: dropping the conversion hands the
    // spring px/ms, three orders of magnitude too slow, and the flick silently
    // stops mattering. Nothing else in the suite would notice.
    expect(springVelocity(1)).not.toBe(1);
    expect(springVelocity(1)).toBe(1000);
  });
});
