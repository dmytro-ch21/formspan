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
import { updateActivityLevel } from "@/lib/api";
import { parseManualTarget } from "@/lib/manualTarget";
import { useUnits } from "@/lib/useUnits";
import { AdjustmentCard } from "./AdjustmentCard";
import { Derivation } from "./Derivation";
import {
  loadTargetsInto,
  sourceLabel,
  TargetHistory,
  TargetsLoadFailed,
  targetsView,
} from "./targetsState";

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
  /**
   * The level this page is PINNED to, or null to follow the account.
   *
   * Null is the normal state and is what makes the two surfaces agree: the
   * request goes out with no `activity` parameter, the server answers from
   * `profile.activity_level`, and this page derives at whatever the athlete
   * last chose — on either device. It used to be `useState("light")`, which
   * meant a browser and a phone computed different targets for one athlete on
   * one day (N93).
   *
   * A chip click sets it, so the derivation moves immediately rather than
   * waiting on the PATCH — and keeps it set for the rest of the visit, because
   * clearing it on success would change the request and refetch the ladder for
   * an answer that cannot have moved.
   */
  const [pinnedActivity, setPinnedActivity] = useState<string | null>(null);
  /**
   * Whether the targets have EVER loaded on this visit, and why the last read
   * did not (N127, #531). Without these a failed read rendered "No target yet"
   * — see `targetsState.tsx`. `loadError` is deliberately not the shared
   * `error` below, which five other paths clear.
   */
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    // No `setError(null)` here any more: the load no longer writes the shared
    // slot, so clearing it could only erase a message somebody else just set —
    // a derivation that failed on mount, say, a few milliseconds earlier.
    await loadTargetsInto(
      () =>
        Promise.all([
          // A year back, so the history reads as a sequence of decisions rather
          // than as one row. The window also carries in the target live at its
          // start, which is what makes "what was I eating to last spring"
          // answerable at all.
          listTargets(getToken, { from: addDays(now, -365), to: now }, c.signal),
          fetchAdjustment(getToken, now, c.signal),
        ]),
      { setTargets, setAdjustment, setLoaded, setLoadError },
      c.signal,
    );
  }, [getToken, now]);

  /** The derivation, which is the only thing the activity chip changes. */
  const loadSuggestion = useCallback(async () => {
    suggestRef.current?.abort();
    const c = new AbortController();
    suggestRef.current = c;
    try {
      const s = await suggestedTarget(
        getToken,
        now,
        pinnedActivity ?? undefined,
        c.signal,
      );
      if (!c.signal.aborted) setSuggested(s);
    } catch (e) {
      if (!c.signal.aborted) {
        setError(e instanceof Error ? e.message : "Could not derive a target.");
      }
    }
  }, [getToken, now, pinnedActivity]);

  useEffect(() => {
    // No `set-state-in-effect` disable here any more, unlike the suggestion's
    // effect below: the state writes moved into `loadTargetsInto` (N127), where
    // the rule cannot see them, and an unused disable is itself a lint warning.
    // The reasoning it carried still holds — `load` aborts its previous request
    // and bails on `signal.aborted` before any write, so this is one render on
    // mount, not a loop.
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSuggestion();
    return () => suggestRef.current?.abort();
  }, [loadSuggestion]);

  /**
   * The level the number on screen was ACTUALLY derived at.
   *
   * Read off the response rather than off local state, so the chips and the
   * arithmetic cannot describe different things. `pinnedActivity` wins only
   * while a click is still in flight, which is the one moment the response is
   * known to be about the previous level.
   */
  const derivedAt = pinnedActivity ?? suggested?.activity ?? "light";
  /** Nobody has picked one; the derivation is running on an assumption. */
  const assumed =
    pinnedActivity === null && suggested != null && !suggested.activity_chosen;

  /**
   * Record a level the athlete just clicked.
   *
   * Pinned first so the derivation moves at once, then written to the account.
   * A failed write says so rather than leaving a chip that has visibly moved
   * standing for a preference nothing stored — the same rule the rest of this
   * page follows for its three saves.
   */
  const chooseActivity = useCallback(
    async (level: string) => {
      setPinnedActivity(level);
      setError(null);
      try {
        await updateActivityLevel(getToken, level);
      } catch (e) {
        // ALWAYS attributed, never just the raw message.
        //
        // This was inverted: the sentence explaining what failed sat in the
        // `!(e instanceof Error)` branch, which almost nothing reaches —
        // `ApiError` extends Error, and a dropped connection is a `TypeError`
        // reading "Failed to fetch". So the athlete got a bare "Failed to
        // fetch" in the page's shared error slot, attached to nothing, while a
        // chip sat filled and `aria-pressed` for a level the account never
        // stored. Caught in review.
        const detail = e instanceof Error ? e.message : "";
        setError(
          `Could not save how much you move${detail ? `: ${detail}` : ""}. The chip below is right for this visit only.`,
        );
      }
    },
    [getToken],
  );

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

  const view = targetsView(loaded, loadError);

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

      {view === "ready" && loadError && (
        // A refresh after a save failed. What is below was really read, so it
        // stays — but it is said to be from before.
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-danger-ink">
          Could not refresh your targets ({loadError}). What is below is from the last time they loaded.
        </p>
      )}

      {view === "loading" ? (
        <p className="text-sm text-text-dim">Loading…</p>
      ) : view === "failed" ? (
        <TargetsLoadFailed message={loadError ?? "Could not load your targets."} onRetry={() => void load()} />
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
                    from {live.effective_on} · {sourceLabel(live.source)}
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
                      : live.source === "adjustment"
                        ? "This target came from a weekly adjustment. Its arithmetic was shown at the time you accepted it and is not stored on the row."
                        : // Absent or unknown. It used to fall through to the
                          // adjustment sentence, which is a claim about where
                          // the number came from that nothing supports.
                          "No explanation is stored with this target."}
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
                {ACTIVITY.map((a) => {
                  const isOn = !assumed && a.key === derivedAt;
                  // The level the derivation fell back to with nobody having
                  // chosen. Dashed rather than filled, and `aria-pressed` stays
                  // false: a pressed chip claims the athlete decided this, and
                  // they did not. `activity_chosen` is in the contract exactly
                  // so a client can tell the two apart.
                  const isAssumed = assumed && a.key === derivedAt;
                  return (
                    <button
                      key={a.key}
                      type="button"
                      onClick={() => void chooseActivity(a.key)}
                      aria-pressed={isOn}
                      title={a.detail}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                        isOn
                          ? "border-lime bg-lime/10 text-lime-ink"
                          : isAssumed
                            ? "border-dashed border-text-muted text-text-muted"
                            : "border-line text-text-muted hover:text-text"
                      }`}
                    >
                      {a.label}
                    </button>
                  );
                })}
              </div>
              {assumed ? (
                <p className="text-xs text-text-muted" data-testid="activity-assumed">
                  Assuming{" "}
                  <span className="font-semibold">
                    {ACTIVITY.find((a) => a.key === derivedAt)?.label ?? derivedAt}
                  </span>{" "}
                  until you pick one. Whichever you choose is kept on your
                  account, so the phone works your target out the same way.
                </p>
              ) : null}
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

          <TargetHistory targets={targets} />
        </>
      )}
    </div>
  );
}

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

  // The server's rails, checked before a round trip (N127). The old check was
  // "finite and not negative", so a dropped digit submitted and came back a
  // permanent 400 that read like a failed save — and a typo in fibre became
  // `NaN`, which JSON writes as `null`, which the server stores as "not stated".
  const parsed = parseManualTarget({ kcal, protein_g: protein, carb_g: carb, fat_g: fat, fibre_g: fibre });
  // An untouched empty form is not a mistake to report.
  const typed = [kcal, protein, carb, fat, fibre].some((v) => v.trim() !== "");

  return (
    <details className="rounded-card border border-line bg-surface p-4">
      <summary className="cursor-pointer text-xs font-semibold text-text-muted hover:text-text">
        Or type your own
      </summary>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!parsed.ok) return;
          // Blank fibre arrives as null, not zero — `parseManualTarget` keeps
          // that rule, for the reason it gives.
          onSave({ effective_on: on, ...parsed.input });
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
        {typed && !parsed.ok && (
          <p role="status" className="text-xs text-danger-ink">
            {parsed.problem}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!parsed.ok || saving}
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
