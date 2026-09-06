import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';

import { vola } from '@/constants/Colors';
import type { HRTimelinePoint } from '@/lib/hrTimeline';

/**
 * The raw HR-over-time line for one session — N491/#852.
 *
 * Deliberately dumb: given points, it draws a line through them and labels
 * the axes with real numbers. It never classifies a stretch as drilling or
 * rolling — see `lib/hrTimeline.ts`'s doc comment for why that line was not
 * built. Reading the shape (a plateau, then a step up) is left entirely to
 * the athlete, the same "evidence over interpretation" posture the rest of
 * this session's HR report already takes one level up (avg/max HR, TRIMP,
 * zones — all real numbers, never a verdict rendered as fact).
 *
 * A fixed logical width, matching `TrendChart`/`CHART_WIDTH`'s own
 * established convention in this codebase rather than a new
 * measure-the-parent approach — this app's cards are already sized to that
 * width elsewhere, so this fits the same column without its own layout
 * plumbing.
 *
 * Not the mobile trend-chart carve-out's target at all (CLAUDE.md "Which
 * platform gets a feature"): that rule guards a cross-SESSION trend read
 * over time to decide something ("am I losing weight fast enough"). This is
 * a single session's own already-fetched data, rendered once, with no range
 * control of any kind — the same category as the zone-breakdown bars
 * already on this exact screen (`HRSessionReport.tsx`), not a new instance
 * of that carve-out's chart.
 */

const WIDTH = 300;
const HEIGHT = 92;
const PAD_LEFT = 30;
const PAD_RIGHT = 6;
const PAD_TOP = 14;
const PAD_BOTTOM = 16;

/** A flat line (every reading identical) would divide by zero scaling to the
 *  plot's height — this floors the y-axis span to something still legible. */
const MIN_BPM_SPAN = 8;

function formatMinutes(totalMinutes: number): string {
  const whole = Math.round(totalMinutes);
  if (whole < 60) return `${whole}m`;
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function HRTimelineChart({
  points,
  testID = 'hr-timeline-chart',
}: {
  points: HRTimelinePoint[];
  testID?: string;
}) {
  // Two points is the fewest that draw a line at all; below that there is
  // nothing to show a shape through, so the caller shouldn't render this —
  // returning null here too is a defensive backstop, not the primary gate.
  if (points.length < 2) return null;

  const bpms = points.map((p) => p.bpm);
  const minBpm = Math.min(...bpms);
  const maxBpm = Math.max(...bpms);
  const span = Math.max(maxBpm - minBpm, MIN_BPM_SPAN);
  const totalMinutes = Math.max(points[points.length - 1].minutesElapsed, 1);

  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const x = (minutes: number) => PAD_LEFT + (minutes / totalMinutes) * plotWidth;
  const y = (bpm: number) => PAD_TOP + plotHeight - ((bpm - minBpm) / span) * plotHeight;

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.minutesElapsed).toFixed(1)} ${y(p.bpm).toFixed(1)}`)
    .join(' ');

  return (
    <Svg
      width="100%"
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={`Heart rate across the session, from ${Math.round(minBpm)} to ${Math.round(maxBpm)} beats per minute over ${formatMinutes(totalMinutes)}`}
    >
      {/* y-axis: just the two real numbers that bound this session's own
          readings — value-readable per CLAUDE.md's mobile-chart amendment,
          without a full tick ladder this small a plot has no room for. */}
      <SvgText x={2} y={PAD_TOP + 4} fontSize={10} fill={vola.textDim}>
        {Math.round(maxBpm)}
      </SvgText>
      <SvgText x={2} y={HEIGHT - PAD_BOTTOM} fontSize={10} fill={vola.textDim}>
        {Math.round(minBpm)}
      </SvgText>
      <Line
        x1={PAD_LEFT}
        y1={PAD_TOP}
        x2={PAD_LEFT}
        y2={HEIGHT - PAD_BOTTOM}
        stroke={vola.lineSoft}
        strokeWidth={1}
      />

      <Path d={d} stroke={vola.danger} strokeWidth={1.75} fill="none" />

      {/* x-axis: session start and its own real duration — not a preset
          window and not a picker, so this is not the trend-chart carve-out's
          date-range control; there is nothing here to choose between. */}
      <SvgText x={PAD_LEFT} y={HEIGHT} fontSize={10} fill={vola.textDim}>
        0:00
      </SvgText>
      <SvgText x={WIDTH - PAD_RIGHT} y={HEIGHT} fontSize={10} fill={vola.textDim} textAnchor="end">
        {formatMinutes(totalMinutes)}
      </SvgText>
    </Svg>
  );
}
