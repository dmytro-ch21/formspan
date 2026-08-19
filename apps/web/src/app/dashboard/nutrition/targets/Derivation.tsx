"use client";

import type { Basis } from "@/lib/nutritionApi";
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
            <div className="min-w-0">
              <dt className="text-sm">{r.label}</dt>
              <p className="text-[0.6875rem] font-normal text-text-dim">{r.detail}</p>
            </div>
            <dd className="shrink-0 font-display text-base tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>

      {basis.clamped && (
        // A clamp is not a footnote. Without it the last line of the
        // arithmetic does not follow from the line above, and an athlete
        // checking the sums would conclude the app cannot add up.
        <p className="rounded-control border border-warn/40 bg-warn/10 p-2 text-xs text-warn">
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
