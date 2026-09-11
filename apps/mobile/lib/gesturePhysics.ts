/**
 * The pure maths behind the app's two drag gestures — F45 (#1044).
 *
 * ## Why `lib/` and not beside the component that uses it
 *
 * These started in `components/SwipeToDelete.tsx`, alongside `shouldClaim` and
 * `settleTarget` which still live there. Review found a concrete hazard in that:
 * `EntryRow` needs `springVelocity` too, and importing it from a sibling
 * COMPONENT drags that whole module — React, `Animated`, `PressableScale`,
 * theme tokens — in behind a multiply. `__tests__/app/savedFoodsScreen.test.tsx`
 * already does a whole-module `jest.mock('@/components/SwipeToDelete', …)`, so
 * any future test that mocks it *and* renders `EntryRow` would get
 * `springVelocity === undefined` and a `TypeError` on release. Latent today,
 * because nothing renders `EntryRow` yet; free to prevent now.
 *
 * `shouldClaim` and `settleTarget` deliberately stay put: #1044's central
 * constraint is that the gesture's DECISIONS do not change, and moving them
 * would churn a file the ticket says to leave alone.
 */

/**
 * The largest release velocity worth honouring, in px per millisecond.
 *
 * `gestureState.vx`/`vy` is an UNSMOOTHED single-frame finite difference —
 * React Native's own `PanResponder.js` carries `// TODO: This must be filtered
 * intelligently.` above the calculation, and `onResponderRelease` does not
 * recompute it, so the value handed over is whatever the last move frame
 * produced. On a 120Hz screen that frame is ~8ms, so a single jittery sample
 * reads as a 2-3 px/ms "flick" the athlete never made.
 *
 * That matters because `bounciness: 0` sets the DAMPING RATIO (ζ≈0.998), not
 * `overshootClamping` — so a spring handed a large initial velocity genuinely
 * overshoots its target. Simulated against React Native's own closed form: at
 * 3 px/ms a swipe row travels ~29px past the Delete button; at 5 px/ms, ~67px.
 * Past the CLOSED position that is worse than cosmetic, because the row then
 * overhangs its container and nothing clips it.
 *
 * 2.0 bounds the overshoot to roughly 5-7px — which reads as weight, which is
 * the point of F45 — while leaving every real flick untouched: a deliberate
 * fast swipe measures well under 2 px/ms.
 */
export const MAX_RELEASE_VELOCITY = 2;

/**
 * `gestureState.vx`/`vy` in px per MILLISECOND → the px per SECOND that React
 * Native's spring expects, clamped to something a thumb can actually produce.
 *
 * A named function for a multiply, deliberately: the units are the entire risk
 * in F45 and an inline `* 1000` is what a later edit "simplifies" away. The
 * factor is measured, not assumed, and it holds on all three code paths —
 * `Libraries/Animated/animations/SpringAnimation.js:281`
 * (`deltaTime = (now - this._lastTime) / 1000`, `now` from `Date.now()`),
 * `RCTSpringAnimation.mm`, and `SpringAnimationDriver.cpp` all integrate in
 * seconds. Re-checked against the installed react-native 0.86.3.
 *
 * Wrong by three orders of magnitude in either direction and the row either
 * ignores a flick completely or leaves the screen — and both read as a broken
 * spring rather than as a unit error.
 */
export function springVelocity(pxPerMs: number): number {
  const clamped = Math.max(-MAX_RELEASE_VELOCITY, Math.min(MAX_RELEASE_VELOCITY, pxPerMs));
  return clamped * 1000;
}

/**
 * Progressive resistance past an edge, so a boundary feels like an edge rather
 * than like the gesture breaking.
 *
 * Pure. Given an overshoot in points it returns how far the row should ACTUALLY
 * move, approaching `dimension` asymptotically and never reaching it — so the
 * row keeps responding to the finger however hard it is pulled, while visibly
 * giving less and less.
 *
 * The limit is `dimension`, NOT `dimension * constant`: as the overshoot grows
 * the expression reduces to `(x·d·c)/(c·x) = d`. An earlier version of this
 * comment claimed the latter and a test caught it — worth recording, because
 * the ceiling is the whole point of the function.
 *
 * `0.55` is UIScrollView's constant and the formula is the one iOS uses for its
 * own bounce. Deliberately not a design token: this is the shape of a physical
 * law, and `constants/Motion.ts` covers time only.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Where a horizontally-dragged row should be DRAWN, given where the finger has
 * put it — resisted past either edge, 1:1 in between.
 *
 * Extracted so the composition is testable, not just its pieces. The left edge
 * offsets into `rubberband`'s frame and back out again, which is exactly where
 * an off-by-one would live, and testing `rubberband` alone would never see it.
 *
 * Note what this does NOT affect: the settle decision still receives the raw
 * finger position. That is safe rather than merely intended — `settleTarget`'s
 * only distance test is against `OPEN_AT` (48), which sits strictly inside the
 * un-resisted region, so a resisted position can never fall on the other side
 * of the decision from the raw one. If `OPEN_AT` or `ACTION_WIDTH` ever change,
 * re-check that.
 */
export function drawnOffset(next: number, actionWidth: number): number {
  if (next > 0) return rubberband(next, actionWidth);
  if (next < -actionWidth) return -actionWidth + rubberband(next + actionWidth, actionWidth);
  return next;
}
