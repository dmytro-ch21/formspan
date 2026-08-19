"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import { saveFood, type Food, type Macros, type RecipeItemInput } from "@/lib/nutritionApi";

/**
 * Authoring a recipe: a thing you cook once and eat six times.
 *
 * **This is a desk activity, which is why it is here and not on the phone.**
 * Entering fourteen ingredients with their weights is not something anybody
 * does one-handed between sets — the phone's job is to log a portion of the
 * result in two taps, which it can only do if this screen exists.
 *
 * # The rule this screen exists to respect
 *
 * A recipe's items COPY their components' numbers rather than referencing
 * them, exactly like a logged entry does. Correcting "chicken thigh" next
 * month must not silently rewrite a recipe built today, and it must certainly
 * not rewrite the days that recipe was eaten on. So every item here carries
 * its own macros, typed or pasted from a label, and nothing on this screen
 * joins back to anything.
 *
 * # No catalog search, deliberately, and not an oversight
 *
 * Items are composed by typing a name and its numbers. A food-catalog picker
 * is real work with its own honest-not-found problem, it is filed separately
 * (N42, with barcode scanning as N41), and building a thin version here would
 * mean N42 has to replace it rather than land in it. The one place this
 * section reads `/nutrition/foods` is to list the athlete's own saved recipes.
 *
 * # Where the numbers come from
 *
 * Per-serving macros are computed live so the author can see what a portion
 * will cost while they are still deciding the yield — but the SERVER is
 * authoritative: `Food.PerServing()` runs at write time and the stored row is
 * its answer, not ours. This preview mirrors that function so the two agree;
 * if they ever disagree, the server is right and this is the bug.
 */

type ItemDraft = {
  name: string;
  quantity: string;
  serving_label: string;
  kcal: string;
  protein_g: string;
  carb_g: string;
  fat_g: string;
  fibre_g: string;
};

const EMPTY_ITEM: ItemDraft = {
  name: "",
  quantity: "1",
  serving_label: "100 g",
  kcal: "",
  protein_g: "",
  carb_g: "",
  fat_g: "",
  fibre_g: "",
};

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Mirrors `Food.PerServing()`.
 *
 * Fibre is summed only if at least one item states it — otherwise the recipe
 * reports "not stated" rather than a total assembled from silence. Getting
 * that wrong here would show a confident 0 g on a preview and a null on the
 * saved row, which is the kind of disagreement that makes an author distrust
 * the whole screen.
 */
export function perServing(items: ItemDraft[], yieldServings: number): Macros {
  const y = yieldServings > 0 ? yieldServings : 1;
  let kcal = 0;
  let protein = 0;
  let carb = 0;
  let fat = 0;
  let fibre = 0;
  let anyFibre = false;
  for (const it of items) {
    const q = num(it.quantity);
    kcal += num(it.kcal) * q;
    protein += num(it.protein_g) * q;
    carb += num(it.carb_g) * q;
    fat += num(it.fat_g) * q;
    if (it.fibre_g.trim() !== "") {
      fibre += num(it.fibre_g) * q;
      anyFibre = true;
    }
  }
  return {
    kcal: kcal / y,
    protein_g: protein / y,
    carb_g: carb / y,
    fat_g: fat / y,
    fibre_g: anyFibre ? fibre / y : null,
  };
}

function toDraft(food: Food): ItemDraft[] {
  return food.items.map((it) => ({
    name: it.name,
    quantity: String(it.quantity),
    serving_label: it.serving_label,
    kcal: String(it.kcal),
    protein_g: String(it.protein_g),
    carb_g: String(it.carb_g),
    fat_g: String(it.fat_g),
    fibre_g: it.fibre_g == null ? "" : String(it.fibre_g),
  }));
}

export function RecipeEditor({ existing }: { existing?: Food }) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [name, setName] = useState(existing?.name ?? "");
  const [brand, setBrand] = useState(existing?.brand ?? "");
  const [servingLabel, setServingLabel] = useState(existing?.serving_label ?? "1 portion");
  const [yieldServings, setYieldServings] = useState(
    String(existing?.yield_servings ?? 4),
  );
  const [items, setItems] = useState<ItemDraft[]>(
    existing ? toDraft(existing) : [{ ...EMPTY_ITEM }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const yieldN = Number(yieldServings);
  const per = useMemo(() => perServing(items, yieldN), [items, yieldN]);

  const named = items.filter((i) => i.name.trim() !== "");
  const valid =
    name.trim() !== "" &&
    servingLabel.trim() !== "" &&
    Number.isFinite(yieldN) &&
    yieldN > 0 &&
    named.length > 0;

  const update = (i: number, patch: Partial<ItemDraft>) =>
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const payload: RecipeItemInput[] = named.map((it) => ({
        name: it.name.trim(),
        quantity: num(it.quantity) > 0 ? num(it.quantity) : 1,
        serving_label: it.serving_label.trim() || "serving",
        kcal: num(it.kcal),
        protein_g: num(it.protein_g),
        carb_g: num(it.carb_g),
        fat_g: num(it.fat_g),
        // Absent stays absent — an item that does not state fibre is not
        // claiming zero, and the recipe's own fibre figure depends on the
        // difference.
        fibre_g: it.fibre_g.trim() === "" ? null : num(it.fibre_g),
      }));
      // A recipe's ID is client-generated, same contract as everywhere else,
      // so a re-sent save is the same save rather than a second recipe.
      const id = existing?.id ?? crypto.randomUUID();
      await saveFood(getToken, id, {
        kind: "recipe",
        name: name.trim(),
        brand: brand.trim(),
        serving_label: servingLabel.trim(),
        yield_servings: yieldN,
        // Sent so the request validates, but the SERVER recomputes them from
        // the items at write time and its answer is the one that is stored.
        ...per,
        items: payload,
      });
      router.push("/dashboard/nutrition/recipes");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that recipe.");
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) submit();
      }}
    >
      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-danger-ink">
          {error}
        </p>
      )}

      <section className="grid gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-2">
        <Field label="Recipe" type="text" value={name} onChange={setName} />
        <Field label="Note" type="text" value={brand} onChange={setBrand} optional />
        <Field
          label="Makes how many portions"
          value={yieldServings}
          onChange={setYieldServings}
        />
        <Field
          label="One portion is"
          type="text"
          value={servingLabel}
          onChange={setServingLabel}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="eyebrow">Ingredients</h2>
          <p className="text-[0.6875rem] text-text-dim">
            {/* Said once, plainly. An author who does not know the numbers are
                copied will expect a later correction to propagate, and be
                wrong about their own history. */}
            Numbers are copied in as you type them. Correcting an ingredient
            later will not change this recipe, and will not change any day you
            have already eaten it on.
          </p>
        </div>

        <ul className="flex flex-col gap-3">
          {items.map((it, i) => (
            <li key={i} className="rounded-card border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid flex-1 gap-3 sm:grid-cols-3">
                  <Field
                    label="Ingredient"
                    type="text"
                    value={it.name}
                    onChange={(v) => update(i, { name: v })}
                  />
                  <Field
                    label="How many"
                    value={it.quantity}
                    onChange={(v) => update(i, { quantity: v })}
                  />
                  <Field
                    label="Of what"
                    type="text"
                    value={it.serving_label}
                    onChange={(v) => update(i, { serving_label: v })}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                  disabled={items.length === 1}
                  aria-label={`Remove ${it.name || `ingredient ${i + 1}`}`}
                  className="mt-5 text-xs font-semibold text-danger-ink underline underline-offset-4 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-5">
                <Field label="kcal" value={it.kcal} onChange={(v) => update(i, { kcal: v })} />
                <Field label="Protein g" value={it.protein_g} onChange={(v) => update(i, { protein_g: v })} />
                <Field label="Carbs g" value={it.carb_g} onChange={(v) => update(i, { carb_g: v })} />
                <Field label="Fat g" value={it.fat_g} onChange={(v) => update(i, { fat_g: v })} />
                <Field label="Fibre g" optional value={it.fibre_g} onChange={(v) => update(i, { fibre_g: v })} />
              </div>
              <p className="mt-2 text-[0.6875rem] text-text-dim">
                {/* Per-unit above, total here. Same reasoning as the day
                    editor: a wrong quantity is invisible in a per-unit figure
                    and obvious in a total. */}
                {it.quantity || 0} × {it.serving_label || "serving"} ={" "}
                {Math.round(num(it.kcal) * num(it.quantity))} kcal in the pot
              </p>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])}
          className="self-start rounded-control border border-line px-4 py-2 text-sm font-semibold"
        >
          Add an ingredient
        </button>
      </section>

      <section className="rounded-card border border-line bg-surface p-4">
        <h2 className="eyebrow">One portion</h2>
        {Number.isFinite(yieldN) && yieldN > 0 ? (
          <>
            <p className="stat mt-1">{Math.round(per.kcal)} kcal</p>
            <p className="mt-1 text-sm text-text-muted tabular-nums">
              {Math.round(per.protein_g)}P / {Math.round(per.carb_g)}C /{" "}
              {Math.round(per.fat_g)}F
              {per.fibre_g != null ? ` / ${Math.round(per.fibre_g)} fibre` : ""}
            </p>
            {per.fibre_g == null && (
              <p className="mt-1 text-[0.6875rem] text-text-dim">
                No ingredient states fibre, so this recipe does not claim a
                fibre figure — that is different from claiming zero.
              </p>
            )}
          </>
        ) : (
          <p className="mt-1 text-sm text-text-muted">
            Set how many portions this makes to see what one costs.
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!valid || saving}
          className="rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-accent-on-fill disabled:opacity-60"
        >
          {saving ? "Saving…" : existing ? "Save changes" : "Save recipe"}
        </button>
        {!valid && (
          <p className="text-xs text-text-dim">
            A recipe needs a name, a portion count above zero, a description of
            one portion, and at least one named ingredient.
          </p>
        )}
      </div>
    </form>
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
