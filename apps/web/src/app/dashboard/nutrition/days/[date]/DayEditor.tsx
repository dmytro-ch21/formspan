"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import { formatDayLong, today } from "@/lib/history";
import {
  deleteEntry,
  listEntries,
  listTargets,
  saveEntry,
  type Entry,
  type Meal,
  type Target,
} from "@/lib/nutritionApi";
import { targetOn } from "@/lib/nutritionSeries";

/**
 * Correcting a day that has already happened.
 *
 * # Why quantity gets the emphasis it does
 *
 * N40 put the first real photograph through the AI estimator. Six items came
 * back: four correct, **one invented** and **one quantity doubled** — two fried
 * eggs where there was one. The invention was flagged three ways (low portion
 * confidence, a hedged assumption, a note naming it as unclear). The miscount
 * was flagged not at all: `medium` confidence, stated flatly.
 *
 * That asymmetry is the design input for this screen. A phantom row is
 * self-evidently wrong and gets deleted on sight — it needs nothing from the
 * UI. **A `2` where there was a `1` is one glance from being accepted**,
 * because the item is real, the name is right, and only the number is wrong.
 * The confidence signal does not help: it is calibrated to *can I identify
 * this*, never to *can I count it*.
 *
 * So quantity is not a field buried in an edit form. It is on the row, it has
 * halve and double controls sitting next to it, and the per-serving figures
 * are shown separately from the total so a wrong count is visible as an
 * implausible total rather than hidden inside one.
 *
 * # Two things this screen must not become
 *
 * **It is not a logging screen.** Recording a meal you are eating now is the
 * phone's, and nothing here has an in-the-moment affordance. Adding a missed
 * entry to a past day is correction, which is why the add form defaults to
 * this page's date and never to now.
 *
 * **It does not recompute from a saved food.** An entry owns its numbers. The
 * `source_food_id` is provenance and is carried through a save unchanged, so
 * correcting a recipe next month cannot rewrite what this day says you ate.
 */

/** How many servings one tap moves. Halve and double, because the two errors a
 *  quantity estimate actually makes are a factor of two in one direction or
 *  the other — not a nudge. */
const SCALES: { label: string; factor: number; hint: string }[] = [
  { label: "½", factor: 0.5, hint: "Halve this quantity" },
  { label: "×2", factor: 2, hint: "Double this quantity" },
];

type Draft = {
  servings: string;
  serving_label: string;
  /** PER SERVING, which is not what the wire carries. See `perServing` below. */
  kcal: string;
  protein_g: string;
  carb_g: string;
  fat_g: string;
  fibre_g: string;
  name: string;
  meal: Meal;
  notes: string;
};

const MEAL_LABEL: Record<Meal, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snacks",
};

/**
 * An entry's macros are ABSOLUTE for the quantity logged — already multiplied
 * by servings, because the server never scales.
 *
 * Editing is therefore done in per-serving terms and multiplied back on save.
 * That is the whole mechanism behind the halve/double controls: changing the
 * count has to change the calories, and an editor that let servings move while
 * kcal stayed put would silently record "one egg, 280 kcal" — a correction
 * that makes the row *more* wrong than the miscount it was fixing.
 */
function perServing(e: Entry): Draft {
  const n = e.servings > 0 ? e.servings : 1;
  return {
    servings: trim(e.servings),
    serving_label: e.serving_label,
    kcal: trim(e.kcal / n),
    protein_g: trim(e.protein_g / n),
    carb_g: trim(e.carb_g / n),
    fat_g: trim(e.fat_g / n),
    fibre_g: e.fibre_g == null ? "" : trim(e.fibre_g / n),
    name: e.name,
    meal: e.meal,
    notes: e.notes,
  };
}

function trim(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export function DayEditor({ date }: { date: string }) {
  const { getToken } = useAuth();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setLoading(true);
    setError(null);
    try {
      const [e, t] = await Promise.all([
        listEntries(getToken, { from: date, to: date }, c.signal),
        listTargets(getToken, { from: date, to: date }, c.signal),
      ]);
      if (c.signal.aborted) return;
      setEntries(e.entries);
      // The server's own vocabulary and display order, so this picker cannot
      // disagree with the validator. Sorting these alphabetically would give
      // breakfast, dinner, lunch, snack — which reads as a bug to everyone.
      setMeals(e.meals);
      setTargets(t);
    } catch (err) {
      if (c.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Could not load that day.");
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [getToken, date]);

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

  const target = useMemo(() => targetOn(targets, date), [targets, date]);
  const totals = useMemo(
    () =>
      entries.reduce(
        (acc, e) => ({
          kcal: acc.kcal + e.kcal,
          protein_g: acc.protein_g + e.protein_g,
          carb_g: acc.carb_g + e.carb_g,
          fat_g: acc.fat_g + e.fat_g,
        }),
        { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
      ),
    [entries],
  );

  const commit = useCallback(
    async (entry: Entry, d: Draft) => {
      const servings = Number(d.servings);
      if (!Number.isFinite(servings) || servings <= 0) {
        setError("Servings has to be more than zero.");
        return;
      }
      const num = (v: string) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : 0;
      };
      setBusy(entry.id);
      setError(null);
      try {
        await saveEntry(getToken, entry.id, {
          eaten_on: date,
          meal: d.meal,
          name: d.name.trim(),
          servings,
          serving_label: d.serving_label.trim(),
          // Multiplied back up: the wire carries the total for the quantity.
          kcal: num(d.kcal) * servings,
          protein_g: num(d.protein_g) * servings,
          carb_g: num(d.carb_g) * servings,
          fat_g: num(d.fat_g) * servings,
          // Absent stays absent. An entry that never stated fibre is not a
          // zero-fibre entry, and a correction must not turn silence into a
          // measurement.
          fibre_g: d.fibre_g.trim() === "" ? null : num(d.fibre_g) * servings,
          // Provenance is preserved across a correction — this is still the
          // row that came from that food, even after the numbers changed.
          source_food_id: entry.source_food_id,
          notes: d.notes,
        });
        setEditing(null);
        setDraft(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save that correction.");
      } finally {
        setBusy(null);
      }
    },
    [getToken, date, load],
  );

  const remove = useCallback(
    async (entry: Entry) => {
      setBusy(entry.id);
      setError(null);
      try {
        await deleteEntry(getToken, entry.id);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not remove that entry.");
      } finally {
        setBusy(null);
      }
    },
    [getToken, load],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl uppercase">
          {formatDayLong(date)}
          {date === today() && <span className="text-text-dim"> · today</span>}
        </h2>
        <Link
          href="/dashboard/nutrition/days"
          className="text-xs font-semibold text-text-muted underline underline-offset-4 hover:text-text"
        >
          All days
        </Link>
      </div>

      {/* The N40 finding, stated where it is acted on. An athlete correcting a
          draft needs to know WHICH errors the estimator is bad at, and the
          answer is counterintuitive: it is better at knowing what a thing is
          than at knowing how much of it there was. */}
      <p className="rounded-card border border-line bg-surface-raised p-3 text-xs text-text-muted">
        <strong className="text-text">Check the quantities first.</strong> An
        estimated entry is far likelier to be wrong about <em>how much</em> than
        about <em>what</em> — and it will not flag that. A confidence rating
        describes whether the food was identified, never whether it was counted,
        so a confident row can still be double what you ate.
      </p>

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-danger-ink">
          {error}
        </p>
      )}

      <section className="rounded-card border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="eyebrow">Day total</h3>
          <p className="text-xs text-text-dim">
            {target ? `Target ${target.kcal} kcal` : "No target was set for this day"}
          </p>
        </div>
        {entries.length === 0 ? (
          // Rule 1, at the level of a single day. Not "0 kcal".
          <p className="mt-2 text-sm text-text-muted">
            Nothing was logged on this day. That is recorded as a gap, not as a
            day you ate nothing — add what you remember below, or leave it.
          </p>
        ) : (
          <p className="stat mt-1">
            {Math.round(totals.kcal)} kcal
            <span className="ml-3 font-body text-sm font-normal text-text-muted tabular-nums">
              {Math.round(totals.protein_g)}P / {Math.round(totals.carb_g)}C /{" "}
              {Math.round(totals.fat_g)}F
            </span>
          </p>
        )}
      </section>

      {loading && entries.length === 0 ? (
        <p className="text-sm text-text-dim">Loading…</p>
      ) : (
        meals.map((meal) => {
          const rows = entries.filter((e) => e.meal === meal);
          if (rows.length === 0) return null;
          return (
            <section key={meal} className="flex flex-col gap-2">
              <h3 className="eyebrow">{MEAL_LABEL[meal] ?? meal}</h3>
              <ul className="flex flex-col gap-2">
                {rows.map((e) => (
                  <li key={e.id}>
                    {editing === e.id && draft ? (
                      <EntryForm
                        draft={draft}
                        meals={meals}
                        busy={busy === e.id}
                        onChange={setDraft}
                        onCancel={() => {
                          setEditing(null);
                          setDraft(null);
                        }}
                        onSave={() => commit(e, draft)}
                      />
                    ) : (
                      <EntryRow
                        entry={e}
                        busy={busy === e.id}
                        onEdit={() => {
                          setEditing(e.id);
                          setDraft(perServing(e));
                        }}
                        onScale={(factor) => {
                          const d = perServing(e);
                          const next = Number(d.servings) * factor;
                          commit(e, { ...d, servings: trim(next) });
                        }}
                        onDelete={() => remove(e)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      <AddEntry
        date={date}
        meals={meals}
        open={adding}
        onOpen={() => setAdding(true)}
        onClose={() => setAdding(false)}
        onAdded={async () => {
          setAdding(false);
          await load();
        }}
        onError={setError}
      />
    </div>
  );
}

function EntryRow({
  entry,
  busy,
  onEdit,
  onScale,
  onDelete,
}: {
  entry: Entry;
  busy: boolean;
  onEdit: () => void;
  onScale: (factor: number) => void;
  onDelete: () => void;
}) {
  const per = entry.servings > 0 ? entry.kcal / entry.servings : entry.kcal;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line bg-surface px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{entry.name}</p>
        <p className="text-[0.6875rem] text-text-dim">
          {/* The per-serving figure alongside the total, always. It is what
              makes a doubled count visible: "1 egg at 90 kcal" next to "180
              kcal" is a sentence you can check, where "180 kcal" alone is
              not. */}
          {trim(entry.servings)} × {entry.serving_label} at {Math.round(per)} kcal each
          {entry.notes ? ` · ${entry.notes}` : ""}
        </p>
      </div>

      <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${entry.name}`}>
        {SCALES.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={busy}
            onClick={() => onScale(s.factor)}
            title={s.hint}
            aria-label={`${s.hint}: ${entry.name}`}
            className="rounded-control border border-line px-2 py-1 text-xs font-semibold text-text-muted hover:text-text disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="w-24 shrink-0 text-right font-display text-base tabular-nums">
        {Math.round(entry.kcal)}
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="text-xs font-semibold text-text-muted underline underline-offset-4 hover:text-text disabled:opacity-50"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-xs font-semibold text-danger-ink underline underline-offset-4 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function EntryForm({
  draft,
  meals,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  meals: Meal[];
  busy: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const servings = Number(draft.servings);
  const kcal = Number(draft.kcal);
  const total =
    Number.isFinite(servings) && Number.isFinite(kcal) ? Math.round(servings * kcal) : null;

  return (
    <form
      className="flex flex-col gap-3 rounded-card border border-lime bg-lime/5 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What" value={draft.name} type="text" onChange={(v) => onChange({ ...draft, name: v })} />
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Meal</span>
          <select
            value={draft.meal}
            onChange={(e) => onChange({ ...draft, meal: e.target.value as Meal })}
            className="rounded-control border border-line bg-bg px-3 py-2 text-sm text-text"
          >
            {meals.map((m) => (
              <option key={m} value={m}>
                {MEAL_LABEL[m] ?? m}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Quantity gets its own block, above the macros rather than beside
          them. It is the field most likely to be wrong and least likely to
          look wrong, so it is not one input among seven. */}
      <fieldset className="rounded-control border border-line bg-surface p-3">
        <legend className="px-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted">
          How much
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Servings"
            value={draft.servings}
            onChange={(v) => onChange({ ...draft, servings: v })}
          />
          <Field
            label="One serving is"
            type="text"
            value={draft.serving_label}
            onChange={(v) => onChange({ ...draft, serving_label: v })}
          />
        </div>
        {total != null && (
          <p className="mt-2 text-xs text-text-muted">
            {/* The multiplication, spelled out. An athlete fixing a doubled
                count sees the total move as they type, which is the fastest
                possible confirmation that the fix landed. */}
            {draft.servings} × {draft.kcal} kcal ={" "}
            <strong className="tabular-nums text-text">{total} kcal</strong> for this entry
          </p>
        )}
      </fieldset>

      <fieldset className="rounded-control border border-line bg-surface p-3">
        <legend className="px-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted">
          Per serving
        </legend>
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="kcal" value={draft.kcal} onChange={(v) => onChange({ ...draft, kcal: v })} />
          <Field label="Protein g" value={draft.protein_g} onChange={(v) => onChange({ ...draft, protein_g: v })} />
          <Field label="Carbs g" value={draft.carb_g} onChange={(v) => onChange({ ...draft, carb_g: v })} />
          <Field label="Fat g" value={draft.fat_g} onChange={(v) => onChange({ ...draft, fat_g: v })} />
          <Field
            label="Fibre g"
            value={draft.fibre_g}
            optional
            onChange={(v) => onChange({ ...draft, fibre_g: v })}
          />
        </div>
      </fieldset>

      <Field label="Note" type="text" value={draft.notes} onChange={(v) => onChange({ ...draft, notes: v })} optional />

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-accent-on-fill disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save correction"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-control border border-line px-4 py-2 text-sm font-semibold"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddEntry({
  date,
  meals,
  open,
  onOpen,
  onClose,
  onAdded,
  onError,
}: {
  date: string;
  meals: Meal[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAdded: () => void;
  onError: (m: string) => void;
}) {
  const { getToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    servings: "1",
    serving_label: "serving",
    kcal: "",
    protein_g: "",
    carb_g: "",
    fat_g: "",
    fibre_g: "",
    name: "",
    meal: meals[0] ?? "breakfast",
    notes: "",
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="self-start rounded-control border border-line px-4 py-2 text-sm font-semibold"
      >
        Add something you missed
      </button>
    );
  }

  return (
    <EntryForm
      draft={draft}
      meals={meals}
      busy={busy}
      onChange={setDraft}
      onCancel={onClose}
      onSave={async () => {
        const servings = Number(draft.servings);
        if (!draft.name.trim() || !Number.isFinite(servings) || servings <= 0) {
          onError("An entry needs a name and a quantity above zero.");
          return;
        }
        const num = (v: string) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 ? n : 0;
        };
        setBusy(true);
        try {
          await saveEntry(getToken, crypto.randomUUID(), {
            // This day, never today. Correcting the 3rd from a screen opened on
            // the 19th must file the entry on the 3rd, and a default of "now"
            // is how that silently goes wrong.
            eaten_on: date,
            meal: draft.meal,
            name: draft.name.trim(),
            servings,
            serving_label: draft.serving_label.trim() || "serving",
            kcal: num(draft.kcal) * servings,
            protein_g: num(draft.protein_g) * servings,
            carb_g: num(draft.carb_g) * servings,
            fat_g: num(draft.fat_g) * servings,
            fibre_g: draft.fibre_g.trim() === "" ? null : num(draft.fibre_g) * servings,
            notes: draft.notes,
          });
          onAdded();
        } catch (e) {
          onError(e instanceof Error ? e.message : "Could not add that entry.");
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function Field({
  label,
  value,
  onChange,
  type = "number",
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  optional?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-text-muted">
        {label}
        {optional ? " — optional" : ""}
      </span>
      <input
        type={type}
        inputMode={type === "number" ? "decimal" : undefined}
        min={type === "number" ? 0 : undefined}
        step={type === "number" ? "any" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-control border border-line bg-bg px-3 py-2 text-sm text-text"
      />
    </label>
  );
}
