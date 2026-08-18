/**
 * Remaining calories and remaining protein.
 *
 * SHARED by the Today card and the day screen, deliberately. Two copies of
 * "remaining" is the drift this repo keeps paying for — and here the two
 * surfaces would disagree about the single number the whole feature exists to
 * show.
 *
 * ## Remaining, never consumed
 *
 * A consumed figure is a report. A remaining figure is what changes what you
 * order at dinner, and `docs/decisions/today-view-design.md` §2.4 calls
 * protein-left-today probably the single most behaviour-changing number on the
 * screen. "Eaten" appears once, muted, as context.
 *
 * ## This bar is NOT a chart
 *
 * No time axis, no history, one quantity against one target. It is a progress
 * indicator, and it must not be cited as precedent for the N5 carve-out — that
 * still has exactly one instance, `checkin/trend.tsx`.
 */

import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { remaining as computeRemaining, viewTarget, type Macros, type TargetView } from '@/lib/nutrition';

export function RemainingBlock({
  totals,
  view,
  compact = false,
  testID,
}: {
  totals: Macros;
  /** Everything this device knows about the target. See {@link TargetView}. */
  view: TargetView;
  /** The card is compact; the day screen is not. */
  compact?: boolean;
  testID?: string;
}) {
  const accent = useAccent();

  // `remaining` is DERIVED here rather than passed in. Two surfaces sharing
  // this component but each computing the figure themselves is the same drift
  // the component exists to prevent, one level down.
  const target = viewTarget(view);
  const remaining = computeRemaining(totals, target);

  // Four states, deliberately distinguished. "Could not check", "you have no
  // target", "you have not logged anything" and the ordinary line are four
  // different sentences, and the first two are the pair that matters: asserting
  // "set a target" at somebody who set one on web, because this phone happens
  // to be in a basement, is the app being wrong rather than uninformed.
  const caption =
    view.state === 'checking'
      ? 'Checking…'
      : view.state === 'unknown'
        ? 'Cannot check your target from here — logging still works'
        : view.state === 'none'
          ? 'Set a target to see what is left'
          : totals.kcal === 0
            ? 'nothing logged yet'
            : `${fmt(view.target.kcal)} target · ${fmt(totals.kcal)} eaten`;

  const kcalText = remaining ? fmt(Math.abs(remaining.kcal)) : '—';
  const proteinText = remaining ? `${fmt(Math.abs(remaining.protein_g))} g` : '—';

  return (
    <View testID={testID}>
      <View style={styles.figures}>
        <Figure
          value={kcalText}
          unit={remaining?.over ? 'kcal over' : 'kcal left'}
          muted={!remaining}
          size={compact ? 30 : 34}
          testID="fuel-remaining-kcal"
        />
        <Figure
          value={proteinText}
          unit={remaining && remaining.protein_g < 0 ? 'protein over' : 'protein left'}
          muted={!remaining}
          size={compact ? 30 : 34}
          testID="fuel-remaining-protein"
        />
      </View>

      <Text style={styles.caption}>{caption}</Text>

      {target ? (
        <View
          style={styles.track}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`${fmt(totals.kcal)} of ${fmt(target.kcal)} calories`}
        >
          <View
            style={[
              styles.fill,
              {
                // The accent fills, because this is interaction-adjacent chrome
                // rather than a reading. Over target the bar goes MUTED, never
                // `danger`: one day over is not an error state, and a state
                // colour spent here means nothing when something is wrong.
                width: `${Math.min(100, pct(totals.kcal, target.kcal))}%`,
                backgroundColor: remaining?.over ? vola.textDim : accent.accent,
              },
            ]}
          />
        </View>
      ) : null}
    </View>
  );
}

function Figure({
  value,
  unit,
  muted,
  size,
  testID,
}: {
  value: string;
  unit: string;
  muted: boolean;
  size: number;
  testID: string;
}) {
  return (
    <View style={styles.figure}>
      <Text
        style={[styles.value, { fontSize: size, color: muted ? vola.textDim : vola.text }]}
        testID={testID}
      >
        {value}
      </Text>
      <Text style={styles.unit}>{unit}</Text>
    </View>
  );
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function pct(eaten: number, target: number): number {
  if (target <= 0) return 0;
  return (eaten / target) * 100;
}

const styles = StyleSheet.create({
  // Equal weight, side by side. Protein is not subordinate to calories: the
  // design doc calls it the more behaviour-changing of the two.
  figures: { flexDirection: 'row', gap: 20 },
  figure: { flex: 1 },
  value: { fontWeight: '800', fontVariant: ['tabular-nums'] },
  unit: { fontSize: 12, color: vola.textMuted, marginTop: 1 },
  caption: { fontSize: 12, color: vola.textMuted, marginTop: 8 },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: vola.surfaceRaised,
    marginTop: 10,
    overflow: 'hidden',
  },
  fill: { height: 4, borderRadius: 2 },
});
