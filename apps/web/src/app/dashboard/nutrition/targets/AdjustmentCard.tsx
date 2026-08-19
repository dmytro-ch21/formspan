"use client";

import { useState } from "react";

import type { Adjustment, AdjustmentResponse, BlockedBy } from "@/lib/nutritionApi";
import { formatWeight, type UnitSystem } from "@/lib/units";

/**
 * The weekly target adjustment — N27's first and only client.
 *
 * The endpoint shipped with no UI deliberately, because where a proposal
 * surfaces belongs with target authoring, and this is it.
 *
 * # Three properties this screen has to preserve, or the backend's are wasted
 *
 * **It is a proposal, never an application.** Nothing here writes until the
 * athlete presses Accept. There is no auto-apply, no "we've updated your
 * target", and no countdown to one. The endpoint itself cannot write; this
 * component is what makes that visible rather than merely true.
 *
 * **The arithmetic is shown, not summarised.** "We suggest 2,180" is a verdict.
 * "You lost 0.30% a week against a target of 0.75%, which is 0.36 kg a week
 * short, which at 7,700 kcal/kg is 396 kcal a day, capped to 220" is an
 * argument, and an athlete who disagrees can point at the line they disagree
 * with. Same posture as the derivation next to it.
 *
 * **A withheld proposal is a normal answer, not an error.** For most athletes
 * on most days there is not enough evidence, and the guards ARE the feature:
 * a proposal from thin data moves how much somebody eats on the strength of a
 * number nobody recorded. So the blocked states get real estate and plain
 * language about what would unblock them — never a spinner, never a retry, and
 * never an apology.
 *
 * Declining is doing nothing. No dismissal is stored, because a stored one
 * would be stale the moment the next weigh-in landed, and the 14-day cooldown
 * is already derivable from target history.
 */

const BLOCKED: Record<BlockedBy, { title: string; detail: string }> = {
  no_target: {
    title: "No target to adjust",
    detail:
      "Set one below first. The weekly check compares what actually happened against a decision you made — with no target there is nothing to compare against.",
  },
  no_phase: {
    title: "No phase is running",
    detail:
      "A cut, a lean bulk, maintenance or making weight. The phase is what supplies the target rate, and without one there is no gap to close. Start a phase from the phone's check-in screen.",
  },
  too_soon: {
    title: "This target is too new",
    detail:
      "A target needs 14 days before it is judged. The first week after a change measures the water shift the change caused, not the change itself — adjusting on it would chase your own adjustment.",
  },
  not_logging: {
    title: "Not enough days logged",
    detail:
      "At least 10 of the last 14 days need real intake on them. Below that the trend is measuring how often you logged, not how much you ate, and the proposal would be arithmetic on a gap.",
  },
  not_weighing: {
    title: "Not enough weigh-ins",
    detail:
      "Four in each of the last two weeks, not seven bunched in one. The rule compares the two halves against each other, so readings clustered at one end say nothing about the change between them.",
  },
  on_track: {
    title: "On track",
    detail:
      "Your observed rate is within 0.25% of bodyweight per week of the target rate. That is roughly the noise floor of a 7-day trend, so the honest answer is that nothing is distinguishable — not that you should eat differently.",
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
  const [open, setOpen] = useState(true);
  const { adjustment, blocked_by } = response;

  if (!adjustment) {
    return (
      <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
        <h2 className="eyebrow">Weekly check</h2>
        {blocked_by.length === 0 ? (
          <p className="text-sm text-text-muted">No change proposed this week.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {blocked_by.map((b) => (
              <li key={b}>
                <p className="text-sm font-semibold">{BLOCKED[b]?.title ?? b}</p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {BLOCKED[b]?.detail ??
                    "Something the weekly check needs is missing."}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  const b = adjustment.basis;
  const up = adjustment.delta_kcal > 0;

  return (
    <section className="flex flex-col gap-4 rounded-card border border-lime bg-lime/5 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="eyebrow">Weekly check — a proposal</h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-xs font-semibold text-text-muted underline underline-offset-4 hover:text-text"
        >
          {open ? "Hide the arithmetic" : "Show the arithmetic"}
        </button>
      </div>

      <p className="text-lg">
        Eat{" "}
        <strong className="font-display tabular-nums">
          {adjustment.to_kcal} kcal
        </strong>{" "}
        from {adjustment.effective_on} —{" "}
        <span className="tabular-nums">
          {up ? "+" : "−"}
          {Math.abs(adjustment.delta_kcal)}
        </span>{" "}
        on the {adjustment.from_kcal} you are eating now.
      </p>

      {open && b && (
        <dl className="flex flex-col rounded-control border border-line bg-surface p-3">
          <Row
            label="Your trend weight now"
            detail={`mean of ${b.weighins_recent_half} weigh-ins over the last 7 days`}
            value={formatWeight(b.trend_weight_kg, units)}
          />
          <Row
            label="A week earlier"
            detail={`mean of ${b.weighins_earlier_half} weigh-ins over the 7 days before that`}
            value={formatWeight(b.earlier_trend_weight_kg, units)}
          />
          <Row
            label="So you changed"
            detail={`${signedPct(b.observed_pct_per_week)} of bodyweight per week`}
            value={`${signedKg(b.observed_kg_per_week, units)} / week`}
            total
          />
          <Row
            label="Your phase asks for"
            detail={`${signedPct(b.target_pct_per_week)} of bodyweight per week`}
            value={`${signedKg(b.target_kg_per_week, units)} / week`}
          />
          <Row
            label="The gap"
            detail={`× ${b.kcal_per_kg} kcal per kg ÷ 7 days`}
            value={`${signedKg(b.observed_kg_per_week - b.target_kg_per_week, units)} / week`}
          />
          <Row
            label="Which asks for"
            detail={
              b.capped
                ? // The raw figure is shown BECAUSE it was capped. Hiding it
                  // would make the final number look like the arithmetic's
                  // answer when it is deliberately not.
                  `capped — ${b.cap_reason}`
                : "one day's worth of the gap"
            }
            value={`${b.raw_delta_kcal >= 0 ? "+" : "−"}${Math.abs(b.raw_delta_kcal)} kcal`}
          />
          <Row
            label="Proposed change"
            detail={`${adjustment.from_kcal} → ${adjustment.to_kcal} kcal, from ${adjustment.effective_on}`}
            value={`${up ? "+" : "−"}${Math.abs(adjustment.delta_kcal)} kcal`}
            total
          />
          <div className="mt-3 border-t border-line pt-2 text-[0.6875rem] text-text-dim">
            {/* Rule 2 again, on the evidence rather than on an average: the
                proposal is only as good as the fortnight behind it, and the
                fortnight is not visible in the number. */}
            Based on {b.days_logged} of {b.days_considered} days logged, and{" "}
            {b.days_on_current_target} days on your current target.
          </div>
          <div className="mt-2 text-[0.6875rem] text-text-dim">
            New macros: {adjustment.protein_g} g protein · {adjustment.fat_g} g fat ·{" "}
            {adjustment.carb_g} g carbs · {adjustment.fibre_g} g fibre
            {b.relaxed ? ` — adjusted to fit: ${b.relaxed}` : ""}
          </div>
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => onAccept(adjustment)}
          disabled={accepting}
          className="rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-accent-on-fill disabled:opacity-60"
        >
          {accepting ? "Saving…" : `Accept — eat ${adjustment.to_kcal} from ${adjustment.effective_on}`}
        </button>
        {/* NOT a button. Declining is doing nothing, and a Decline control
            would imply something is recorded when you press it. Nothing is:
            the proposal simply is not there next time the evidence changes. */}
        <p className="text-xs text-text-dim">
          Nothing changes until you accept. Ignoring this stores nothing — the
          check runs again from your rows.
        </p>
      </div>
    </section>
  );
}

function Row({
  label,
  detail,
  value,
  total,
}: {
  label: string;
  detail: string;
  value: string;
  total?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-baseline justify-between gap-x-4 py-1.5 ${
        total ? "border-t border-line font-semibold" : ""
      }`}
    >
      <div className="min-w-0">
        <dt className="text-sm">{label}</dt>
        <p className="text-[0.6875rem] font-normal text-text-dim">{detail}</p>
      </div>
      <dd className="shrink-0 font-display text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function signedPct(fraction: number): string {
  const pct = fraction * 100;
  if (Math.abs(pct) < 0.005) return "0%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`;
}

function signedKg(kg: number, units: UnitSystem): string {
  if (Math.abs(kg) < 0.005) return formatWeight(0, units);
  return `${kg > 0 ? "+" : "−"}${formatWeight(Math.abs(kg), units)}`;
}
