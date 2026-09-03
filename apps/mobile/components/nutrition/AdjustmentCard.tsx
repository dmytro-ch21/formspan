/**
 * The weekly target adjustment, on the phone — N27's second client.
 *
 * Ported from `apps/web/.../targets/AdjustmentCard.tsx` rather than reinvented,
 * because the three properties below are the whole feature and re-deriving them
 * is how a second surface quietly loses one.
 *
 * **It is a proposal, never an application.** Nothing here writes until the
 * athlete presses Accept. There is no auto-apply and no countdown to one. The
 * endpoint itself cannot write; this component is what makes that visible
 * rather than merely true.
 *
 * **The arithmetic is shown, not summarised.** "We suggest 2,180" is a verdict.
 * The ladder is an argument, and an athlete who disagrees can point at the line
 * they disagree with. Same posture as the derivation above it — and the reason
 * this belongs on a phone at all: the ladder was already legible here and the
 * proposal was not, which is the same reachable-reasoning/unreachable-action
 * split that put manual entry on this screen.
 *
 * **A withheld proposal is a normal answer, not an error.** For most athletes
 * on most days there is not enough evidence, and the guards ARE the feature: a
 * proposal from thin data moves how much somebody eats on the strength of a
 * number nobody recorded. So the blocked states get real estate and plain
 * language about what would unblock them — never a spinner, never a retry, and
 * never an apology.
 *
 * Declining is doing nothing. No dismissal is stored, because a stored one
 * would be stale the moment the next weigh-in landed.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import type { Adjustment, AdjustmentResponse, BlockedBy } from '@/lib/nutritionApi';
import { formatEnergyCoefficient, formatWeight, type UnitSystem } from '@/lib/units';

/**
 * The copy for every blocked state, carried over from web verbatim in
 * substance — one sentence naming the state, one explaining what would clear
 * it. Two surfaces explaining the same guard differently is how an athlete
 * learns to distrust both.
 *
 * The one deliberate divergence is `no_phase`: web sends you to "the phone's
 * check-in screen", which on the phone is a sentence pointing at itself.
 */
const BLOCKED: Record<BlockedBy, { title: string; detail: string }> = {
  no_target: {
    title: 'No target to adjust',
    detail:
      'Set one below first. The weekly check compares what actually happened against a decision you made — with no target there is nothing to compare against.',
  },
  no_phase: {
    title: 'No phase is running',
    detail:
      'A cut, a lean bulk, maintenance or making weight. The phase is what supplies the target rate, and without one there is no gap to close. Start one from the phase screen below.',
  },
  too_soon: {
    title: 'This target is too new',
    detail:
      'A target needs 14 days before it is judged. The first week after a change measures the water shift the change caused, not the change itself — adjusting on it would chase your own adjustment.',
  },
  not_logging: {
    title: 'Not enough days logged',
    detail:
      'At least 10 of the last 14 days need real intake on them. Below that the trend is measuring how often you logged, not how much you ate, and the proposal would be arithmetic on a gap.',
  },
  not_weighing: {
    title: 'Not enough weigh-ins',
    detail:
      'Four in each of the last two weeks, not seven bunched in one. The rule compares the two halves against each other, so readings clustered at one end say nothing about the change between them.',
  },
  on_track: {
    title: 'On track',
    detail:
      'Your observed rate is within 0.25% of bodyweight per week of the target rate. That is roughly the noise floor of a 7-day trend, so the honest answer is that nothing is distinguishable — not that you should eat differently.',
  },
};

export function AdjustmentCard({
  response,
  units,
  onAccept,
  accepting,
}: {
  response: AdjustmentResponse;
  units: UnitSystem;
  onAccept: (a: Adjustment) => void;
  accepting: boolean;
}) {
  const accent = useAccent();
  // Collapsed by default here and expanded on web, and that is a phone
  // decision rather than a disagreement: this screen already carries a
  // six-row derivation ladder, and opening a second one above it pushes the
  // thing you came for off the first screenful.
  const [open, setOpen] = useState(false);
  const { adjustment, blocked_by: blocked } = response;

  if (!adjustment) {
    return (
      <View style={styles.quiet} testID="adjustment-blocked">
        <Text style={styles.eyebrow}>Weekly check</Text>
        {blocked.length === 0 ? (
          <Text style={styles.note}>No change proposed this week.</Text>
        ) : (
          blocked.map((b) => (
            <View key={b} style={styles.blockedRow} testID={`adjustment-blocked-${b}`}>
              <Text style={styles.blockedTitle}>{BLOCKED[b]?.title ?? b}</Text>
              <Text style={styles.note}>
                {/* A server that grows a seventh reason must not render a blank
                    card. Naming the raw code is ugly and honest; silence would
                    read as "nothing to say", which is the one thing it is
                    not. */}
                {BLOCKED[b]?.detail ?? 'Something the weekly check needs is missing.'}
              </Text>
            </View>
          ))
        )}
      </View>
    );
  }

  const b = adjustment.basis;
  const up = adjustment.delta_kcal > 0;

  return (
    <View style={[styles.card, { borderColor: accent.accent }]} testID="adjustment-proposal">
      <Text style={styles.eyebrow}>Weekly check — a proposal</Text>

      <Text style={styles.lead}>
        Eat <Text style={styles.leadStrong}>{adjustment.to_kcal} kcal</Text> from{' '}
        {adjustment.effective_on} — {up ? '+' : '−'}
        {Math.abs(adjustment.delta_kcal)} on the {adjustment.from_kcal} you are eating now.
      </Text>

      {b ? (
        <Pressable
          onPress={() => setOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={open ? 'Hide the arithmetic' : 'Show the arithmetic'}
          testID="adjustment-toggle"
        >
          <Text style={[styles.link, { color: accent.ink }]}>
            {open ? 'Hide the arithmetic' : 'Show the arithmetic'}
          </Text>
        </Pressable>
      ) : null}

      {open && b ? (
        <View style={styles.ladder} testID="adjustment-arithmetic">
          <Row
            label="Your trend weight now"
            hint={`mean of ${b.weighins_recent_half} weigh-ins over the last 7 days`}
            value={formatWeight(b.trend_weight_kg, units)}
          />
          <Row
            label="A week earlier"
            hint={`mean of ${b.weighins_earlier_half} weigh-ins over the 7 days before that`}
            value={formatWeight(b.earlier_trend_weight_kg, units)}
          />
          <Row
            label="So you changed"
            hint={`${signedPct(b.observed_pct_per_week)} of bodyweight per week`}
            value={`${signedKg(b.observed_kg_per_week, units)} / week`}
            strong
          />
          <Row
            label="Your phase asks for"
            hint={`${signedPct(b.target_pct_per_week)} of bodyweight per week`}
            value={`${signedKg(b.target_kg_per_week, units)} / week`}
          />
          <Row
            label="The gap"
            hint={`× ${formatEnergyCoefficient(b.kcal_per_kg, units)} ÷ 7 days`}
            value={`${signedKg(b.observed_kg_per_week - b.target_kg_per_week, units)} / week`}
          />
          <Row
            label="Which asks for"
            // The raw figure is shown BECAUSE it was capped. Hiding it makes
            // the final number look like the arithmetic's answer when it is
            // deliberately not.
            hint={b.capped ? `capped — ${b.cap_reason}` : "one day's worth of the gap"}
            value={`${b.raw_delta_kcal >= 0 ? '+' : '−'}${Math.abs(b.raw_delta_kcal)} kcal`}
          />
          <Row
            label="Proposed change"
            hint={`${adjustment.from_kcal} → ${adjustment.to_kcal} kcal, from ${adjustment.effective_on}`}
            value={`${up ? '+' : '−'}${Math.abs(adjustment.delta_kcal)} kcal`}
            strong
          />
          <Text style={styles.footnote}>
            Based on {b.days_logged} of {b.days_considered} days logged, and{' '}
            {b.days_on_current_target} days on your current target.
          </Text>
          <Text style={styles.footnote}>
            New macros: {adjustment.protein_g} g protein · {adjustment.fat_g} g fat ·{' '}
            {adjustment.carb_g} g carbs · {adjustment.fibre_g} g fibre
            {b.relaxed ? ` — adjusted to fit: ${b.relaxed}` : ''}
          </Text>
        </View>
      ) : null}

      <Pressable
        onPress={() => onAccept(adjustment)}
        disabled={accepting}
        style={[styles.primary, { backgroundColor: accent.accent }, accepting && styles.off]}
        accessibilityRole="button"
        accessibilityState={{ disabled: accepting }}
        accessibilityLabel={`Accept — eat ${adjustment.to_kcal} kcal from ${adjustment.effective_on}`}
        testID="adjustment-accept"
      >
        <Text style={[styles.primaryText, { color: accent.on }]}>
          {accepting ? 'Saving…' : `Eat ${adjustment.to_kcal} from ${adjustment.effective_on}`}
        </Text>
      </Pressable>
      {/* NOT a button. Declining is doing nothing, and a Decline control would
          imply something is recorded when you press it. Nothing is. */}
      <Text style={styles.footnote}>
        Nothing changes until you accept. Ignoring this stores nothing — the check runs again
        from your rows.
      </Text>
    </View>
  );
}

function Row({
  label,
  hint,
  value,
  strong,
}: {
  label: string;
  hint: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowLabel, strong && styles.rowLabelStrong]}>{label}</Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong]}>{value}</Text>
    </View>
  );
}

/** A rate as a percentage, with the sign said out loud. */
export function signedPct(fraction: number): string {
  const pct = fraction * 100;
  // Below half a hundredth of a percent there is no sign worth claiming — a
  // "−0.00%" is a rounding artefact reading as a direction.
  if (Math.abs(pct) < 0.005) return '0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;
}

/** The same, for a weight, in whichever units the athlete reads. */
export function signedKg(kg: number, units: UnitSystem): string {
  if (Math.abs(kg) < 0.005) return formatWeight(0, units);
  return `${kg > 0 ? '+' : '−'}${formatWeight(Math.abs(kg), units)}`;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
    marginBottom: 4,
  },
  quiet: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    borderRadius: 14,
    padding: 14,
    gap: 10,
    marginBottom: 4,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: vola.textDim,
  },
  lead: { fontSize: 15, lineHeight: 21, color: vola.text },
  leadStrong: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  blockedRow: { gap: 2 },
  blockedTitle: { fontSize: 14, fontWeight: '700', color: vola.text },
  ladder: { gap: 2, marginTop: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
  },
  rowMain: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 13, color: vola.textMuted },
  rowLabelStrong: { color: vola.text, fontWeight: '700' },
  rowHint: { fontSize: 11, color: vola.textDim },
  rowValue: { fontSize: 13, fontVariant: ['tabular-nums'], color: vola.textMuted },
  rowValueStrong: { fontSize: 14, fontWeight: '700', color: vola.text },
  note: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  footnote: { fontSize: 11, color: vola.textDim, lineHeight: 16 },
  link: { fontSize: 13, fontWeight: '700', paddingVertical: 6 },
  primary: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
});
