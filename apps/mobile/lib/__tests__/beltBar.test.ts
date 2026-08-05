import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BAR_QUADS, barSlots, stripeQuads, type Point, type Quad } from '../beltBar';
import { BELTS, MAX_DEGREE, MAX_STRIPES, type Belt } from '../bjj';

/**
 * The stripes are drawn, not photographed, so nothing but arithmetic keeps them
 * on the bar — and for a while nothing did. All five belts shared one geometry
 * measured off the black belt, which put white's stripes ~25px above its real
 * bar at 1024px wide and hung purple's over the edge. It shipped, and it took a
 * screenshot from the user to catch, because a stripe in the wrong place still
 * renders perfectly happily.
 *
 * So the load-bearing assertion here is **containment**: every stripe, on every
 * belt, at every count it can be asked for, lies inside that belt's own bar.
 */

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];

/** Signed area — positive if the quad's corners wind one way, negative the other. */
function area(q: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = q[i];
    const [x1, y1] = q[(i + 1) % 4];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

function centroid(q: Quad): Point {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** True when `p` is inside convex `q` — every edge turns the same way towards it. */
function inside(p: Point, q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(sub(q[(i + 1) % 4], q[i]), sub(p, q[i]));
    // On an edge counts as in: a stripe inset to exactly the bar's edge is
    // placed correctly, and floating point should not decide otherwise.
    if (Math.abs(c) < 1e-12) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

describe('the measured bars', () => {
  it.each(BELTS)('%s is a convex quad wound consistently with the others', (belt) => {
    const q = BAR_QUADS[belt];
    expect(q).toHaveLength(4);
    // Every corner sees the other three as a convex hull would. A quad entered
    // with two corners transposed is a bowtie, and every containment test below
    // would then pass or fail meaninglessly.
    for (let i = 0; i < 4; i++) {
      const prev = sub(q[i], q[(i + 3) % 4]);
      const next = sub(q[(i + 1) % 4], q[i]);
      expect(Math.sign(cross(prev, next))).toBe(Math.sign(area(q)));
    }
  });

  it.each(BELTS)('%s has its long edges at 0→1 and 3→2', (belt) => {
    const [bodyNear, tipNear, tipFar, bodyFar] = BAR_QUADS[belt];
    // stripeQuads walks 0→1 alongside 3→2. Enter a belt's corners rotated by
    // one and its stripes are drawn lengthways down the bar instead of across.
    expect(dist(bodyNear, tipNear)).toBeGreaterThan(dist(bodyNear, bodyFar));
    expect(dist(bodyFar, tipFar)).toBeGreaterThan(dist(tipNear, tipFar));
  });

  it('gives each belt its own geometry', () => {
    // The bug this file exists for was one geometry copied across all five.
    const seen = new Set(BELTS.map((b) => JSON.stringify(BAR_QUADS[b])));
    expect(seen.size).toBe(BELTS.length);
  });

  /**
   * The only assertion here that is not circular.
   *
   * Everything else checks stripes against the same quads it is testing, so it
   * proves the arithmetic and says nothing about whether the quads match the
   * artwork — a table measured off the wrong image would satisfy every one of
   * them. What can go wrong silently is a render being **replaced**: the
   * numbers stay valid-looking, the app keeps drawing, and the stripes drift
   * off a bar that has moved. Nothing about that is visible in a diff of a
   * binary asset.
   *
   * So pin the artwork the measurements were taken from. If this fails, the
   * renders changed and `lib/beltBar.ts` has to be re-measured — do not update
   * the hashes to make it pass.
   */
  it('still has the renders these were measured from', () => {
    const dir = join(__dirname, '..', '..', 'assets', 'images', 'belts');
    const digests = Object.fromEntries(
      BELTS.map((b) => [
        b,
        createHash('sha256').update(readFileSync(join(dir, `${b}.webp`))).digest('hex'),
      ]),
    );
    expect(digests).toEqual(MEASURED_FROM);
  });
});

/** SHA-256 of each render as of the measurement. See the test above. */
const MEASURED_FROM: Record<Belt, string> = {
  white: 'c0acdf5990f5e4d5df6094b30b348e0813e434d3405df802c9fea1a89bfe985e',
  blue: '26b99ee0c8d420bc4c188d098fba4006cdc0ca2d928fa1e4f82fff0cb487a2c5',
  purple: '8ff52916d9fde81ebe7e996ee96f0de24b742949009795b5a55ea41bd399ec43',
  brown: '2f448922b126e13e05a31478ab5bbda2ca409b09f0dcd833ef14f4c547296e9f',
  black: '9505aae4a819e015d738b951ceeb06d96fa467b76aec194c193a5481ddc9b01b',
};

describe('stripeQuads', () => {
  const counts = (belt: (typeof BELTS)[number]) =>
    Array.from({ length: barSlots(belt) + 1 }, (_, n) => n);

  it.each(BELTS)('draws %s stripes inside its own bar, at every count', (belt) => {
    for (const n of counts(belt)) {
      for (const stripe of stripeQuads(belt, n)) {
        for (const corner of stripe) {
          expect({ belt, n, corner, inside: inside(corner, BAR_QUADS[belt]) }).toEqual({
            belt,
            n,
            corner,
            inside: true,
          });
        }
      }
    }
  });

  it.each(BELTS)('draws exactly the %s stripes asked for', (belt) => {
    for (const n of counts(belt)) {
      expect(stripeQuads(belt, n)).toHaveLength(n);
    }
  });

  it('clamps a rank the API should never have sent', () => {
    // `stripes` and `degree` arrive over the wire. Past the end of the bar is
    // the belt itself, so an out-of-range rank has to be dropped, not drawn.
    expect(stripeQuads('white', MAX_STRIPES + 1)).toHaveLength(MAX_STRIPES);
    expect(stripeQuads('black', MAX_DEGREE + 1)).toHaveLength(MAX_DEGREE);
    expect(stripeQuads('white', 99)).toHaveLength(MAX_STRIPES);
    expect(stripeQuads('blue', -1)).toHaveLength(0);
    expect(stripeQuads('blue', Number.NaN)).toHaveLength(0);
  });

  it('gives a black belt six slots and everyone else four', () => {
    expect(barSlots('black')).toBe(MAX_DEGREE);
    for (const belt of BELTS.filter((b) => b !== 'black')) {
      expect(barSlots(belt)).toBe(MAX_STRIPES);
    }
  });

  it.each(BELTS)('centres the %s set on the bar', (belt) => {
    // A set drawn from one end reads as a belt part-way through being promoted.
    const bar = centroid(BAR_QUADS[belt]);
    for (const n of [1, 2, barSlots(belt)]) {
      const stripes = stripeQuads(belt, n);
      const mid = stripes.reduce(
        (acc, s) => [acc[0] + centroid(s)[0] / n, acc[1] + centroid(s)[1] / n] as Point,
        [0, 0] as Point,
      );
      expect(dist(mid, bar)).toBeLessThan(1e-9);
    }
  });

  it.each(BELTS)('spaces %s stripes evenly, without touching', (belt) => {
    const slots = barSlots(belt);
    const mids = stripeQuads(belt, slots).map(centroid);
    const gaps = mids.slice(1).map((m, i) => dist(m, mids[i]));
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 9);

    // Equal spacing alone would also hold if every stripe sat on top of the
    // last, so measure one against the gap: a stripe is 0.6 of its slot, which
    // leaves consecutive ones 0.4 of a slot of clear bar between them.
    const stripe = stripeQuads(belt, slots)[0];
    const along = dist(
      [(stripe[0][0] + stripe[1][0]) / 2, (stripe[0][1] + stripe[1][1]) / 2],
      [(stripe[2][0] + stripe[3][0]) / 2, (stripe[2][1] + stripe[3][1]) / 2],
    );
    expect(gaps[0]).toBeGreaterThan(along);
  });

  it.each(BELTS)('leaves bare bar at both ends of a full %s set', (belt) => {
    // Containment alone permits a full set crowded up against both ends — the
    // stripes are still on the bar, and it looks like tape applied by someone
    // in a hurry. Spacing for one more slot than exists is what reserves the
    // margin, so measure it: at least a stripe's width of clear bar at each
    // end, which is also what a real belt shows.
    const q = BAR_QUADS[belt];
    const stripes = stripeQuads(belt, barSlots(belt));
    const first = stripes[0];
    const last = stripes[stripes.length - 1];
    const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    const thickness = dist(mid(first[0], first[1]), mid(first[2], first[3]));
    const bodyEnd = dist(mid(q[0], q[3]), mid(first[0], first[1]));
    const tipEnd = dist(mid(q[1], q[2]), mid(last[2], last[3]));

    expect(bodyEnd).toBeGreaterThan(thickness);
    expect(tipEnd).toBeGreaterThan(thickness);
  });

  it('keeps a stripe narrower than the bar it sits on', () => {
    // The inset is what stops a stripe reading as the bar cut into pieces.
    for (const belt of BELTS) {
      const [bodyNear, , , bodyFar] = BAR_QUADS[belt];
      const barAcross = dist(bodyNear, bodyFar);
      const stripe = stripeQuads(belt, 1)[0];
      expect(dist(stripe[0], stripe[1])).toBeLessThan(barAcross);
      expect(dist(stripe[0], stripe[1])).toBeGreaterThan(barAcross * 0.8);
    }
  });
});
