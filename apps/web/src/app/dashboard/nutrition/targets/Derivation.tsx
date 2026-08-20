"use client";

import type { Basis, Projection } from "@/lib/nutritionApi";
import { formatWeight, type UnitSystem } from "@/lib/units";

/**
 * The arithmetic behind a target, line by line.
 *
 * **The number alone is not the deliverable.** A target an athlete cannot
 * interrogate is a verdict, and the project's standing principle is auditable
 * recommendations — a number you can argue with beats one you must trust. So
 * every row below is one step of `nutrition.Suggest`, in the order it happens,
 * with the inputs that fed it: an athlete who thinks 2,080 is too low can see
 * whether it is the resting estimate, the activity factor, a thin training
 * window, or the phase rate they actually disagree with.
 *
 * It renders a FROZEN basis, never a recomputed one. The server stores the
 * arithmetic on the target row at the moment it was accepted, precisely so
 * that "why am I eating 2,080" answers with the numbers that produced it
 * rather than with today's weight and today's phase — those have moved, and an
 * explanation that moves with them is a confident lie about a past decision.
 */

const PHASE_LABEL: Record<string, string> = {
  cut: "Cut",
  lean_bulk: "Lean bulk",
  recomposition: "Recomposition",
  maintenance: "Maintenance",
  making_weight: "Making weight",
};

const ACTIVITY_LABEL: Record<string, string> = {
  sedentary: "Sedentary",
  light: "Lightly active",
  active: "Active",
};

export function Derivation({
  basis,
  kcal,
  proteinG,
  carbG,
  fatG,
  fibreG,
  units,
}: {
  basis: Basis;
  kcal: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  fibreG: number | null;
  units: UnitSystem;
}) {
  const rows: { label: string; detail: string; value: string; total?: boolean }[] = [
    {
      label: "Resting metabolic rate",
      detail: `Mifflin–St Jeor, from ${formatWeight(basis.weight_kg, units)} measured on ${basis.weight_measured_on}`,
      value: `${basis.rmr_kcal} kcal`,
    },
    {
      label: "Daily movement",
      detail: `${ACTIVITY_LABEL[basis.activity] ?? basis.activity} — resting × ${basis.activity_factor}`,
      value: `+ ${basis.neat_kcal} kcal`,
    },
    {
      label: "Training",
      detail:
        basis.training_sessions > 0
          ? // The window is shown because a thin history is the difference
            // between a real average and a flattering one, and it is invisible
            // in the resulting number.
            `${basis.training_sessions} ${basis.training_sessions === 1 ? "session" : "sessions"} over ${basis.training_days_covered} days, spread evenly`
          : `no sessions in the last ${basis.training_days_covered} days`,
      value: `+ ${basis.training_kcal_per_day} kcal`,
    },
    {
      label: "Maintenance",
      detail: "What you burn on an average day",
      value: `${basis.tdee_kcal} kcal`,
      total: true,
    },
    {
      label: PHASE_LABEL[basis.phase_kind] ?? basis.phase_kind,
      detail: `${signedPct(basis.target_rate_pct_per_week)} of bodyweight per week — ${signedKg(basis.target_rate_kg_per_week, units)} per week, at ${basis.kcal_per_kg} kcal per kg`,
      value: `${basis.energy_delta_kcal >= 0 ? "+" : "−"} ${Math.abs(basis.energy_delta_kcal)} kcal`,
    },
    {
      label: "Target",
      detail: "What to eat, per day",
      value: `${kcal} kcal`,
      total: true,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col">
        {rows.map((r) => (
          <div
            key={r.label}
            className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 ${
              r.total ? "border-t border-line font-semibold" : ""
            }`}
          >
            {/* The detail lives INSIDE the <dt>. A <p> between <dt> and <dd>
                is invalid content for a <dl>'s wrapper div, and a screen
                reader may detach the explanation from the term it explains —
                which on this component is the explanation's whole job. */}
            <dt className="min-w-0 text-sm">
              {r.label}
              <span className="block text-[0.6875rem] font-normal text-text-dim">
                {r.detail}
              </span>
            </dt>
            <dd className="shrink-0 font-display text-base tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>

      {basis.clamped && (
        // A clamp is not a footnote. Without it the last line of the
        // arithmetic does not follow from the line above, and an athlete
        // checking the sums would conclude the app cannot add up.
        // `text-text`, NOT `text-warn`. Light-mode `--c-warn` (#b06a00) on a
        // 10% wash of its own hue is around 4.2:1 at this size — under AA, the
        // same pairing problem `--c-lime-ink` was minted for. There is no
        // `--c-warn-ink` token, and adding one to the shared palette for one
        // callout is a wider change than this branch should make; the border
        // and ground carry the warning colour, the words stay readable.
        <p className="rounded-control border border-warn/40 bg-warn/10 p-2 text-xs text-text">
          Held back: {basis.clamp_reason}. The arithmetic above asked for more
          than that, and this is where it stopped.
        </p>
      )}

      <div className="border-t border-line pt-3">
        <p className="eyebrow">Macros</p>
        <ul className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <li>
            Protein <strong className="tabular-nums">{proteinG} g</strong>
            <span className="text-text-dim"> · {basis.protein_g_per_kg} g/kg</span>
          </li>
          <li>
            Fat <strong className="tabular-nums">{fatG} g</strong>
            <span className="text-text-dim"> · {basis.fat_g_per_kg} g/kg</span>
          </li>
          <li>
            Carbs <strong className="tabular-nums">{carbG} g</strong>
            <span className="text-text-dim"> · what is left</span>
          </li>
          {fibreG != null && (
            <li>
              Fibre <strong className="tabular-nums">{fibreG} g</strong>
              <span className="text-text-dim"> · advisory</span>
            </li>
          )}
        </ul>
        {basis.relaxed && (
          <p className="mt-2 text-xs text-text-muted">
            {/* Protein and fat both have floors, and on a small target for a
                large athlete they can conflict. Saying which one gave way is
                the difference between a considered split and an arbitrary one. */}
            Adjusted to fit: {basis.relaxed}
          </p>
        )}
      </div>

      <Feasibility p={basis.projection} />
    </div>
  );
}

/**
 * "Does this look right?" — `nutrition-design.md` §5's third section, and the
 * one nothing had built on either platform.
 *
 * A phase carries a goal weight, a deadline and a rate, and nothing compared
 * them: an athlete could set "lose eight kilos by Christmas", be handed a
 * perfectly safe rate that arrives in April, and find out in April. §5's own
 * words — it "catches an impossible goal before six weeks of failing at it".
 *
 * **Renders nothing when there is nothing to say.** `projection` is null with
 * no goal weight or no live phase, and an all-clear there would assert a check
 * that never ran.
 *
 * The arithmetic is the server's, so this and the phone cannot disagree about
 * whether a plan works — the same reason `offered_grips` is served rather than
 * reimplemented (N16).
 */
function Feasibility({ p }: { p: Projection | null }) {
  if (!p) return null;

  if (p.already) {
    return (
      <p className="mt-4 text-sm text-text-muted" data-testid="target-feasibility">
        Already at {p.target_weight_kg} kg — this phase has done its job.
      </p>
    );
  }
  if (p.unreachable) {
    return (
      <p className="mt-4 text-sm text-danger-ink" data-testid="target-feasibility">
        This plan never reaches {p.target_weight_kg} kg — {p.unreachable_reason}. Change the goal
        weight or the phase.
      </p>
    );
  }

  const late = p.meets_deadline === false;
  return (
    <p
      className={`mt-4 text-sm ${late ? "text-danger-ink" : "text-text-muted"}`}
      data-testid="target-feasibility"
    >
      {p.kg_to_go} kg to go. At this rate you reach {p.target_weight_kg} kg around{" "}
      <strong className="tabular-nums">{p.reached_on}</strong>
      {p.meets_deadline === null
        ? "."
        : late
          ? ` — ${p.days_late} days after your ${p.deadline_on} deadline, about ${p.shortfall_kg} kg short on the day.`
          : `, ahead of your ${p.deadline_on} deadline.`}
    </p>
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
