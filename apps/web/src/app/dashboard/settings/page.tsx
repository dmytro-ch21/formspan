"use client";

import { UNIT_SYSTEMS } from "@/lib/units";
import { useUnits } from "@/lib/useUnits";

/**
 * Settings.
 *
 * Units are stored on the profile, not per browser, so the choice made here
 * is the one the phone uses too. Changing it can never alter a recorded
 * number — training data is stored in kilograms and metres regardless — and
 * the page says so, because a units toggle is exactly the control people
 * expect to rewrite their history.
 */
export default function SettingsPage() {
  const { units, setUnits } = useUnits();

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <header>
        <p className="eyebrow">Account</p>
        <h1 className="font-display text-4xl font-bold">Settings</h1>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Units</h2>
        <div role="radiogroup" aria-label="Unit system" className="flex flex-col gap-2">
          {UNIT_SYSTEMS.map((u) => {
            const selected = units === u.key;
            return (
              <button
                key={u.key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setUnits(u.key)}
                className={`flex items-center gap-4 rounded-card border px-5 py-4 text-left transition ${
                  selected
                    ? "border-lime bg-surface-raised"
                    : "border-line bg-surface hover:bg-surface-raised"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{u.label}</span>
                  <span className="block text-sm text-text-muted">{u.detail}</span>
                </span>
                {selected && <span className="text-lg font-bold text-lime">✓</span>}
              </button>
            );
          })}
        </div>
        <p className="text-sm text-text-dim">
          Your training is always stored in kilograms and metres — this only changes how weights
          and distances are shown and entered. Switching it never rewrites anything you&apos;ve
          logged.
        </p>
      </section>
    </div>
  );
}
