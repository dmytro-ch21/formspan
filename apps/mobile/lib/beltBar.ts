import { MAX_DEGREE, MAX_STRIPES, type Belt } from './bjj';

/**
 * Where the rank bar sits on each belt render, and where its stripes go.
 *
 * Pure geometry, in the render's own fraction space — `x` is a fraction of the
 * image's width, `y` a fraction of its height — so nothing here depends on the
 * size the belt is finally drawn at. {@link BeltPhoto} multiplies by its own
 * width and height and hands the result to SVG.
 *
 * ## Why a quadrilateral and not a rectangle
 *
 * The first version of this was one centre, one angle, one length and one
 * width, measured off the black belt's red bar and applied to all five. Two
 * things were wrong with it, and both were visible on the card:
 *
 * 1. **The bars are not in the same place on each render.** The renders share a
 *    framing, but not to the pixel: measured against their real bars, the
 *    shared geometry put white's stripes ~25px high and purple's ~23px, at
 *    1024px wide. Brown and black sit noticeably higher up the belt than the
 *    other three. So each belt gets its own measurement.
 *
 * 2. **A bar is not a rectangle on screen.** It is a rectangle in the world,
 *    photographed at an angle, so what reaches the image is a quadrilateral in
 *    perspective — its two long edges are not parallel, and the angle between
 *    the long and short edges runs from 2.2° off square (brown) to 10.6°
 *    (black). No single `rotate` can express that, which is why stripes drawn
 *    from one angle hung off the bar's edge at one end however the centre was
 *    nudged.
 *
 *    That skew is also why the old *angle* was wrong (28.5°, against a real
 *    33.6°–38.1°): it came from the principal axis of the bar's pixels, and the
 *    principal axis of a skewed parallelogram is not parallel to its long
 *    edges. It is a good measure of a rectangle's orientation and a misleading
 *    one here.
 *
 * ## How these were measured
 *
 * Per belt, from the shipped 1024×683 render: mask the bar by colour distance
 * from the surrounding belt (with a per-belt threshold — brown's bar is only
 * ~36 away from brown, white's is ~300 away from white, so one cutoff finds
 * nothing on one belt or the whole belt on another), take the largest connected
 * component, then its convex hull, then simplify the hull to exactly four
 * corners. Verified by drawing the corners back over each render.
 *
 * If a render is ever replaced, these numbers must be re-measured — they are
 * facts about the artwork, not about BJJ.
 */
export type Point = readonly [x: number, y: number];

/** Any four corners, in order around the shape. */
export type Quad = readonly [Point, Point, Point, Point];

/**
 * Corner order is load-bearing and identical on all five: `0→1` and `3→2` are
 * the **long** edges, running from the belt's body towards its tip; `0→3` and
 * `1→2` cross the bar. {@link stripeQuads} walks the two long edges together,
 * so a belt entered in another order would draw its stripes lengthways.
 */
export const BAR_QUADS: Record<Belt, Quad> = {
  white: [
    [0.7529, 0.5857],
    [0.8438, 0.6764],
    [0.793, 0.7833],
    [0.7031, 0.6779],
  ],
  blue: [
    [0.7471, 0.5725],
    [0.835, 0.6647],
    [0.7861, 0.7511],
    [0.6943, 0.6574],
  ],
  purple: [
    [0.7529, 0.5827],
    [0.8398, 0.675],
    [0.7939, 0.7804],
    [0.6982, 0.6823],
  ],
  brown: [
    [0.7539, 0.5549],
    [0.8398, 0.6559],
    [0.793, 0.7438],
    [0.7041, 0.6428],
  ],
  black: [
    [0.7598, 0.5564],
    [0.8545, 0.6515],
    [0.8057, 0.7321],
    [0.71, 0.6325],
  ],
};

/**
 * How many stripes the bar is divided for. Black belts count degrees on the red
 * bar and everyone else counts stripes; the bar is the same size either way, so
 * six degrees simply pack tighter than four stripes.
 */
export function barSlots(belt: Belt): number {
  return belt === 'black' ? MAX_DEGREE : MAX_STRIPES;
}

/**
 * A stripe's share of its slot. 0.6 leaves a gap a little over half a stripe
 * wide, which is about what a real belt shows — and it is a ratio rather than a
 * fixed size because the same bar has to hold six degrees or four stripes.
 *
 * There is no lower bound in points, unlike the version this replaces. The
 * smallest place the belt currently draws is the rank card at 215pt, where the
 * bar measures ~23.5pt along and this gives a 2.8pt stripe (2.1pt for a black
 * belt's six). A floor that never binds is a floor that has never been tested,
 * so it is better absent than notionally present.
 */
const STRIPE_RATIO = 0.6;

/**
 * How far in from each end of the bar a stripe stops, as a fraction of the
 * bar's width. A stripe sits *inside* the bar: drawn edge to edge it reads as
 * the bar being cut into pieces rather than as tape laid across it.
 */
const STRIPE_INSET = 0.06;

const lerp = (a: Point, b: Point, t: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/**
 * A drawn stripe. Same fraction space as {@link BAR_QUADS} and the same four
 * corners in order, but **not the same convention**: `0→1` and `3→2` here are
 * the *short* edges crossing the bar, and the winding is the opposite way
 * round. Distinct from {@link Quad} so the two cannot be read for each other —
 * a bar's corner 1 is along the belt, a stripe's is across it.
 */
export type StripeQuad = readonly [Point, Point, Point, Point];

/**
 * The stripes for a belt, as quads in the same fraction space as
 * {@link BAR_QUADS}.
 *
 * Every point is interpolated *between the bar's own two long edges*, which is
 * what makes this perspective-correct without any perspective arithmetic: the
 * edges already converge the way the photograph does, so a stripe drawn between
 * them converges with it. A stripe near the tip comes out fractionally shorter
 * than one near the body, exactly as on the render.
 *
 * `count` is clamped rather than trusted — a rank arrives from the API, and a
 * fifth stripe would otherwise be drawn past the end of the bar and onto the
 * belt. Non-finite counts fall to zero explicitly: `Math.floor(NaN)` does
 * survive the clamp and then loses `i < NaN`, but that is a reader having to
 * know NaN's comparison rules to see that a wire value is handled.
 */
export function stripeQuads(belt: Belt, count: number): StripeQuad[] {
  const [bodyNear, tipNear, tipFar, bodyFar] = BAR_QUADS[belt];
  const slots = barSlots(belt);
  const drawn = Number.isFinite(count) ? Math.min(Math.max(Math.floor(count), 0), slots) : 0;

  // Slots are spaced as if there were one more than there are, so the outermost
  // stripe keeps a slot's clearance from the end of the bar instead of touching
  // it. Centred and spread symmetrically, so one stripe sits in the middle of
  // the bar rather than at an end, and a full set fills it evenly.
  const step = 1 / (slots + 1);
  const half = (step * STRIPE_RATIO) / 2;

  const quads: StripeQuad[] = [];
  for (let i = 0; i < drawn; i++) {
    const centre = 0.5 + (i - (drawn - 1) / 2) * step;
    const near = centre - half;
    const far = centre + half;

    // The same fraction along each long edge, so the crossing stays parallel to
    // the bar's own ends.
    const a0 = lerp(bodyNear, tipNear, near);
    const b0 = lerp(bodyFar, tipFar, near);
    const a1 = lerp(bodyNear, tipNear, far);
    const b1 = lerp(bodyFar, tipFar, far);

    quads.push([
      lerp(a0, b0, STRIPE_INSET),
      lerp(b0, a0, STRIPE_INSET),
      lerp(b1, a1, STRIPE_INSET),
      lerp(a1, b1, STRIPE_INSET),
    ]);
  }
  return quads;
}
