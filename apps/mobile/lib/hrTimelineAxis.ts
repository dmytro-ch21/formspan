import type { HRTimelinePoint } from './hrTimeline';
import { zoneForBPM } from './hrZones';

/**
 * N545/#988 — everything the session heart-rate chart DECIDES, apart from
 * everything it draws.
 *
 * ## The complaint
 *
 * *"the graph with hr data should be timestamped correctly with more details
 * where it peaked and etc"*. The chart before this file existed drew a curve,
 * printed the first and last bpm on the y-axis, and labelled the x-axis with
 * exactly two things: `0:00` and the session's total duration. A peak was
 * visible as a bump and locatable at nothing more precise than "somewhere in
 * the middle" — which, per CLAUDE.md's 2026-08-19 amendment to the
 * mobile-chart carve-out, is a chart that answers no question and sends the
 * athlete to a desk. The comparison that produced the ticket (Zepp's chart of
 * the same class) carries a real time axis, a labelled avg and max, and a
 * readable bpm ladder.
 *
 * ## Why this is a separate file from the chart
 *
 * Tick selection, axis rounding and peak-finding are arithmetic with real
 * edge cases — a 20-minute session and a two-hour one must both come out
 * legible, a flat line must not divide by zero, a peak at the very first
 * sample must not have its label clipped off the left edge. None of that is
 * reachable through a render tree, and all of it is one-line-mutable, so it
 * lives here as pure functions with their own tests (the ticket's own fifth
 * criterion: "pure axis/tick/peak selection tested apart from the
 * rendering; mutation-checked").
 *
 * ## ELAPSED time, not clock time — decided, and here is why
 *
 * Zepp uses elapsed (`00:00 · 21:55 · 43:50 · 01:05:45`), and so does this,
 * for three reasons that are this app's rather than Zepp's:
 *
 * - The question the chart answers is *when in the session did this happen*.
 *   "38 minutes in" answers it; "6:47 PM" makes the athlete subtract.
 * - Every other duration on the same screen is already elapsed and already
 *   formatted this way — the zone breakdown's `21m` rows, the session's own
 *   duration stat. A clock axis would be the one place on the card measuring
 *   time differently from the rest of it.
 * - A clock axis renders in the READER's current timezone, not the one the
 *   session was trained in. A class logged abroad would come back reading
 *   five hours off, which is a new instance of exactly the "two surfaces
 *   answering one question, free to disagree" defect this repo files as a
 *   `W`. Elapsed minutes have no timezone.
 *
 * The one place a clock time still appears is `timelineCaption` below, and
 * only when the axis's own origin is NOT the session's logged start — see
 * that function.
 *
 * ## The axis describes the window the NUMBERS came from
 *
 * W19/#985 moved a session's heart-rate window off the athlete's typed
 * start/end and onto the watch's own workout, because a 90-minute class was
 * being scored almost entirely from pre-class background readings. That fix
 * is undone the moment a chart labels those samples with the athlete's typed
 * times: the curve would be real and every number under it would be
 * measured from somewhere else. So the caller builds the timeline from
 * `SessionMetrics.hr_window_start/end` — the window the avg, max, TRIMP and
 * zones were all computed from — and `timelineCaption` SAYS SO on screen
 * whenever that window differs from the logged one, rather than silently
 * renumbering.
 */

/**
 * The ladder of tick spacings, in minutes, tried smallest-first. Every one
 * is a spacing a human already thinks in — nobody reads an axis ticked every
 * 7 minutes.
 */
export const TICK_INTERVALS_MINUTES = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180] as const;

/**
 * The most time ticks the axis will ever carry. Five is Zepp's own count and
 * it is not a coincidence: with the end always labelled (below), five labels
 * put a gridline every quarter of the session, which is close enough to
 * locate a peak against and sparse enough to read at a glance.
 */
export const MAX_TIME_TICKS = 5;

/**
 * Width of one character of tick text, in the chart's own logical units, at
 * the 9px size it renders. Measured against the system font's digit advance
 * rather than assumed: `react-native-svg` has no text-metrics API to ask at
 * runtime, so the fit check below is an ESTIMATE — deliberately generous, so
 * it errs toward a sparser axis rather than an overlapping one.
 */
export const TICK_CHAR_WIDTH = 5.6;

/** Minimum clear space between two adjacent tick labels, same units. */
export const TICK_MIN_GAP = 10;

/**
 * How close to the end tick a regular tick may fall before it is dropped, as
 * a fraction of the tick interval. The end is always labelled — a peak at
 * minute 84 of an 87-minute session is unlocatable against an unlabelled
 * right edge — so when a multiple lands almost on top of it, the multiple is
 * the one that goes.
 */
export const END_TICK_MIN_GAP_FRACTION = 0.5;

/** The plot width the default fit check assumes — `HRTimelineChart`'s own. */
export const DEFAULT_PLOT_WIDTH = 258;

export type HRTimeTick = {
  minutesElapsed: number;
  label: string;
};

/**
 * Elapsed minutes as the app already writes them — `0m`, `21m`, `1h`,
 * `1h 28m`. Deliberately the same shape as the zone breakdown's own minute
 * figures on the same card.
 */
export function formatElapsed(totalMinutes: number): string {
  const whole = Math.max(0, Math.round(totalMinutes));
  if (whole < 60) return `${whole}m`;
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function tickSetFor(totalMinutes: number, interval: number): number[] {
  const ticks: number[] = [];
  for (let t = 0; t < totalMinutes; t += interval) ticks.push(t);
  if (ticks.length === 0) ticks.push(0);
  const last = ticks[ticks.length - 1];
  // The end always gets a label; a multiple sitting almost on top of it does
  // not (see END_TICK_MIN_GAP_FRACTION).
  if (ticks.length > 1 && totalMinutes - last < interval * END_TICK_MIN_GAP_FRACTION) ticks.pop();
  ticks.push(totalMinutes);
  return ticks;
}

function fits(ticks: number[], plotWidth: number): boolean {
  if (ticks.length > MAX_TIME_TICKS) return false;
  const width = ticks.reduce((sum, t) => sum + formatElapsed(t).length * TICK_CHAR_WIDTH + TICK_MIN_GAP, 0);
  return width <= plotWidth;
}

/**
 * The x-axis, for a session of any length.
 *
 * Two constraints, both of which have to hold, because either alone crowds
 * one end of the range: a COUNT cap (five labels), and a measured WIDTH fit
 * against the plot. A 20-minute session passes the width check at a 2-minute
 * spacing — eleven labels that technically fit and nobody can read — which
 * is what the count cap is for; a two-hour session's labels are each three
 * times wider than a 20-minute session's (`1h 30m` against `15m`), which is
 * what the width check is for.
 *
 * Always returns at least `[0, totalMinutes]`: the two ends of the session
 * are the floor of what an axis has to say, even if nothing else fits.
 */
export function chooseTimeTicks(
  totalMinutes: number,
  plotWidth: number = DEFAULT_PLOT_WIDTH,
): HRTimeTick[] {
  const label = (minutesElapsed: number): HRTimeTick => ({
    minutesElapsed,
    label: formatElapsed(minutesElapsed),
  });
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return [label(0)];

  for (const interval of TICK_INTERVALS_MINUTES) {
    const ticks = tickSetFor(totalMinutes, interval);
    if (fits(ticks, plotWidth)) return ticks.map(label);
  }
  return [label(0), label(totalMinutes)];
}

/** The bpm steps a y-axis ladder may use, tried smallest-first. */
export const BPM_TICK_STEPS = [5, 10, 20, 25, 50] as const;

/** The most bpm ticks the ladder will carry. */
export const MAX_BPM_TICKS = 5;

/**
 * A flat line (every reading identical, which a two-sample session can
 * genuinely be) has no span to scale against and would divide by zero. This
 * floors it to a range still worth drawing an axis for.
 */
export const MIN_BPM_SPAN = 10;

export type HRBpmAxis = {
  /** Bottom of the drawn range — a multiple of the chosen step, at or below
   *  the lowest value. */
  min: number;
  /** Top of the drawn range — a multiple of the chosen step, at or above the
   *  highest value. */
  max: number;
  /** Every labelled value, ascending, `min` and `max` included. */
  ticks: number[];
};

/**
 * The y-axis: round bpm values an athlete can read a number off, rather than
 * the raw min and max of this particular session (`137` and `184` tell you
 * the extremes and make every point between them arithmetic).
 *
 * The domain is snapped OUT to the chosen step in both directions, so the
 * top and bottom gridlines are themselves labelled ticks and the curve never
 * touches the frame.
 */
export function chooseBpmAxis(values: readonly number[]): HRBpmAxis {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { min: 0, max: MIN_BPM_SPAN, ticks: [0, MIN_BPM_SPAN] };

  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi - lo < MIN_BPM_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_BPM_SPAN / 2;
    hi = mid + MIN_BPM_SPAN / 2;
  }

  const steps = BPM_TICK_STEPS;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const count = Math.round((max - min) / step) + 1;
    if (count <= MAX_BPM_TICKS || i === steps.length - 1) {
      const ticks: number[] = [];
      for (let v = min; v <= max + 1e-9; v += step) ticks.push(Math.round(v));
      return { min, max, ticks };
    }
  }
  // Unreachable — the loop above always returns on its last iteration.
  return { min: Math.floor(lo), max: Math.ceil(hi), ticks: [Math.floor(lo), Math.ceil(hi)] };
}

export type HRTimelinePeak = {
  minutesElapsed: number;
  bpm: number;
  /** Where in the drawn series it sits, so the chart marks the point it
   *  actually drew rather than re-deriving a position. */
  index: number;
};

/**
 * The highest reading in the drawn series, and when it happened.
 *
 * **Earliest wins a tie**, deliberately: an athlete who hit 185 twice asks
 * "when did it first get that hard", and a later duplicate answers a
 * question nobody asked. Also the only tie-break that is stable under
 * `buildHRTimeline`'s downsampling, which can turn one raw maximum into two
 * equal bucket values.
 */
export function findTimelinePeak(points: readonly HRTimelinePoint[]): HRTimelinePeak | null {
  let best: HRTimelinePeak | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (!Number.isFinite(p.bpm) || !Number.isFinite(p.minutesElapsed)) continue;
    if (best === null || p.bpm > best.bpm) best = { minutesElapsed: p.minutesElapsed, bpm: p.bpm, index: i };
  }
  return best;
}

/** The peak's own label — the ticket's second criterion in one string. */
export function peakLabel(peak: HRTimelinePeak): string {
  return `${Math.round(peak.bpm)} bpm at ${formatElapsed(peak.minutesElapsed)}`;
}

/**
 * How far into the plot a label may sit before it has to be right-anchored
 * to stay on the card, and the mirror of it on the left.
 */
export const PEAK_LABEL_START_FRACTION = 0.2;
export const PEAK_LABEL_END_FRACTION = 0.8;

/**
 * Which way the peak label hangs off its marker. A peak in the first minute
 * of a session is a real and common shape (the athlete arrived already warm)
 * and a centred label there is half off the left edge of the phone.
 */
export function peakLabelAnchor(fractionAcross: number): 'start' | 'middle' | 'end' {
  if (!Number.isFinite(fractionAcross)) return 'middle';
  if (fractionAcross < PEAK_LABEL_START_FRACTION) return 'start';
  if (fractionAcross > PEAK_LABEL_END_FRACTION) return 'end';
  return 'middle';
}

export type HRZoneRun = {
  /** `zoneForBPM`'s answer — 1-5, or 0 for below zone 1 (`trimp.go`'s
   *  `ZoneNone`, which is not a zone). */
  zone: number;
  /** The consecutive points this run draws through. Adjacent runs SHARE
   *  their boundary point, so the rendered line is continuous rather than a
   *  dotted trail of gaps. */
  points: HRTimelinePoint[];
};

/**
 * Splits the drawn series into runs of one zone each, so the line is
 * coloured with the same `zoneColor` ramp as the zone breakdown directly
 * under it and the live HR indicator elsewhere in the app.
 *
 * **Each segment takes the zone of the reading it STARTS from**, which is
 * not an arbitrary choice: it is exactly how `trimp.go`'s `ZoneBreakdown`
 * attributes the minutes between two samples. Colouring a segment by its end
 * reading instead would draw a chart that disagrees with the bar chart
 * beneath it about which zone a stretch of minutes belonged to.
 *
 * `hrMaxBPM` of `null` yields a single run at zone 0 — the honest rendering
 * of "we have the beats but not the scale to place them on", which the chart
 * turns into its one plain colour rather than a grey line implying zone 1.
 */
export function zoneRuns(points: readonly HRTimelinePoint[], hrMaxBPM: number | null | undefined): HRZoneRun[] {
  if (points.length < 2) return [];
  const runs: HRZoneRun[] = [];
  let current: HRZoneRun = { zone: zoneForBPM(points[0].bpm, hrMaxBPM), points: [points[0]] };
  for (let i = 1; i < points.length; i += 1) {
    const zone = zoneForBPM(points[i - 1].bpm, hrMaxBPM);
    if (zone !== current.zone) {
      runs.push(current);
      current = { zone, points: [points[i - 1]] };
    }
    current.points.push(points[i]);
  }
  runs.push(current);
  return runs;
}

/**
 * What the caption over the chart says — and the one place the axis admits
 * its own origin.
 *
 * When the heart-rate window equals the session's logged one (every
 * live-tracked session, and every post-hoc one whose own window already held
 * the evidence), `0m` IS the start of the session and the caption says so
 * plainly. When W19/#985's workout-window preference, or N522/#934's fit,
 * moved the window somewhere else, `0m` is the start of THAT window — so the
 * caption names the clock time it corresponds to instead of quietly
 * renumbering the athlete's session. The fuller both-windows diagnostic is
 * still one line further down the card (`HRWindowMismatchNote`); this is the
 * shorter statement the axis itself needs to be honest.
 */
export function timelineCaption(differsFromSession: boolean, windowStartClock: string | null): string {
  if (!differsFromSession || !windowStartClock) return 'Heart rate across the session';
  return `Heart rate across the recording — 0m is ${windowStartClock}, when the readings start`;
}

/**
 * The whole chart in one sentence, for a screen reader — which is the only
 * form of it a VoiceOver user ever gets, so it carries the peak and its time
 * rather than only the range.
 */
export function timelineAccessibilityLabel(
  axis: HRBpmAxis,
  totalMinutes: number,
  peak: HRTimelinePeak | null,
): string {
  const base = `Heart rate across the session, ${axis.min} to ${axis.max} beats per minute over ${formatElapsed(totalMinutes)}`;
  return peak === null ? base : `${base}. Peaked at ${peakLabel(peak)}`;
}
