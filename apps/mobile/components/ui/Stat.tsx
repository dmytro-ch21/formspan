import { Children, cloneElement, isValidElement } from 'react';
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

/**
 * Digits, with the separators that belong inside a figure.
 *
 * The colon is in here for the same reason the comma is: `2:39` is ONE
 * quantity. Without it a session clock rendered `2` and `39` at full size
 * either side of a muted 14pt `:`, which is worse than the problem this
 * component was brought in to fix — and `1:23:45` did it twice.
 */
const FIGURES = /([\d]+(?:[.,:][\d]+)*)/;

/**
 * How much to shrink a figure so it still fits its column.
 *
 * Three stats share a row, so each gets about a third of the screen. Most
 * figures are short ("3", "1h 41m") and want the full size; a few are not, and
 * the long ones arrive precisely when the span is widest — a year of training
 * is "312h" or "251.1t", and pounds run an order of magnitude longer again at
 * "553.7k lb". At size 26 that overflowed into the neighbouring stat.
 *
 * A ladder rather than `adjustsFontSizeToFit`: that prop measures after layout
 * and is unreliable across nested `Text` runs, which is exactly what this
 * component renders (figures at one size, units at another). Deriving the size
 * from the string length is deterministic, identical on both platforms, and
 * cannot disagree with itself between the two runs.
 *
 * Counted in characters rather than measured, so it is approximate by design —
 * it errs toward shrinking slightly early, which costs nothing, rather than
 * late, which clips.
 *
 * **Opt-in, via `fit`.** `StatValue` renders on six screens, most of which give
 * a figure as much room as it wants; applied to all of them, "100kg" and
 * "102.5kg" came out at two different sizes in adjacent rows of the same card.
 * The ladder belongs where the column is fixed and narrow.
 */
function fitSize(value: string, base: number, slots: number): number {
  const n = value.length;
  // A quarter-width column has roughly 60pt of content to play with against a
  // third's ~90pt, so the same string needs to come down another rung. Measured
  // against the values that actually occur: `1:23:45`, `251.1t` and `12,450lb`
  // all overflowed a quarter at the three-column ladder.
  const tight = slots >= 4 ? 1 : 0;
  const rungs = [base, Math.round(base * 0.85), Math.round(base * 0.72), Math.round(base * 0.62)];
  const rung = n <= 6 ? 0 : n <= 8 ? 1 : n <= 10 ? 2 : 3;
  return rungs[Math.min(rung + tight, rungs.length - 1)];
}

export function StatValue({
  value,
  size: requested = 26,
  color = vola.text,
  fit = false,
  slots = 3,
}: {
  value: string;
  size?: number;
  color?: string;
  /** Shrink long figures to fit a fixed narrow column. See `fitSize`. */
  fit?: boolean;
  /** How many stats share the row. Four columns are ~a third narrower. */
  slots?: number;
}) {
  const size = fit ? fitSize(value, requested, slots) : requested;
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
  fit,
  slots,
}: {
  label: string;
  value: string;
  change?: number | null;
  size?: number;
  fit?: boolean;
  slots?: number;
}) {
  const rounded = change == null ? null : Math.round(change);
  // Grouped, or VoiceOver reads the figure and its label as two unrelated
  // stops with nothing connecting them.
  return (
    <RNView style={styles.stat} accessible accessibilityLabel={`${value} ${label}`}>
      <StatValue value={value} size={size} fit={fit} slots={slots} />
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
  // `React.Children.toArray` rather than `Array.isArray`: a SINGLE conditional
  // child (`{cond && <Stat/>}`) is not an array, so the old form rendered one
  // empty slot when the condition was false.
  const items = Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.row} testID={testID}>
      {items.map((child, i) => (
        <RNView key={i} style={[styles.slot, items.length >= 4 && styles.slotTight]}>
          {i > 0 && <RNView style={styles.divider} />}
          {isValidElement<{ slots?: number }>(child)
            ? cloneElement(child, { slots: items.length })
            : child}
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
  // Four columns need the 12pt back that padding was taking.
  slotTight: { paddingHorizontal: 8 },
  divider: {
    position: 'absolute',
    left: 0,
    top: 2,
    bottom: 2,
    width: StyleSheet.hairlineWidth,
    backgroundColor: vola.line,
  },
});
