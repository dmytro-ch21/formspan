import { daysBetween } from './anthropometry';
import type { TrendSeries } from './trendSeries';

/**
 * Where everything on the trend chart goes.
 *
 * `lib/trendSeries.ts` owns what the numbers MEAN; `components/TrendChart.tsx`
 * owns the drawing. This file is the third thing, and it exists because W12 was
 * five separate defects and four of them were geometry:
 *
 * - the goal dragged the y-domain so far that a week of readings occupied 15px
 *   of a 200px chart, which is what made the dots and the line look like two
 *   different scales even though they always shared one;
 * - a sparse window put every mark in the right-hand tenth of the width;
 * - there was no y-axis, so no swing had a size;
 * - the value labels sat on top of the line and each other.
 *
 * None of those is arithmetic and none of them is drawing. They are placement,
 * and placement is the one part of a chart that a test asserting "a path was
 * rendered" can never see. So it lives here as pure functions over numbers,
 * with the component reduced to turning the answers into elements.
 *
 * **Everything is in viewBox units.** The chart's viewBox is fixed at
 * {@link CHART_WIDTH} wide, so nothing here needs a layout pass and the drawing
 * cannot flash at the wrong size on first render.
 */

/** The viewBox width. Fixed, so the chart never has to measure itself. */
export const CHART_WIDTH = 320;

/**
 * The left gutter the y-axis labels live in.
 *
 * Wide enough for `207.4` at 9pt. The labels are OUTSIDE the plot rather than
 * floating over it, which is what makes "nothing overlaps" a property of the
 * frame rather than something the placer has to keep re-winning.
 */
export const AXIS_GUTTER = 34;
export const PAD_RIGHT = 6;
export const PAD_TOP = 12;
/** The strip under the plot the date ticks live in. Same reasoning as the gutter. */
export const AXIS_STRIP = 16;

export type Pt = { x: number; y: number };
/** Top-left anchored, matching SVG's `<Rect>`. */
export type Rect = { x: number; y: number; w: number; h: number };
export type PlotBox = { left: number; right: number; top: number; bottom: number };

export function plotBox(height: number): PlotBox {
  return {
    left: AXIS_GUTTER,
    right: CHART_WIDTH - PAD_RIGHT,
    top: PAD_TOP,
    bottom: Math.max(PAD_TOP + 1, height - AXIS_STRIP),
  };
}

/**
 * The smallest share of the y-axis the DATA is allowed to keep.
 *
 * A goal is a target, not a measurement, and stretching the axis to reach one
 * costs the athlete the only part of the picture they can act on. Measured on
 * the W12 report: readings spanning 206.0–207.8 lb against a 190 lb goal put
 * every dot and the whole line inside y 31.7–46.1 of a 200px chart — 14px for
 * 1.8 lb of real movement, under 16px-tall labels. Half the height is the floor
 * the data keeps; a goal further away than that is reported as off-scale rather
 * than drawn, and the caller says so in words.
 */
const MIN_DATA_FRACTION = 0.5;

export type PlotBounds = {
  min: number;
  max: number;
  /**
   * Whether the goal fits inside the domain. False means the goal exists and is
   * further from the data than {@link MIN_DATA_FRACTION} allows — the chart
   * must then mark it as off-scale rather than silently omitting it, because a
   * missing goal line reads as "no goal set".
   */
  goalInside: boolean;
};

/**
 * The y-domain: fit the data, then reach toward the goal only as far as the
 * data can afford.
 *
 * **Never zero-based**, and that is deliberate. A bar chart starting above zero
 * exaggerates; a body-mass line starting at zero is worse, because a year of
 * work occupies the top 5% of the box and reads as flat. The quantity has no
 * meaningful zero — nobody is heading for 0 kg.
 *
 * A completely flat series has zero height and would divide by zero, so it is
 * given `minSpan` and centred in it.
 */
export function plotBounds(
  series: Pick<TrendSeries, 'low' | 'high'>,
  {
    minSpan,
    padFraction = 0.1,
    goal = null,
    minDataFraction = MIN_DATA_FRACTION,
  }: { minSpan: number; padFraction?: number; goal?: number | null; minDataFraction?: number },
): PlotBounds | null {
  if (series.low == null || series.high == null) return null;

  // The data's own domain first, with its padding, INDEPENDENT of the goal.
  // Computing this before the goal is what makes the cap below expressible: the
  // data's share is measured against a span the goal cannot have moved.
  let min: number;
  let max: number;
  const span = series.high - series.low;
  if (span < minSpan) {
    const mid = (series.high + series.low) / 2;
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
  } else {
    const pad = span * padFraction;
    min = series.low - pad;
    max = series.high + pad;
  }

  if (goal == null || !Number.isFinite(goal)) return { min, max, goalInside: false };
  if (goal >= min && goal <= max) return { min, max, goalInside: true };

  // Reach for the goal only if it can be had within the allowance. When it
  // cannot, the axis does NOT stretch part of the way: a half-empty chart with
  // the readings squashed into the top is the same defect at a milder setting,
  // and stopping short tells the athlete nothing the off-scale marker does not
  // say better. All of the height goes to the data, and the marker names the
  // edge the goal lies beyond.
  const allowance = (max - min) / minDataFraction;
  if (goal < min) {
    if (max - goal <= allowance) return { min: goal, max, goalInside: true };
    return { min, max, goalInside: false };
  }
  if (goal - min <= allowance) return { min, max: goal, goalInside: true };
  return { min, max, goalInside: false };
}

/**
 * The smallest share of the WIDTH the data is allowed to occupy before the
 * chart tightens its left edge onto the data.
 *
 * The W12 report's 3M screenshot: twelve readings, all inside the last
 * fortnight, so 90% of the chart was empty and the whole series sat in the
 * right-hand tenth. Measured on this code before the fix — every mark between
 * x=273 and x=320 of a 320-wide viewBox, 15% of the width.
 */
const MIN_WIDTH_FILL = 0.5;

/** The narrowest the tightened plot may get. See `plotWindow`. */
const MIN_PLOT_DAYS = 7;

export type PlotWindow = {
  /** Day index (from `series.from`) at the plot's left edge. */
  fromDay: number;
  /** Day index of the window's last day — always today. */
  toDay: number;
  /** True when the left edge was moved in onto the data. */
  clipped: boolean;
  /** The first day index carrying anything to draw, or null when nothing does. */
  firstDataDay: number | null;
};

/**
 * The x-domain.
 *
 * Only the LEFT edge ever moves, and only when the leading emptiness would
 * otherwise crush the data into a corner. The right edge is always today, which
 * is what keeps this a preset window rather than the date-range picker
 * CLAUDE.md's carve-out forbids — the athlete never chooses a start AND an end.
 *
 * **A trailing gap is left alone on purpose.** For somebody who stopped logging
 * a fortnight ago the empty right-hand strip IS the information, and shrinking
 * onto their last weigh-in would put a tick labelled "Today" on a reading that
 * is weeks old. That was a real bug once; this must not reintroduce it from the
 * other side.
 */
export function plotWindow(
  series: Pick<TrendSeries, 'from' | 'to' | 'readings' | 'segments'>,
  { minFill = MIN_WIDTH_FILL }: { minFill?: number } = {},
): PlotWindow {
  const toDay = Math.max(0, daysBetween(series.from, series.to));
  const days: number[] = [
    ...series.readings.map((p) => p.day),
    ...series.segments.flat().map((p) => p.day),
  ];
  if (days.length === 0) return { fromDay: 0, toDay, clipped: false, firstDataDay: null };

  const firstDataDay = Math.min(...days);
  const filled = toDay - firstDataDay + 1;
  if (toDay <= 0 || filled >= (toDay + 1) * minFill) {
    return { fromDay: 0, toDay, clipped: false, firstDataDay };
  }
  // A day or two of margin so the first mark is not welded to the axis, but
  // never so much that the tightening it exists to perform is undone.
  const margin = Math.max(1, Math.round(filled * 0.05));
  // And a floor, because the tightening has a degenerate end: ONE reading
  // logged today fills one day, so without this the axis becomes two days wide
  // and reads `18 Aug · 19 Aug · Today` under a chip that says 1M. A week is
  // the smallest span that still looks like a period.
  const fromDay = Math.min(firstDataDay - margin, toDay - (MIN_PLOT_DAYS - 1));
  return { fromDay: Math.max(0, fromDay), toDay, clipped: true, firstDataDay };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Liang–Barsky, once, because both things this file needs are the same answer
 * read differently: WHETHER a segment meets a rectangle, and WHERE it enters
 * and leaves one.
 *
 * Returns the parameter interval `[t0, t1]` along `a → b` that lies inside the
 * rectangle, or null when none does. A segment merely touching an edge counts
 * as inside — conservative on purpose, since the caller is deciding whether a
 * label is clear of a line.
 */
function clipParams(a: Pt, b: Pt, r: Rect): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      // Parallel to this edge: outside it means outside the rectangle entirely.
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

/** The part of `a → b` inside the box, or null when none of it is. */
export function clipSegment(a: Pt, b: Pt, box: PlotBox): [Pt, Pt] | null {
  const r: Rect = { x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top };
  const t = clipParams(a, b, r);
  if (!t) return null;
  const at = (k: number): Pt => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  return [at(t[0]), at(t[1])];
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when any leg of the polyline crosses (or touches) the rectangle. */
export function polylineHitsRect(pts: Pt[], rect: Rect): boolean {
  if (pts.length === 1) {
    const p = pts[0];
    return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
  }
  for (let i = 1; i < pts.length; i++) {
    if (clipParams(pts[i - 1], pts[i], rect)) return true;
  }
  return false;
}

/**
 * The legs of a polyline whose x-range overlaps `[lo, hi]`, as short polylines.
 *
 * Legs rather than a contiguous slice, because a polyline can leave and re-enter
 * the band; returning one slice from first to last would silently invent a leg
 * across everything between. Single points are kept — `polylineHitsRect` treats
 * a one-point polyline as a point test, which is the right answer for a lonely
 * day's dot.
 */
function nearLegs(pts: Pt[], lo: number, hi: number): Pt[][] {
  if (pts.length === 1) {
    return pts[0].x >= lo && pts[0].x <= hi ? [pts] : [];
  }
  const out: Pt[][] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (Math.min(a.x, b.x) <= hi && Math.max(a.x, b.x) >= lo) out.push([a, b]);
  }
  return out;
}

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

// ---------------------------------------------------------------------------
// Label placement
// ---------------------------------------------------------------------------

/** How far a label sits from the thing it labels, and from anything else. */
const GAP = 8;
/** Breathing room when testing a label against a line or another label. */
const CLEARANCE = 1.5;

export type BoxRequest = {
  key: string;
  /** The point the label belongs to. The leader is drawn back to this. */
  anchor: Pt;
  w: number;
  h: number;
  /** What the label says. Carried through so the drawing needs no second lookup. */
  text: string;
};

export type PlacedBox = {
  key: string;
  anchor: Pt;
  text: string;
  rect: Rect;
  /** Centre of `rect` — what the SVG text is anchored on. */
  centre: Pt;
  /**
   * False when no candidate position was free and the least-bad one was taken.
   * Never silently swallowed: the tests assert it is true for every window with
   * real data, so a future change that makes the chart uncrowdable fails loudly
   * instead of quietly going back to labels on top of the line.
   */
  clear: boolean;
};

/**
 * Put each label somewhere it touches its own point and covers nothing else.
 *
 * Candidates are tried in preference order — directly above first, because that
 * is where a reader looks — and the first one clear of every obstacle and every
 * label already placed wins. Requests are honoured in the order given, so the
 * caller puts the label that matters most first.
 *
 * **Clamping happens BEFORE scoring, not after.** A candidate pushed back
 * inside the box by the clamp is a different rectangle from the one that was
 * offered, and scoring the offered one would hand back a position that overlaps
 * exactly where the box is tightest — which is the top and the right-hand edge,
 * where the newest reading always sits.
 */
/**
 * Where a label may be tried, nearest first.
 *
 * A LADDER rather than a fixed rosette of eight positions, and the difference
 * is not cosmetic. Eight positions is what the first version had, and it left
 * the oldest reading's label sitting on the trend line at 3M, 6M, 1Y and All:
 * a label 65px wide clamped against the left edge spans a quarter of the plot,
 * and a line descending across that quarter passes through every one of the
 * eight. The ladder keeps stepping away in half-label increments until it finds
 * clear air, so the answer degrades to "further from the point" rather than to
 * "on top of the line".
 *
 * Ordered by distance, so the first clear rung is the closest one and the
 * leader stays short. Above is tried before below at each rung, because that is
 * where a reader looks for a label; a horizontal pair is offered at the first
 * rung only, for the common case of a point on a steep stretch.
 */
function candidates(w: number, h: number, box: PlotBox): Pt[] {
  const dxs = [0, w / 2 + GAP, -(w / 2 + GAP)];
  const step = h / 2;
  const rungs = Math.ceil((box.bottom - box.top) / step);
  const out: Pt[] = [];
  for (let k = 0; k <= rungs; k++) {
    const dy = h / 2 + GAP + k * step;
    for (const dx of dxs) out.push({ x: dx, y: -dy });
    for (const dx of dxs) out.push({ x: dx, y: dy });
    if (k === 0) for (const dx of dxs.slice(1)) out.push({ x: dx, y: 0 });
  }
  return out;
}

export function placeLabels(
  requests: BoxRequest[],
  obstacles: Pt[][],
  box: PlotBox,
): PlacedBox[] {
  const placed: PlacedBox[] = [];
  for (const req of requests) {
    const { w, h } = req;
    const offsets = candidates(w, h, box);

    // Only the legs that could possibly reach this label's candidates.
    //
    // A 1Y trend line is ~365 legs and the ladder offers ~140 positions, so the
    // unpruned worst case is 50k segment tests for one label — on every render,
    // since `format` is a fresh closure at both call sites and nothing upstream
    // memoizes. Candidates never move further than one label-width sideways, so
    // everything outside that band is arithmetic nobody reads.
    const reach = w * 1.5 + GAP * 2 + CLEARANCE;
    const lo = req.anchor.x - reach;
    const hi = req.anchor.x + reach;
    const near = obstacles.flatMap((o) => nearLegs(o, lo, hi));

    let best: PlacedBox | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const off of offsets) {
      const cx = clamp(req.anchor.x + off.x, box.left + w / 2, box.right - w / 2);
      const cy = clamp(req.anchor.y + off.y, box.top + h / 2, box.bottom - h / 2);
      const rect: Rect = { x: cx - w / 2, y: cy - h / 2, w, h };
      const test = inflate(rect, CLEARANCE);
      let score = 0;
      for (const o of near) if (polylineHitsRect(o, test)) score++;
      for (const p of placed) if (rectsOverlap(test, p.rect)) score++;
      // A label sitting ON its own point hides the measurement it describes.
      if (
        req.anchor.x >= test.x &&
        req.anchor.x <= test.x + test.w &&
        req.anchor.y >= test.y &&
        req.anchor.y <= test.y + test.h
      ) {
        score++;
      }
      const candidate: PlacedBox = {
        key: req.key,
        anchor: req.anchor,
        text: req.text,
        rect,
        centre: { x: cx, y: cy },
        clear: score === 0,
      };
      if (score === 0) {
        best = candidate;
        break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best) placed.push(best);
  }
  return placed;
}

/**
 * Where the leader line from a point to its label should stop.
 *
 * The nearest point on the label's edge, so the line reads as an attachment
 * rather than as a stray mark crossing the box. Null when the label already
 * sits on its point and a leader would be a smudge.
 */
export function leaderEnd(p: PlacedBox): Pt | null {
  const x = clamp(p.anchor.x, p.rect.x, p.rect.x + p.rect.w);
  const y = clamp(p.anchor.y, p.rect.y, p.rect.y + p.rect.h);
  const d = Math.hypot(x - p.anchor.x, y - p.anchor.y);
  return d < 2 ? null : { x, y };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
