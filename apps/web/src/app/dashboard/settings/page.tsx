"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { setModules } from "@/lib/api";
import { useModules } from "@/lib/ModulesProvider";
import { UNIT_SYSTEMS } from "@/lib/units";
import { useUnits } from "@/lib/useUnits";
import { BjjRankSection } from "./BjjRankSection";

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
  const { getToken } = useAuth();
  const { modules, apply } = useModules();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: string, next: boolean) {
    setSaving(key);
    setError(null);
    try {
      // PATCH returns the merged set, so the sidebar re-gates from the same
      // response — no follow-up GET and no reload.
      apply(await setModules(getToken, { [key]: next }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <header>
        <p className="eyebrow">Account</p>
        <h1 className="font-display text-4xl font-bold">Settings</h1>
      </header>

      {/* Disciplines first: they decide what the rest of the app even offers,
          and until now they could only be changed on the phone. Turn BJJ off
          there and the desk had no way to turn it back on — while still
          showing BJJ everywhere, because web ignored the toggles entirely. */}
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">What you train</h2>
        <div className="flex flex-col gap-2">
          {modules.map((m) => {
            const on = m.enabled;
            return (
              <button
                key={m.key}
                type="button"
                role="switch"
                aria-checked={on}
                // No aria-label: it would REPLACE the button's content as the
                // accessible name, dropping the description line below.
                //
                // aria-disabled, not `disabled`: a real disabled attribute on
                // the button you just pressed drops keyboard focus to <body>
                // after every toggle. aria-busy says what is happening.
                aria-disabled={saving !== null}
                aria-busy={saving === m.key}
                onClick={() => saving === null && toggle(m.key, !on)}
                className={`flex items-center gap-4 rounded-card border px-5 py-4 text-left transition aria-disabled:opacity-60 ${
                  on
                    ? "border-lime bg-surface-raised"
                    : "border-line bg-surface hover:bg-surface-raised"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{m.label}</span>
                  <span className="block text-sm text-text-muted">
                    {describe(m.key, m.capabilities.catalog, m.is_sport)}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={`h-6 w-10 shrink-0 rounded-pill border transition ${
                    on
                      ? "border-lime bg-lime/30"
                      : "border-line bg-surface-hover"
                  }`}
                >
                  <span
                    className={`block h-5 w-5 rounded-pill transition ${
                      on ? "ml-4 bg-lime" : "ml-0 bg-text-dim"
                    }`}
                  />
                </span>
              </button>
            );
          })}
          {modules.length === 0 && (
            <p className="text-sm text-text-muted">
              Couldn&apos;t load your disciplines just now. Your other settings
              still save.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <p className="text-sm text-text-dim">
          Turning one off hides its content, filters and shortcuts across the
          app — on this device and your phone. Nothing you&apos;ve logged is
          deleted, and turning it back on brings everything with it.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Units</h2>
        <div
          role="radiogroup"
          aria-label="Unit system"
          className="flex flex-col gap-2"
        >
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
                  <span className="block text-sm text-text-muted">
                    {u.detail}
                  </span>
                </span>
                {selected && (
                  <span className="text-lg font-bold text-lime">✓</span>
                )}
              </button>
            );
          })}
        </div>
        <p className="text-sm text-text-dim">
          Your training is always stored in kilograms and metres — this only
          changes how weights and distances are shown and entered. Switching it
          never rewrites anything you&apos;ve logged.
        </p>
      </section>

      {/* A belt is meaningless to someone who doesn't train BJJ — gated on the
          module the same way the sidebar gates Records and Library, rather
          than on a history existing, so turning BJJ off hides this even for
          an account with a recorded history. */}
      {modules.some((m) => m.key === "bjj" && m.enabled) && <BjjRankSection />}
    </div>
  );
}

/** One honest line per module — what turning it on actually gets you. */
function describe(key: string, catalog: string, isSport: boolean): string {
  if (!isSport) return "Tracked separately from training";
  if (catalog === "techniques")
    return "Technique library, positions and IBJJF legality";
  if (key === "running") return "Distance and time work in the catalog";
  return "Exercise catalog, templates and progression";
}
