import { daysBetween, shiftDate, type Measured } from '@/lib/anthropometry';

/**
 * The geometry behind Today's seven-day weight line (`components/today/ProgressCard.tsx`).
 *
 * ## Why this is a module and not four lines inside the component
 *
 * The chart it serves is the one the user pointed at (`~/Desktop/trend-face.jpeg`,
 * N201/#637): a line over seven points with `M T W T F S S` written underneath
 * it. **The letters are what make the arithmetic load-bearing.** Before this
 * existed, `Spark` positioned point `i` at `(i / (n - 1)) * width` — by its
 * INDEX in the array of readings, which is correct for a bare sparkline and a
 * lie the instant an axis appears beneath it. Four readings in a week spread
 * themselves across the full width and land under four letters that are not
 * their own days; the chart then says the athlete weighed in on Monday when
 * they weighed in on Thursday, in a component whose entire job is to report
 * what was measured.
 *
 * So x comes from the reading's DATE, on a fixed seven-slot grid ending today,
 * and a day with no reading leaves its slot empty. Geometry is the one part of
 * a chart that a test asserting "a line was rendered" can never see, which is
 * why it is numbers here and asserted as numbers in
 * `lib/__tests__/sparkWeek.test.ts` — the same split
 * `lib/trendChartLayout.ts` uses for the full-size chart on `/goals/trend`.
 *
 * ## What it deliberately does not do
 *
 * **No smoothing.** `lib/anthropometry.ts`'s `trendWeight` is the right answer
 * for the figure beside this line and the wrong one at a week's width, where
 * the rolling mean has nothing to work with. These are the raw readings — the
 * evidence behind the figure, not a second claim about it.
 *
 * **No interpolation across a gap.** A missing day is drawn as a gap. Joining
 * Tuesday to Thursday with a straight segment is honest (it is what a line
 * chart means); inventing a Wednesday point on it is not, and neither is
 * shuffling Thursday left so the series looks unbroken.
 */

/** Slots on the grid. Seven, ending today — one question, one window. */
export const SPARK_DAYS = 7;

/**
 * Weekday initials, indexed by `Date#getUTCDay()` (0 = Sunday).
 *
 * Two `T`s and two `S`s, exactly as the reference has them: the letters mark
 * position on a week the athlete is already living in, and disambiguating them
 * (`Tu`, `Th`) costs twice the width for a distinction the neighbouring letters
 * already make.
 */
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

/** One slot on the grid — drawn whether or not a reading landed in it. */
export type SparkDay = {
  /** `YYYY-MM-DD`. */
  on: string;
  /** `M`, `T`, … — see {@link LETTERS}. */
  letter: string;
  /** Centre of the slot, in SVG units. */
  x: number;
  /** The last slot, always: the grid ends today. */
  isToday: boolean;
};

/** A reading, placed. */
export type SparkPoint = {
  on: string;
  /** Kilograms, as stored. Display conversion is the caller's job. */
  value: number;
  x: number;
  y: number;
  /** The most recent reading in the window — the one the reference rings. */
  latest: boolean;
};

export type SparkBox = {
  width: number;
  /** Height of the PLOT, above the letters. */
  height: number;
  /** Horizontal breathing room, so the first and last dots are not clipped. */
  inset: number;
  /** Vertical breathing room, top and bottom, for the same reason. */
  pad: number;
};

export type SparkGeometry = {
  /** Always seven, oldest first. */
  days: SparkDay[];
  /**
   * The readings that fell inside the window, oldest first — **empty below
   * two**, because a single dot is not a line and a flat line through one
   * point asserts a stability nobody measured.
   */
  points: SparkPoint[];
  /**
   * Where a drop-line ends: the very foot of the plot box, NOT the y of its
   * lowest point. The two differ by `pad`, and using the latter would give the
   * week's lightest reading a zero-length drop-line — the one point whose tie
   * to its letter the eye most needs, because it sits furthest from the axis
   * in the reference and nearest to it here.
   */
  baseline: number;
};

/** Fewer than this and the card draws nothing at all. */
export const MIN_SPARK_POINTS = 2;

/**
 * Place a week of readings on a fixed seven-day grid ending `today`.
 *
 * `today` and every `measured_on` are `YYYY-MM-DD` and are compared as UTC
 * civil dates, matching `lib/anthropometry.ts` — the app stores a check-in
 * against the day the athlete says it happened, never against an instant.
 */
export function sparkWeek(
  readings: readonly Measured[],
  today: string,
  box: SparkBox,
): SparkGeometry {
  const step = SPARK_DAYS > 1 ? (box.width - 2 * box.inset) / (SPARK_DAYS - 1) : 0;

  const days: SparkDay[] = [];
  for (let i = 0; i < SPARK_DAYS; i += 1) {
    const on = shiftDate(today, i - (SPARK_DAYS - 1));
    days.push({
      on,
      letter: letterFor(on),
      x: box.inset + i * step,
      isToday: i === SPARK_DAYS - 1,
    });
  }

  // Index the slots by date, so a reading finds its own x rather than the x of
  // its position in the list. This map IS the fix.
  const slot = new Map(days.map((d) => [d.on, d.x]));

  const inWindow = readings
    .filter((r) => {
      if (r.weight_kg == null || r.weight_kg <= 0) return false;
      const age = daysBetween(r.measured_on, today);
      return age >= 0 && age < SPARK_DAYS;
    })
    .sort((a, b) => a.measured_on.localeCompare(b.measured_on));

  // One point per DAY. Two readings on one date would otherwise draw two dots
  // at the same x joined by a vertical segment, which reads as a same-day
  // swing the chart cannot actually date. Last one wins, matching how the
  // check-in screen treats a re-save of the same day.
  const byDay = new Map<string, number>();
  for (const r of inWindow) byDay.set(r.measured_on, r.weight_kg as number);

  const values = [...byDay.values()];
  const lo = values.length > 0 ? Math.min(...values) : 0;
  const hi = values.length > 0 ? Math.max(...values) : 0;
  // A perfectly flat week would divide by zero. The hair of range is only that
  // — a divide-by-zero guard. Every reading equals `lo` in that week, so the
  // line comes out FLAT ALONG THE BOTTOM INSET (`height - pad`), which is the
  // ordinary lowest-reading rule applied uniformly, not a special middle
  // placement. Said plainly because this comment used to claim the middle, and
  // `sparkWeek.test.ts`'s own flat-week case asserts the bottom.
  const span = hi - lo < 0.01 ? 1 : hi - lo;
  const y = (v: number) => box.height - box.pad - ((v - lo) / span) * (box.height - 2 * box.pad);

  const entries = [...byDay.entries()];
  const points: SparkPoint[] =
    entries.length < MIN_SPARK_POINTS
      ? []
      : entries.map(([on, value], i) => ({
          on,
          value,
          // `slot.get` cannot miss: `byDay`'s keys came through the window
          // filter above, which is the same seven dates `days` was built from.
          x: slot.get(on) as number,
          y: y(value),
          latest: i === entries.length - 1,
        }));

  return { days, points, baseline: box.height };
}

/**
 * The polyline through the points, as SVG `x,y` pairs.
 *
 * Empty string for fewer than two points, so a caller that forgets to check
 * draws nothing rather than a zero-length stroke — which `strokeLinecap:
 * 'round'` would render as a dot, i.e. as a reading.
 */
export function sparkPolyline(points: readonly SparkPoint[]): string {
  if (points.length < MIN_SPARK_POINTS) return '';
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

function letterFor(on: string): string {
  return LETTERS[new Date(Date.parse(`${on}T00:00:00Z`)).getUTCDay()];
}

/** Two decimals is well under a device pixel and keeps the path readable. */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}
