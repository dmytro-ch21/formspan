"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { addDays, today } from "@/lib/history";
import {
  fetchAdjustment,
  listTargets,
  saveTarget,
  suggestedTarget,
  type Adjustment,
  type AdjustmentResponse,
  type Suggested,
  type Target,
} from "@/lib/nutritionApi";
import { useUnits } from "@/lib/useUnits";
import { AdjustmentCard } from "./AdjustmentCard";
import { Derivation } from "./Derivation";

/**
 * Setting the target, with the arithmetic that produced it.
 *
 * Three ways a target gets its number, and the screen keeps them distinct
 * because the explanation you can offer differs:
 *
 *  - **derived** — the wizard's arithmetic, shown in full before you accept it.
 *  - **adjustment** — a weekly correction from what actually happened to your
 *    weight, also shown in full. N27; see `AdjustmentCard`.
 *  - **manual** — a number you typed. It has no arithmetic and the screen says
 *    so rather than inventing one.
 *
 * A target is stored PER DATE, so setting one never rewrites the past: March's
 * days stay judged against March's target. That is why the history below is a
 * list rather than a single editable row, and why the default effective date
 * for a new derived target is today rather than backdated.
 */

/** The activity vocabulary the derivation accepts. Labels are ours; the keys
 *  come back on the `suggested` response and are validated server-side. */
const ACTIVITY: { key: string; label: string; detail: string }[] = [
  { key: "sedentary", label: "Sedentary", detail: "Desk job, little walking" },
  { key: "light", label: "Lightly active", detail: "On your feet some of the day" },
  { key: "active", label: "Active", detail: "Manual work, or a lot of walking" },
];

/** The profile fields a derivation needs, in the words the athlete would use. */
const MISSING_LABEL: Record<string, string> = {
  weight_kg: "a bodyweight check-in",
  height_cm: "your height",
  date_of_birth: "your date of birth",
  sex: "your sex",
};

export default function NutritionTargetPage() {
  const { getToken } = useAuth();
  const { units } = useUnits();
  const now = useMemo(() => today(), []);

  const [targets, setTargets] = useState<Target[]>([]);
  const [suggested, setSuggested] = useState<Suggested | null>(null);
  const [adjustment, setAdjustment] = useState<AdjustmentResponse | null>(null);
  const [activity, setActivity] = useState("light");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<null | "derived" | "manual" | "adjustment">(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const suggestRef = useRef<AbortController | null>(null);

  /**
   * The two reads that do NOT depend on the activity chip.
   *
   * Split from the suggestion deliberately. When all three shared one
   * `useCallback` keyed on `activity`, every chip click refetched a year of
   * targets and re-ran the weekly adjustment check — neither of which the chip
   * can affect — and re-gated the whole page on `Loading…` while it happened,
   * so the proposal card blinked out on a click that had nothing to do with
   * it. Found in review.
   */
  const load = useCallback(async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setLoading(true);
    setError(null);
    try {
      const [t, a] = await Promise.all([
        // A year back, so the history reads as a sequence of decisions rather
        // than as one row. The window also carries in the target live at its
        // start, which is what makes "what was I eating to last spring"
        // answerable at all.
        listTargets(getToken, { from: addDays(now, -365), to: now }, c.signal),
        fetchAdjustment(getToken, now, c.signal),
      ]);
      if (c.signal.aborted) return;
      setTargets(t);
      setAdjustment(a);
    } catch (e) {
      if (c.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Could not load your targets.");
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [getToken, now]);

  /** The derivation, which is the only thing the activity chip changes. */
  const loadSuggestion = useCallback(async () => {
    suggestRef.current?.abort();
    const c = new AbortController();
    suggestRef.current = c;
    try {
      const s = await suggestedTarget(getToken, now, activity, c.signal);
      if (!c.signal.aborted) setSuggested(s);
    } catch (e) {
      if (!c.signal.aborted) {
        setError(e instanceof Error ? e.message : "Could not derive a target.");
      }
    }
  }, [getToken, now, activity]);

  useEffect(() => {
    // The same disable every fetch-on-mount screen in this app carries: the
    // rule cannot see that `load` aborts its own previous request and bails on
    // `signal.aborted` before any setState, so the cascade it warns about is
    // one render on mount rather than a loop. Removing the fetch is not the
    // alternative — there is no data without it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSuggestion();
    return () => suggestRef.current?.abort();
  }, [loadSuggestion]);

  const live = useMemo(() => {
    let best: Target | null = null;
    for (const t of targets) {
      if (t.effective_on <= now && (!best || t.effective_on > best.effective_on)) best = t;
    }
    return best;
  }, [targets, now]);

  const acceptDerived = useCallback(async () => {
    if (!suggested?.suggestion) return;
    const s = suggested.suggestion;
    setSaving("derived");
    setError(null);
    try {
      await saveTarget(getToken, now, {
        kcal: s.kcal,
        protein_g: s.protein_g,
        carb_g: s.carb_g,
        fat_g: s.fat_g,
        fibre_g: s.fibre_g,
        source: "derived",
        // The basis travels with it and is stored FROZEN. Dropping it here
        // would make the target unexplainable the moment anything moved.
        basis: s.basis,
      });
      setSaved(`Target set from ${now}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that target.");
    } finally {
      setSaving(null);
    }
  }, [getToken, now, suggested, load]);

  const acceptAdjustment = useCallback(
    async (a: Adjustment) => {
      setSaving("adjustment");
      setError(null);
      try {
        await saveTarget(getToken, a.effective_on, {
          kcal: a.to_kcal,
          protein_g: a.protein_g,
          carb_g: a.carb_g,
          fat_g: a.fat_g,
          fibre_g: a.fibre_g,
          source: "adjustment",
          // The adjustment's own arithmetic is a DIFFERENT shape from a
          // derivation's, and the target row stores the latter. Sending null
          // rather than a coerced one keeps the stored explanation honest:
          // this target came from an adjustment, and `source` says so.
          basis: null,
        });
        setSaved(`Target set from ${a.effective_on}.`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save that target.");
      } finally {
        setSaving(null);
      }
    },
    [getToken, load],
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-danger-ink">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-card border border-lime/40 bg-lime/10 p-3 text-sm text-lime-ink">
          {saved}
        </p>
      )}

      {loading && !live && !adjustment ? (
        <p className="text-sm text-text-dim">Loading…</p>
      ) : (
        <>
          {adjustment && (
            <AdjustmentCard
              response={adjustment}
              units={units}
              onAccept={acceptAdjustment}
              accepting={saving === "adjustment"}
            />
          )}

          <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
            <h2 className="eyebrow">What you are eating to</h2>
            {!live ? (
              <p className="text-sm text-text-muted">
                No target yet. Derive one below, or type your own.
              </p>
            ) : (
              <>
                <p className="text-lg">
                  <strong className="font-display tabular-nums">{live.kcal} kcal</strong>{" "}
                  <span className="text-text-muted">
                    from {live.effective_on} · {SOURCE_LABEL[live.source]}
                  </span>
                </p>
                {live.basis ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs font-semibold text-text-muted hover:text-text">
                      Why this number
                    </summary>
                    <div className="mt-3">
                      <Derivation
                        basis={live.basis}
                        kcal={live.kcal}
                        proteinG={live.protein_g}
                        carbG={live.carb_g}
                        fatG={live.fat_g}
                        fibreG={live.fibre_g}
                        units={units}
                      />
                    </div>
                  </details>
                ) : (
                  <p className="text-xs text-text-dim">
                    {/* Said plainly rather than left blank. A missing
                        explanation that looks like a loading state is worse
                        than one that says there is nothing to show. */}
                    {live.source === "manual"
                      ? "You typed this one, so there is no arithmetic to show."
                      : "This target came from a weekly adjustment. Its arithmetic was shown at the time you accepted it and is not stored on the row."}
                  </p>
                )}
                <ul className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-muted">
                  <li>Protein <strong className="tabular-nums text-text">{live.protein_g} g</strong></li>
                  <li>Fat <strong className="tabular-nums text-text">{live.fat_g} g</strong></li>
                  <li>Carbs <strong className="tabular-nums text-text">{live.carb_g} g</strong></li>
                  {live.fibre_g != null && (
                    <li>Fibre <strong className="tabular-nums text-text">{live.fibre_g} g</strong></li>
                  )}
                </ul>
              </>
            )}
          </section>

          <section className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
            <h2 className="eyebrow">Derive a new target</h2>

            <div className="flex flex-col gap-2">
              <p className="text-xs text-text-muted">
                How much you move outside training. Training itself is counted
                separately, from your logged sessions — do not include it here.
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Daily activity">
                {ACTIVITY.map((a) => (
                  <button
                    key={a.key}
                    type="button"
                    onClick={() => setActivity(a.key)}
                    aria-pressed={a.key === activity}
                    title={a.detail}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                      a.key === activity
                        ? "border-lime bg-lime/10 text-lime-ink"
                        : "border-line text-text-muted hover:text-text"
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            {suggested?.suggestion?.basis ? (
              <>
                <Derivation
                  basis={suggested.suggestion.basis}
                  kcal={suggested.suggestion.kcal}
                  proteinG={suggested.suggestion.protein_g}
                  carbG={suggested.suggestion.carb_g}
                  fatG={suggested.suggestion.fat_g}
                  fibreG={suggested.suggestion.fibre_g}
                  units={units}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={acceptDerived}
                    disabled={saving !== null}
                    className="rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-accent-on-fill disabled:opacity-60"
                  >
                    {saving === "derived" ? "Saving…" : `Eat this from ${now}`}
                  </button>
                  <p className="text-xs text-text-dim">
                    Nothing is saved until you press it, and it takes effect
                    from today forward — past days keep the target they were
                    judged against.
                  </p>
                </div>
              </>
            ) : suggested ? (
              // A 200 with a null suggestion. The remedy is a form, not a
              // retry, so the missing fields are named rather than reported as
              // a failure.
              <p className="text-sm text-text-muted">
                This needs {listMissing(suggested.missing)} before it can derive
                anything. A resting-rate estimate built on a coarse profile runs
                20–30% high, which would inflate the whole chain by hundreds of
                calories a day — so it refuses rather than guessing.
              </p>
            ) : null}
          </section>

          <ManualTarget
            defaultOn={now}
            live={live}
            saving={saving === "manual"}
            onSave={async (input) => {
              setSaving("manual");
              setError(null);
              try {
                await saveTarget(getToken, input.effective_on, {
                  kcal: input.kcal,
                  protein_g: input.protein_g,
                  carb_g: input.carb_g,
                  fat_g: input.fat_g,
                  fibre_g: input.fibre_g,
                  source: "manual",
                  basis: null,
                });
                setSaved(`Target set from ${input.effective_on}.`);
                await load();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not save that target.");
              } finally {
                setSaving(null);
              }
            }}
          />

          {targets.length > 0 && (
            <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
              <h2 className="eyebrow">History</h2>
              <p className="text-xs text-text-dim">
                Every target you have set, newest first. Past days are judged
                against the target that was live then, so these rows are the
                record — not a setting with one current value.
              </p>
              <ul className="mt-1 divide-y divide-line-soft">
                {[...targets]
                  .sort((a, b) => (a.effective_on < b.effective_on ? 1 : -1))
                  .map((t) => (
                    <li
                      key={t.effective_on}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm"
                    >
                      <span className="text-text-muted">
                        {t.effective_on} · {SOURCE_LABEL[t.source]}
                      </span>
                      <span className="tabular-nums">
                        {t.kcal} kcal · {t.protein_g}P / {t.carb_g}C / {t.fat_g}F
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  derived: "derived",
  manual: "typed",
  adjustment: "weekly adjustment",
};

function listMissing(missing: string[]): string {
  const words = missing.map((m) => MISSING_LABEL[m] ?? m);
  if (words.length <= 1) return words[0] ?? "more profile detail";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

type ManualInput = {
  effective_on: string;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
};

/**
 * A typed target.
 *
 * Kept, and kept plain, because an athlete working with a coach has a number
 * from a person and no interest in our arithmetic. It is stored as `manual`
 * precisely so nothing later pretends it was derived — that distinction is
 * what lets the screen above say "you typed this one" instead of showing an
 * explanation that was never true.
 */
function ManualTarget({
  defaultOn,
  live,
  saving,
  onSave,
}: {
  defaultOn: string;
  live: Target | null;
  saving: boolean;
  onSave: (input: ManualInput) => void;
}) {
  const [on, setOn] = useState(defaultOn);
  const [kcal, setKcal] = useState(String(live?.kcal ?? ""));
  const [protein, setProtein] = useState(String(live?.protein_g ?? ""));
  const [carb, setCarb] = useState(String(live?.carb_g ?? ""));
  const [fat, setFat] = useState(String(live?.fat_g ?? ""));
  const [fibre, setFibre] = useState(live?.fibre_g != null ? String(live.fibre_g) : "");

  const numbers = [kcal, protein, carb, fat].map((v) => Number(v));
  const valid = numbers.every((n) => Number.isFinite(n) && n >= 0) && numbers[0] > 0;

  return (
    <details className="rounded-card border border-line bg-surface p-4">
      <summary className="cursor-pointer text-xs font-semibold text-text-muted hover:text-text">
        Or type your own
      </summary>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onSave({
            effective_on: on,
            kcal: Math.round(numbers[0]),
            protein_g: Math.round(numbers[1]),
            carb_g: Math.round(numbers[2]),
            fat_g: Math.round(numbers[3]),
            // Absent rather than zero. A target that does not state fibre is
            // not a zero-fibre target, and the column is nullable for exactly
            // that reason.
            fibre_g: fibre.trim() === "" ? null : Math.round(Number(fibre)),
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From" type="date" value={on} onChange={setOn} />
          <Field label="Calories" value={kcal} onChange={setKcal} suffix="kcal" />
          <Field label="Protein" value={protein} onChange={setProtein} suffix="g" />
          <Field label="Carbs" value={carb} onChange={setCarb} suffix="g" />
          <Field label="Fat" value={fat} onChange={setFat} suffix="g" />
          <Field label="Fibre" value={fibre} onChange={setFibre} suffix="g" optional />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!valid || saving}
            className="rounded-control border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save typed target"}
          </button>
          <p className="text-xs text-text-dim">
            Saved without an explanation, because there is none to save.
          </p>
        </div>
      </form>
    </details>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  type = "number",
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  type?: string;
  optional?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-text-muted">
        {label}
        {suffix ? ` (${suffix})` : ""}
        {optional ? " — optional" : ""}
      </span>
      <input
        type={type}
        inputMode={type === "number" ? "numeric" : undefined}
        min={type === "number" ? 0 : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-control border border-line bg-bg px-3 py-2 text-sm text-text"
      />
    </label>
  );
}
