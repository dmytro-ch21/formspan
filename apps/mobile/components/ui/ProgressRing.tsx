import { StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';

/**
 * A percentage, drawn as a ring.
 *
 * The roadmap reference puts one on both summary cards, and a ring rather than
 * a second bar for a reason worth keeping: the bar beside it is *this belt's*
 * progress through its milestones, and the ring is the same figure at a glance
 * from across the screen. Two bars would read as two different measurements.
 *
 * **`percent` is nullable and null is not zero.** A curriculum nobody has
 * enrolled in is not 0% through — nothing is being counted at all — and a
 * milestone made entirely of concepts can never move, so 0% there reads as
 * failure rather than as "there is nothing here to count". Both cases draw the
 * track and an em dash.
 */
export function ProgressRing({
  percent,
  size = 46,
  stroke = 3,
  color,
  label,
  testID,
}: {
  /** 0–100, or null when there is nothing to report. */
  percent: number | null;
  size?: number;
  stroke?: number;
  /** The belt's accent. Passed in so this stays a dumb component. */
  color: string;
  /** Spoken form. "0%" alone tells a screen reader nothing about what of. */
  label: string;
  testID?: string;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const shown = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  // `- 0.001` so a full ring does not close on a dash boundary and leave a
  // hairline seam at the twelve o'clock start point.
  const filled = circumference * (shown / 100) - 0.001;

  return (
    <RNView
      style={[styles.wrap, { width: size, height: size }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      testID={testID}
    >
      <Svg width={size} height={size}>
        {/* The track is the belt's own colour, held back rather than greyed:
            the reference's ring reads as one belt-coloured object with a
            brighter arc on it, not as an accent sitting on grey furniture. */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeOpacity={0.45}
          strokeWidth={stroke}
          fill="none"
        />
        {shown > 0 && (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
            // Twelve o'clock, clockwise. Without this an arc starts at three
            // o'clock, which reads as the ring being rotated rather than filled.
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            fill="none"
          />
        )}
      </Svg>
      <RNView style={styles.centre} pointerEvents="none">
        <Text style={[styles.value, { color, fontSize: Math.round(size * 0.28) }]}>
          {percent === null ? '—' : `${shown}%`}
        </Text>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  centre: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    fontWeight: '700',
    // Tabular, or the ring's centre shifts as the number goes 9% → 10%.
    fontVariant: ['tabular-nums'],
    color: vola.text,
  },
});
