import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import type { Projection, TrendEmpty, TrendSeries } from '@/lib/trendSeries';

/**
 * The compact trend card: where you are, which way you are going, and the one
 * thing to do about it.
 *
 * Embedded rather than a screen — it opens Goals, above the movement picker,
 * because the first thing you should see in Goals is where you are against the
 * goal rather than a control. Tapping it opens the full page.
 *
 * ## Every number on it says what it is
 *
 * The delta carries **how many readings it came from** and **which series it
 * was measured off**. "Down 13.3 lbs past year" off two readings and off two
 * hundred are different claims, and a card that renders them identically is
 * inviting the athlete to act on the weaker one. `TrendDelta` makes that
 * unrenderable without the count — see `lib/trendSeries.ts`.
 *
 * `TODAY` is the **raw reading**, never the smoothed line: somebody who steps
 * off a scale and sees a different number here than the scale gave them will
 * not trust either number again.
 *
 * ## And every absence says which absence it is
 *
 * Four ways to have nothing to draw, and they are four different sentences.
 * The one that matters most is `unavailable` — we could not load it — which
 * must never be rendered as "no data yet", because that is a claim about the
 * athlete rather than about the network. This is the single most repeated bug
 * in this codebase and the union exists so this component cannot collapse it.
 */

export type TrendCardProps = {
  /** e.g. "WEIGHT". Short, because the delta sits beside it. */
  title: string;
  series: TrendSeries;
  goal?: number | null;
  projection?: Projection;
  /** Formats a value with no unit — "207.2". */
  format: (value: number) => string;
  /** The unit's short name — "lbs". Rendered beside the numbers, not inside them. */
  unit: string;
  /** How the window reads in the delta line — "past year". */
  periodLabel: string;
  minSpan: number;
  axisLabels?: [string, string, string];
  /** The primary action, bottom right. */
  actionLabel: string;
  onAction: () => void;
  /** Tapping the card body opens the full page. */
  onOpen?: () => void;
  /**
   * What opening it does, for a screen reader. The chart's own description
   * says what the picture SHOWS; without this, VoiceOver announces a button
   * that gives no hint it navigates anywhere.
   */
  openLabel?: string;
  testID?: string;
};

export function TrendCard({
  title,
  series,
  goal = null,
  projection,
  format,
  unit,
  periodLabel,
  minSpan,
  axisLabels,
  actionLabel,
  onAction,
  onOpen,
  openLabel,
  testID,
}: TrendCardProps) {
  const accent = useAccent();
  const latest = series.readings[series.readings.length - 1] ?? null;
  const delta = series.delta;

  return (
    <View style={styles.card} testID={testID}>
      <RNView style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        {delta ? (
          <Text style={styles.delta} testID="trend-card-delta">
            {arrow(delta.change)} {format(Math.abs(delta.change))} {unit} {periodLabel}
          </Text>
        ) : null}
      </RNView>

      {/* The evidence line. Never optional when a delta is shown: the count is
          what separates a trend from two weigh-ins, and an athlete cannot tell
          them apart from the number alone. `basis` is named too, because a
          delta that fell back to raw readings is carrying the day-to-day water
          swing the smoothed line exists to remove. */}
      {delta ? (
        <Text style={styles.evidence} testID="trend-card-evidence">
          {delta.n} {delta.n === 1 ? 'reading' : 'readings'}
          {delta.basis === 'readings' ? ', measured between two of them rather than off the trend line' : ''}
        </Text>
      ) : null}

      {series.empty ? (
        <Text style={styles.empty} testID="trend-card-empty">
          {emptyCopy(series.empty, title.toLowerCase())}
        </Text>
      ) : (
        <Pressable
          onPress={onOpen}
          disabled={!onOpen}
          accessibilityRole={onOpen ? 'button' : undefined}
          accessibilityLabel={onOpen ? openLabel : undefined}
        >
          <TrendChart
            series={series}
            goal={goal}
            projection={projection}
            format={format}
            minSpan={minSpan}
            height={140}
            axisLabels={axisLabels}
            accessibilityLabel={chartLabel(title, series, delta, unit, format, periodLabel)}
            testID="trend-card-chart"
          />
        </Pressable>
      )}

      <RNView style={styles.foot}>
        <RNView>
          {/* LATEST, not TODAY. For a lapsed logger the newest reading in the
              window is days or weeks old, and labelling it "today" is a false
              date claim over a true number — the mirror of the bug the callouts
              avoid by showing the reading rather than the mean. The date is
              shown for the same reason. */}
          <Text style={styles.footLabel}>LATEST</Text>
          <Text style={styles.footValue} testID="trend-card-today">
            {latest ? `${format(latest.value)} ${unit}` : '—'}
          </Text>
          {latest ? <Text style={styles.footWhen}>{latest.on}</Text> : null}
        </RNView>
        <Pressable
          onPress={onAction}
          hitSlop={8}
          style={[styles.action, { backgroundColor: accent.accent }]}
          accessibilityRole="button"
          testID="trend-card-action"
        >
          {/* `accent.on`, NOT `accent.ink` — this pill IS the fill, and `ink`
              paints the label in the accent colour on the accent colour. That
              shipped once; only a Simulator can see it. */}
          <Text style={[styles.actionText, { color: accent.on }]}>{actionLabel}</Text>
        </Pressable>
      </RNView>
    </View>
  );
}

function arrow(change: number): string {
  return change > 0 ? '↑' : change < 0 ? '↓' : '→';
}

/**
 * What to say when there is nothing to draw.
 *
 * Four sentences, and the first one is the reason this function exists rather
 * than a single string: "we could not load it" and "you have not recorded any"
 * are opposite statements, and rendering the second when the first is true
 * blames the athlete for a network failure.
 */
export function emptyCopy(empty: TrendEmpty, what: string): string {
  switch (empty.kind) {
    case 'unavailable':
      return `Couldn't load your ${what}. It'll be here when the connection is back.`;
    case 'none':
      return `Record your ${what} and the trend appears here.`;
    case 'none-in-range':
      return `Nothing in this range — you have ${empty.totalReadings} ${
        empty.totalReadings === 1 ? 'reading' : 'readings'
      } further back. Try a wider one.`;
    case 'too-few':
      return `${empty.have} of ${empty.need} readings needed for a trend line.`;
  }
}

/** The text alternative. A picture with no words is unreadable to a screen reader. */
function chartLabel(
  title: string,
  series: TrendSeries,
  delta: TrendSeries['delta'],
  unit: string,
  format: (v: number) => string,
  periodLabel: string,
): string {
  const n = series.readings.length;
  if (!delta) return `${title} trend, ${n} ${n === 1 ? 'reading' : 'readings'}, not enough to compare`;
  const dir = delta.change > 0 ? 'up' : delta.change < 0 ? 'down' : 'level';
  return `${title} trend: ${dir} ${format(Math.abs(delta.change))} ${unit} ${periodLabel}, from ${n} ${
    n === 1 ? 'reading' : 'readings'
  }`;
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: 1, borderColor: vola.line, padding: 14, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 12, letterSpacing: 1, opacity: 0.6 },
  delta: { fontSize: 14, fontWeight: '600' },
  evidence: { fontSize: 11, opacity: 0.55 },
  empty: { fontSize: 14, opacity: 0.7, paddingVertical: 28, textAlign: 'center', lineHeight: 20 },
  foot: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 2 },
  footLabel: { fontSize: 10, letterSpacing: 1, opacity: 0.5 },
  footValue: { fontSize: 20, fontWeight: '700' },
  footWhen: { fontSize: 11, opacity: 0.5 },
  action: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  actionText: { fontSize: 13, fontWeight: '600' },
});
