import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  girthsDue,
  judgeRate,
  makingWeightPlan,
  trendWeight,
  weeklyRate,
  type Phase,
  type RateVerdict,
} from '@/lib/anthropometry';
import { PHASE_LABELS, type Checkin } from '@/lib/body';
import { formatWeight, type UnitSystem } from '@/lib/units';

/**
 * The Today screen's check-in card.
 *
 * **A decision surface, not a report.** It answers one question — is what I am
 * doing working, and do I need to do anything right now — and everything it
 * shows is in service of that. The history and the charts live on web, which is
 * the analytical surface by the platform rule.
 *
 * ## Why it shows a trend and not this morning's number
 *
 * Body mass swings 1–2kg inside a day on water, glycogen and last night's meal,
 * so a single reading is mostly noise: two consecutive mornings can differ by
 * more than a good *week* of fat loss. The big number here is a seven-day
 * rolling mean, and the rate under it runs between two of those a fortnight
 * apart. See `lib/anthropometry.ts` — the arithmetic is there and tested.
 *
 * Until there are enough readings the card says so rather than dressing one
 * morning up as a trend.
 *
 * ## Colour
 *
 * Everything is `accent` or a neutral. **A verdict is never carried by hue
 * alone** — "too fast" reads as a word, not as red — which is what makes the
 * card work identically on the monochrome theme, and for anyone who does not
 * separate red from green.
 */

/** What the card says about a rate, in the phase's own terms. */
function verdictCopy(kind: Phase['kind'], v: RateVerdict, wrongWay: boolean): string {
  if (v === 'unknown') return 'Not enough readings yet';
  if (v === 'no_target') return '';
  if (v === 'on_target') return 'On track';
  if (kind === 'cut') {
    if (v === 'too_fast') return 'Faster than ideal — muscle is at risk';
    // `judgeRate` folds wrong-direction into `too_slow`, but "slower than
    // planned" is the wrong sentence for weight going UP — which is the exact
    // failure this card exists to catch. Raised in review.
    return wrongWay ? 'Going the wrong way' : 'Slower than planned';
  }
  if (kind === 'lean_bulk') {
    if (v === 'too_fast') return 'Faster than ideal — mostly fat above this';
    return wrongWay ? 'Going the wrong way' : 'Slower than planned';
  }
  // Recomp and maintenance both want flat, so either direction is drift.
  return 'Drifting — weight should be holding';
}

export function CheckinCard({
  checkins,
  phase,
  today,
  units,
  loaded,
  unitsReady,
  testID,
}: {
  checkins: Checkin[];
  phase: Phase | null;
  today: string;
  units: UnitSystem;
  /** False until the fetch has settled — see the empty-state copy below. */
  loaded: boolean;
  /** False until the athlete's unit system is known; see `UnitsProvider`. */
  unitsReady: boolean;
  testID?: string;
}) {
  const accent = useAccent();
  const router = useRouter();

  const loggedToday = checkins.some((c) => c.measured_on === today && c.weight_kg != null);
  const trend = trendWeight(checkins, today);
  const rate = weeklyRate(checkins, today, 14);
  const dueGirths = girthsDue(checkins, today);

  const verdict: RateVerdict = phase ? judgeRate(phase.kind, rate) : 'no_target';
  // Weight moving against the phase's intent, as opposed to merely moving
  // slowly. Both land on `too_slow`; only one of them is alarming.
  const wrongWay =
    rate != null &&
    ((phase?.kind === 'cut' && rate > 0) || (phase?.kind === 'lean_bulk' && rate < 0));
  const plan =
    phase?.kind === 'making_weight' ? makingWeightPlan(trend, phase, today) : null;

  return (
    <View style={styles.card} testID={testID ?? 'checkin-card'}>
      <RNView style={styles.head}>
        <RNView style={[styles.dot, { backgroundColor: accent.accent }]} />
        <Text style={[styles.eyebrow, { color: accent.ink }]}>
          {phase ? PHASE_LABELS[phase.kind].label.toUpperCase() : 'CHECK IN'}
        </Text>
        {loggedToday && (
          <RNView style={styles.doneRow}>
            <Icon name="check" size={12} color={vola.textMuted} strokeWidth={2.4} />
            <Text style={styles.doneText}>Today</Text>
          </RNView>
        )}
      </RNView>

      {/*
        The trend, not the morning. `trend == null` is a real state and says so
        — a zero here would be the one number that is certainly wrong.
      */}
      {trend != null && unitsReady ? (
        <Text style={styles.big} testID="checkin-trend">
          {formatWeight(trend, units)}
        </Text>
      ) : (
        <Text style={styles.bigMuted} testID="checkin-trend-empty">
          —
        </Text>
      )}
      <Text style={styles.caption}>
        {/*
          "Could not load" and "you have not weighed in" are different
          sentences, and asserting the second while offline is a false claim
          about somebody with a month of data. Raised in review.
        */}
        {trend != null
          ? '7-day trend'
          : loaded
            ? 'Weigh in for a few days to see a trend'
            : 'Checking…'}
      </Text>

      {/* The rate, and what it means in the phase's terms. */}
      {phase && verdict !== 'no_target' && (
        <Text style={styles.verdict} testID="checkin-verdict">
          {rate != null ? `${formatRate(rate)} · ` : ''}
          {verdictCopy(phase.kind, verdict, wrongWay)}
        </Text>
      )}

      {/* Making weight has a deadline, so it gets a countdown instead. */}
      {plan && (
        <Text style={styles.verdict} testID="checkin-making-weight">
          {plan.made
            ? 'On weight'
            : plan.daysLeft <= 0
              ? `${formatWeight(plan.kilosToGo, units)} over, and the date has passed`
              : `${formatWeight(plan.kilosToGo, units)} in ${plan.daysLeft} days${
                  plan.safe ? '' : ' — faster than is safe'
                }`}
        </Text>
      )}

      <RNView style={styles.actions}>
        <Pressable
          onPress={() => router.push(`/checkin/${today}`)}
          style={[styles.primary, { backgroundColor: accent.accent }]}
          accessibilityRole="button"
          accessibilityLabel={loggedToday ? 'Edit today’s check-in' : 'Check in for today'}
          testID="checkin-open"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>
            {loggedToday ? 'Edit check-in' : 'Check in'}
          </Text>
        </Pressable>
        {/* Surfaced only when it is actually due — a permanent "measure
            yourself" prompt is the thing people learn to ignore. */}
        {dueGirths && (
          <Text style={styles.due} testID="checkin-girths-due">
            Measurements due
          </Text>
        )}
      </RNView>
    </View>
  );
}

/** A weekly rate as a percentage, signed, at the precision it actually has. */
function formatRate(rate: number): string {
  const pct = rate * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%/wk`;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 18,
    backgroundColor: vola.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginHorizontal: 16,
    marginBottom: 14,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.4, flex: 1 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  doneText: { fontSize: 11, color: vola.textMuted, fontWeight: '600' },

  // Tabular figures so the number does not shuffle as it changes.
  big: { fontSize: 34, fontWeight: '800', fontVariant: ['tabular-nums'], marginTop: 8 },
  bigMuted: { fontSize: 34, fontWeight: '800', color: vola.textDim, marginTop: 8 },
  caption: { fontSize: 12, color: vola.textMuted, marginTop: 1 },
  verdict: { fontSize: 13, color: vola.textMuted, marginTop: 8, lineHeight: 18 },

  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  primary: {
    minHeight: 42,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontWeight: '700', fontSize: 14 },
  due: { fontSize: 12, color: vola.textMuted, flex: 1 },
});
