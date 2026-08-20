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
 * still has exactly one instance, `app/goals/trend.tsx` (reachable from a
 * check-in too, via the redirect left at `checkin/trend.tsx`).
 */

import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  remaining as computeRemaining,
  viewTarget,
  viewTotals,
  type EatenView,
  type TargetView,
} from '@/lib/nutrition';

export function RemainingBlock({
  eaten,
  view,
  compact = false,
  testID,
}: {
  /** Everything this device knows about what was eaten. See {@link EatenView}. */
  eaten: EatenView;
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
  const totals = viewTotals(eaten);
  const remaining = totals ? computeRemaining(totals, target) : null;

  // **The eaten line renders in EVERY target state**, which is the N54 bug.
  // It used to live only in the caption of the `set` branch, so an athlete with
  // no target saw per-meal subtotals and no day total anywhere — the number
  // they reported as "not adding up" was simply never drawn. What you ate does
  // not depend on whether you have a goal, so nothing about it belongs inside
  // the has-a-goal branch.
  const eatenText =
    eaten.state === 'loading'
      ? 'Loading your day…'
      : eaten.state === 'unavailable'
        ? // NOT "0 eaten". A read that failed is not a day nobody ate on, and
          // an empty list means both — the exact misreading N28's reviewer
          // found rendering forty-two "Nothing logged" rows under an error.
          'Could not read today’s food from this device'
        : eaten.rows.length === 0
          ? 'nothing logged yet'
          : // Labelled with how many entries it came from — N28's honesty rule,
            // which applies to a total exactly as it applies to an average.
            `${fmt(eaten.totals.kcal)} eaten · ${eaten.rows.length} ${eaten.rows.length === 1 ? 'entry' : 'entries'}`;

  // The target's own four states stay exactly as they were. "Could not check"
  // and "you have no target" are the pair that matters: asserting "set a
  // target" at somebody who set one on web, because this phone happens to be
  // in a basement, is the app being wrong rather than uninformed.
  const targetText =
    view.state === 'checking'
      ? 'Checking your target…'
      : view.state === 'unknown'
        ? 'Cannot check your target from here — logging still works'
        : view.state === 'none'
          ? 'Set a target to see what is left'
          : `${fmt(view.target.kcal)} target`;

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

      {/* Two lines, not one. They answer different questions and they fail
          independently: the food read is local and the target read is a
          network call, so a basement can break one while the other is fine.
          Merging them into a single sentence is what let the eaten figure
          disappear whenever the target was missing. */}
      <Text style={styles.caption} testID="fuel-eaten">
        {eatenText}
      </Text>
      <Text style={styles.caption} testID="fuel-target">
        {targetText}
      </Text>

      {target && totals ? (
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
  caption: { fontSize: 12, color: vola.textMuted, marginTop: 6 },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: vola.surfaceRaised,
    marginTop: 10,
    overflow: 'hidden',
  },
  fill: { height: 4, borderRadius: 2 },
});
