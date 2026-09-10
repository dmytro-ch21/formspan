import { Fragment } from 'react';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

import { vola } from '@/constants/Colors';
import type { HRTimelinePoint } from '@/lib/hrTimeline';
import { zoneColor, zoneForBPM } from '@/lib/hrZones';
import {
  chooseBpmAxis,
  clampLabelX,
  chooseTimeTicks,
  findTimelinePeak,
  peakLabel,
  peakLabelAnchor,
  timelineAccessibilityLabel,
  zoneRuns,
} from '@/lib/hrTimelineAxis';

/**
 * The HR-over-time line for one session — N491/#852, given a readable time
 * axis, a bpm ladder and a marked peak by N545/#988.
 *
 * Still deliberately dumb: every DECISION (which ticks, which bpm values,
 * where the peak is, which zone a stretch belongs to, what the caption says)
 * lives in `lib/hrTimelineAxis.ts` as pure functions with their own tests.
 * This file turns those answers into SVG and nothing else — which is the
 * split N545's fifth criterion asks for, and the reason a 20-minute session
 * and a two-hour one can both be checked without rendering anything.
 *
 * It never classifies a stretch as drilling or rolling — see
 * `lib/hrTimeline.ts`'s doc comment for why that line was not built. Reading
 * the shape is left to the athlete; what changed in N545 is only that the
 * shape now has numbers on both axes to read it against.
 *
 * A fixed logical width, matching `TrendChart`/`CHART_WIDTH`'s own
 * established convention in this codebase rather than a new
 * measure-the-parent approach — this app's cards are already sized to that
 * width elsewhere, so this fits the same column without its own layout
 * plumbing.
 *
 * **Still not the mobile trend-chart carve-out's target** (CLAUDE.md "Which
 * platform gets a feature"), and N545 does not move it closer to being one.
 * That rule guards a cross-SESSION trend read over time; this is a single
 * session's own already-fetched data, rendered once. There is no metric
 * picker — heart rate is the only thing it can show — and no date-range
 * control of any kind: the axis is the session's own duration, which is not
 * a choice anybody makes. The carve-out's 2026-08-19 amendment is what
 * licenses the rest of this file: "value-readable axes, a label on the first
 * and latest points" are explicitly allowed, because a chart you cannot read
 * a number off answers no question and sends the athlete to a desk.
 */

const WIDTH = 300;
const HEIGHT = 156;
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
/** Room above the plot for the peak's own label, which hangs over the line. */
const PAD_TOP = 24;
/** Room below for the time ticks. */
const PAD_BOTTOM = 22;

const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

/** Keeps a label's own edge off the very edge of the card. */
const LABEL_MARGIN = 2;

const AXIS_FONT_SIZE = 9;
const PEAK_FONT_SIZE = 10;

export function HRTimelineChart({
  points,
  hrMaxBPM = null,
  avgBPM = null,
  testID = 'hr-timeline-chart',
}: {
  points: HRTimelinePoint[];
  /** The athlete's HRmax, for zone colouring — `SessionMetrics.hr_max_bpm`.
   *  `null` draws one plain line: we have the beats but not the scale to
   *  place them on, and a grey line would imply zone 1. */
  hrMaxBPM?: number | null;
  /** The session's average, for the reference line — `SessionMetrics`'
   *  own figure, not one re-derived from the drawn points, so the line and
   *  the "Avg HR" stat above the chart cannot disagree. */
  avgBPM?: number | null;
  testID?: string;
}) {
  // Two points is the fewest that draw a line at all; below that there is
  // nothing to show a shape through, so the caller shouldn't render this —
  // returning null here too is a defensive backstop, not the primary gate.
  if (points.length < 2) return null;

  const bpms = points.map((p) => p.bpm);
  const axis = chooseBpmAxis(avgBPM != null ? [...bpms, avgBPM] : bpms);
  const totalMinutes = Math.max(points[points.length - 1].minutesElapsed, 1);
  const timeTicks = chooseTimeTicks(totalMinutes, PLOT_WIDTH);
  const peak = findTimelinePeak(points);

  const span = Math.max(axis.max - axis.min, 1);
  const x = (minutes: number) => PAD_LEFT + (minutes / totalMinutes) * PLOT_WIDTH;
  const y = (bpm: number) => PAD_TOP + PLOT_HEIGHT - ((bpm - axis.min) / span) * PLOT_HEIGHT;

  const runs = zoneRuns(points, hrMaxBPM);
  const lineColor = (zone: number) => (hrMaxBPM == null ? vola.danger : zoneColor(zone));

  const peakX = peak ? x(peak.minutesElapsed) : 0;
  const peakY = peak ? y(peak.bpm) : 0;
  const anchor = peak ? peakLabelAnchor((peakX - PAD_LEFT) / PLOT_WIDTH) : 'middle';
  const peakText = peak ? peakLabel(peak) : '';
  // The anchor picks which side the label hangs from; `clampLabelX` is what
  // guarantees it lands inside the canvas at any bpm/duration combination.
  const peakTextX = clampLabelX(
    anchor === 'start' ? peakX - 2 : anchor === 'end' ? peakX + 2 : peakX,
    anchor,
    peakText,
    LABEL_MARGIN,
    WIDTH - LABEL_MARGIN,
  );

  return (
    <Svg
      width="100%"
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={timelineAccessibilityLabel(axis, totalMinutes, peak)}
    >
      {/* The bpm ladder: a faint gridline per labelled value, so a point can
          be read off horizontally rather than estimated between two extremes. */}
      {axis.ticks.map((bpm) => (
        <Line
          key={`grid-${bpm}`}
          x1={PAD_LEFT}
          y1={y(bpm)}
          x2={WIDTH - PAD_RIGHT}
          y2={y(bpm)}
          stroke={vola.lineSoft}
          strokeWidth={0.5}
        />
      ))}
      {axis.ticks.map((bpm) => (
        <SvgText
          key={`ytick-${bpm}`}
          x={PAD_LEFT - 4}
          y={y(bpm) + 3}
          fontSize={AXIS_FONT_SIZE}
          fill={vola.textDim}
          textAnchor="end"
        >
          {bpm}
        </SvgText>
      ))}

      {/* The session's average, as a reference the peak reads against. */}
      {avgBPM != null && (
        <>
          <Line
            x1={PAD_LEFT}
            y1={y(avgBPM)}
            x2={WIDTH - PAD_RIGHT}
            y2={y(avgBPM)}
            stroke={vola.textDim}
            strokeWidth={1}
            strokeDasharray="3 3"
            testID={`${testID}-avg`}
          />
          <SvgText
            x={WIDTH - PAD_RIGHT}
            y={y(avgBPM) - 3}
            fontSize={AXIS_FONT_SIZE}
            fill={vola.textDim}
            textAnchor="end"
          >
            {`avg ${Math.round(avgBPM)}`}
          </SvgText>
        </>
      )}

      {/* The line itself, coloured by zone with the same ramp as the zone
          breakdown under it — each stretch takes the zone of the reading it
          starts from, exactly as the backend attributes those minutes. */}
      {runs.map((run, i) => (
        <Polyline
          key={`run-${i}`}
          points={run.points.map((p) => `${x(p.minutesElapsed).toFixed(1)},${y(p.bpm).toFixed(1)}`).join(' ')}
          stroke={lineColor(run.zone)}
          strokeWidth={1.75}
          fill="none"
          testID={`${testID}-run-${i}-zone-${run.zone}`}
        />
      ))}

      {/* The peak: a dropline to the axis so its TIME is readable against the
          ticks, a dot on the point itself, and the number beside it. */}
      {peak && (
        <>
          <Line
            x1={peakX}
            y1={peakY}
            x2={peakX}
            y2={PAD_TOP + PLOT_HEIGHT}
            stroke={vola.textDim}
            strokeWidth={0.75}
            strokeDasharray="2 3"
            testID={`${testID}-peak-drop`}
          />
          {/* The marker takes the zone of the peak READING itself — the one
              thing an athlete wants a colour for here is how hard the hardest
              moment was. */}
          <Circle
            cx={peakX}
            cy={peakY}
            r={2.75}
            fill={lineColor(zoneForBPM(peak.bpm, hrMaxBPM))}
            testID={`${testID}-peak-dot`}
          />
          <SvgText
            x={peakTextX}
            y={peakY - 7}
            fontSize={PEAK_FONT_SIZE}
            fontWeight="700"
            fill={vola.text}
            textAnchor={anchor}
            testID={`${testID}-peak-label`}
          >
            {peakText}
          </SvgText>
        </>
      )}

      {/* The baseline and the time axis. Elapsed, not clock — see
          `lib/hrTimelineAxis.ts`'s doc comment for the decision. */}
      <Line
        x1={PAD_LEFT}
        y1={PAD_TOP + PLOT_HEIGHT}
        x2={WIDTH - PAD_RIGHT}
        y2={PAD_TOP + PLOT_HEIGHT}
        stroke={vola.lineSoft}
        strokeWidth={1}
      />
      {timeTicks.map((tick, i) => {
        const tx = x(tick.minutesElapsed);
        const isFirst = i === 0;
        const isLast = i === timeTicks.length - 1;
        return (
          <Fragment key={`xtick-${tick.minutesElapsed}`}>
            <Line
              x1={tx}
              y1={PAD_TOP + PLOT_HEIGHT}
              x2={tx}
              y2={PAD_TOP + PLOT_HEIGHT + 3}
              stroke={vola.lineSoft}
              strokeWidth={1}
            />
            <SvgText
              x={tx}
              y={PAD_TOP + PLOT_HEIGHT + 13}
              fontSize={AXIS_FONT_SIZE}
              fill={vola.textDim}
              textAnchor={isFirst ? 'start' : isLast ? 'end' : 'middle'}
              testID={`${testID}-xtick-${i}`}
            >
              {tick.label}
            </SvgText>
          </Fragment>
        );
      })}
    </Svg>
  );
}
