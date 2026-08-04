import { StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';

/**
 * A number, with its units set smaller than its digits.
 *
 * `1h 41m` reads as one quantity when the `h` and `m` are two-thirds the size
 * of the figures and a step quieter in colour, and as four things when they
 * aren't. The same treatment does the work for `12.4t`, `2,730lb` and a bare
 * `3` without any of the call sites knowing which they have — which matters,
 * because the metric on the Today screen is chosen at runtime from whatever
 * the athlete actually logged.
 *
 * The split is a regex over digit runs rather than a formatter change on
 * purpose: `formatDuration`, `formatVolume` and `formatElapsed` each have
 * their own rounding rules and callers outside this component, and reshaping
 * their return type to feed a display component would put presentation
 * concerns into three lib functions to save one regex here.
 *
 * An em dash — the codebase's "we don't know" — is deliberately not treated as
 * a unit. It renders at full size in the muted colour, so a missing figure
 * still occupies a number's worth of space rather than collapsing the row.
 */

/** Digits, with the separators that belong inside a figure. */
const FIGURES = /([\d]+(?:[.,][\d]+)*)/;

export function StatValue({
  value,
  size = 26,
  color = vola.text,
}: {
  value: string;
  size?: number;
  color?: string;
}) {
  const unitSize = Math.round(size * 0.62);

  if (value === '—') {
    return (
      <Text style={[styles.value, { fontSize: size, color: vola.textDim }]}>
        {value}
      </Text>
    );
  }

  // `split` with a capturing group keeps the delimiters, so this alternates
  // non-figure, figure, non-figure… and empty strings fall out harmlessly.
  const parts = value.split(FIGURES).filter((p) => p !== '');

  return (
    <Text style={[styles.value, { fontSize: size, color }]} numberOfLines={1}>
      {parts.map((part, i) =>
        FIGURES.test(part) ? (
          part
        ) : (
          <Text key={i} style={{ fontSize: unitSize, color: vola.textMuted }}>
            {part}
          </Text>
        ),
      )}
    </Text>
  );
}

/**
 * One statistic: the figure, what it is, and optionally which way it moved.
 *
 * The delta arrow is colour-neutral, matching `TrainingSummary`'s tiles and
 * for the same reason stated there — more volume is progress in a build block
 * and a failed deload in a taper, so this states the change and leaves the
 * reading to whoever knows what the block was for.
 */
export function Stat({
  label,
  value,
  change,
  size,
}: {
  label: string;
  value: string;
  change?: number | null;
  size?: number;
}) {
  const rounded = change == null ? null : Math.round(change);
  // Grouped, or VoiceOver reads the figure and its label as two unrelated
  // stops with nothing connecting them.
  return (
    <RNView style={styles.stat} accessible accessibilityLabel={`${value} ${label}`}>
      <StatValue value={value} size={size} />
      <Text style={styles.label}>{label}</Text>
      {rounded != null && rounded !== 0 && (
        <Text style={styles.delta}>
          <Text aria-hidden>{rounded > 0 ? '↑' : '↓'} </Text>
          {Math.abs(rounded)}%
        </Text>
      )}
    </RNView>
  );
}

/**
 * Statistics side by side, separated by rules rather than gaps.
 *
 * A hairline between figures is what makes three numbers read as one panel;
 * spaced apart they read as three cards that happen to be adjacent. Borrowed
 * straight from the reference's week-to-date block.
 */
export function StatRow({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}) {
  const items = Array.isArray(children) ? children.filter(Boolean) : [children];
  return (
    <View style={styles.row} testID={testID}>
      {items.map((child, i) => (
        <RNView key={i} style={styles.slot}>
          {i > 0 && <RNView style={styles.divider} />}
          {child}
        </RNView>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  value: {
    fontWeight: '800',
    letterSpacing: -0.3,
    fontVariant: ['tabular-nums'],
  },
  stat: { gap: 1 },
  label: {
    fontSize: 11,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: '600',
  },
  delta: { fontSize: 11, color: vola.textMuted, marginTop: 1 },

  row: {
    flexDirection: 'row',
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    paddingVertical: 14,
  },
  slot: { flex: 1, paddingHorizontal: 14, justifyContent: 'center' },
  divider: {
    position: 'absolute',
    left: 0,
    top: 2,
    bottom: 2,
    width: StyleSheet.hairlineWidth,
    backgroundColor: vola.line,
  },
});
