import {
  MAX_RELEASE_VELOCITY,
  drawnOffset,
  rubberband,
  springVelocity,
} from '../gesturePhysics';

/**
 * F45 — the two things that make a drag feel physical rather than merely
 * correct: resistance at an edge, and the velocity handoff at release.
 *
 * `settleTarget` and `shouldClaim` — the gesture's DECISIONS — are tested in
 * `components/__tests__/inputErgonomics.test.ts` and are deliberately untouched
 * by F45.
 *
 * ## What this file does NOT cover, stated because the first version of this
 * ## docstring claimed otherwise
 *
 * These are the pure helpers. **The wiring is not tested here**: deleting
 * `, g.vx` from `SwipeToDelete`'s release handler, or `settle(g.vy)` from
 * `EntryRow`'s, leaves every assertion below green. `frontend-reviewer` checked
 * that and it is true — the headline of F45 ("the handover happens") is covered
 * by no test, because neither `PanResponder` handler is reachable without
 * rendering the component and driving a gesture.
 *
 * What IS pinned here is everything the wiring depends on being correct: the
 * unit conversion, the clamp, the resistance curve, and — via `drawnOffset` —
 * the three-way branch's composition at both boundaries, which is where an
 * off-by-one would actually live.
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

describe('drawnOffset — the composition, not just its pieces', () => {
  it('tracks the finger exactly inside both edges', () => {
    for (const next of [0, -1, -48, -95, -ACTION_WIDTH]) {
      expect(drawnOffset(next, ACTION_WIDTH)).toBe(next);
    }
  });

  it('is continuous at the closed edge', () => {
    // A jump here would show as the row snapping a pixel or two the instant
    // resistance begins — the exact seam rubber-banding exists to remove.
    expect(drawnOffset(0.001, ACTION_WIDTH)).toBeCloseTo(0, 2);
    expect(drawnOffset(-0.001, ACTION_WIDTH)).toBeCloseTo(0, 2);
  });

  it('is continuous at the open edge', () => {
    expect(drawnOffset(-ACTION_WIDTH - 0.001, ACTION_WIDTH)).toBeCloseTo(-ACTION_WIDTH, 2);
    expect(drawnOffset(-ACTION_WIDTH + 0.001, ACTION_WIDTH)).toBeCloseTo(-ACTION_WIDTH, 2);
  });

  it('resists past the open edge, and offsets into the right frame', () => {
    // The left branch subtracts ACTION_WIDTH, resists, and adds it back. Getting
    // that frame wrong is the off-by-one testing `rubberband` alone cannot see.
    const drawn = drawnOffset(-ACTION_WIDTH - 40, ACTION_WIDTH);
    expect(drawn).toBeLessThan(-ACTION_WIDTH);
    expect(drawn).toBeGreaterThan(-ACTION_WIDTH - 40);
    expect(drawn).toBeCloseTo(-ACTION_WIDTH + rubberband(-40, ACTION_WIDTH), 10);
  });

  it('never leaves the screen in either direction', () => {
    expect(drawnOffset(100_000, ACTION_WIDTH)).toBeLessThan(ACTION_WIDTH);
    expect(drawnOffset(-100_000, ACTION_WIDTH)).toBeGreaterThan(-2 * ACTION_WIDTH);
  });

  it('is monotone across the whole range — no plateau, no reversal', () => {
    let previous = -Infinity;
    for (let next = -400; next <= 400; next += 7) {
      const drawn = drawnOffset(next, ACTION_WIDTH);
      expect(drawn).toBeGreaterThan(previous);
      previous = drawn;
    }
  });
});

describe('the release-velocity clamp', () => {
  it('leaves a real flick untouched', () => {
    // A deliberate fast swipe measures well under the cap.
    expect(springVelocity(1.2)).toBe(1200);
  });

  it('bounds a phantom flick from one jittery frame', () => {
    // `gestureState.vx` is an unsmoothed single-frame difference and RN's own
    // source says so. At 120Hz one bad sample reads as 3 px/ms, which the
    // spring would carry ~29px past the target.
    expect(springVelocity(3)).toBe(MAX_RELEASE_VELOCITY * 1000);
    expect(springVelocity(-5)).toBe(-MAX_RELEASE_VELOCITY * 1000);
  });

  it('clamps symmetrically', () => {
    expect(springVelocity(9)).toBe(-springVelocity(-9));
  });
});

describe('the rubber-band constant', () => {
  it('is UIScrollView\'s 0.55, not merely "something in (0,1)"', () => {
    // Every other assertion in this file holds for any constant in (0,1), so
    // without this the provenance claim in the doc comment is unguarded.
    expect(rubberband(96, 96)).toBeCloseTo((96 * 96 * 0.55) / (96 + 0.55 * 96), 10);
  });
});
