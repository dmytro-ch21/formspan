"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import { deleteFood, listFoods, type Food } from "@/lib/nutritionApi";

/**
 * The athlete's own recipes.
 *
 * Recipes only, filtered client-side from `/nutrition/foods` — the endpoint
 * returns both kinds and there is no `kind` query parameter. That is a
 * deliberate non-change to the API: the list is capped at 200 rows and is one
 * athlete's own saved things, so filtering here costs nothing, whereas adding
 * a parameter would be a contract change made for a screen rather than for a
 * question anybody asked.
 *
 * Plain foods are not listed. They are logged and edited on the phone, where
 * they are created; a recipe is the one kind that needs a keyboard and a wide
 * screen to build.
 */
export default function RecipesPage() {
  const { getToken } = useAuth();
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Which recipe is one click from being deleted. A two-step confirm rather
   *  than a modal: the destructive action is irreversible on the server and a
   *  recipe can hold fourteen hand-typed ingredients, so a stray click is
   *  expensive — but it is still one row in a list, and a dialog for it would
   *  be heavier than the risk. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setError(null);
    try {
      const all = await listFoods(getToken, "", c.signal);
      if (!c.signal.aborted) setFoods(all.filter((f) => f.kind === "recipe"));
    } catch (e) {
      if (!c.signal.aborted) {
        // `foods` stays null. Setting it to `[]` rendered the "No recipes yet"
        // empty state directly beneath the error — a confident claim about
        // what the athlete has, made from a request that failed.
        setError(e instanceof Error ? e.message : "Could not load your recipes.");
      }
    }
  }, [getToken]);

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          Build it once here; log a portion in two taps on the phone.
        </p>
        <Link
          href="/dashboard/nutrition/recipes/new"
          className="rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-accent-on-fill"
        >
          New recipe
        </Link>
      </div>

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-danger-ink">
          {error}
        </p>
      )}

      {foods === null ? (
        error ? null : <p className="text-sm text-text-dim">Loading…</p>
      ) : foods.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-text-muted">
          No recipes yet. A recipe is worth building for anything you make in a
          batch and eat across several days — the numbers get entered once
          instead of every time.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {foods.map((f) => (
            <li
              key={f.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card border border-line bg-surface px-4 py-3"
            >
              <div className="min-w-0">
                <Link
                  href={`/dashboard/nutrition/recipes/${f.id}`}
                  className="text-sm font-semibold underline underline-offset-4"
                >
                  {f.name}
                </Link>
                <p className="text-[0.6875rem] text-text-dim">
                  Makes {f.yield_servings ?? "?"} × {f.serving_label} ·{" "}
                  {f.items.length} {f.items.length === 1 ? "ingredient" : "ingredients"}
                  {f.brand ? ` · ${f.brand}` : ""}
                </p>
              </div>
              <p className="shrink-0 text-sm tabular-nums text-text-muted">
                {Math.round(f.kcal)} kcal · {Math.round(f.protein_g)}P /{" "}
                {Math.round(f.carb_g)}C / {Math.round(f.fat_g)}F
                <span className="text-text-dim"> per portion</span>
              </p>
              {confirming === f.id ? (
                <span className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={busy === f.id}
                    onClick={async () => {
                      setBusy(f.id);
                      setError(null);
                      try {
                        await deleteFood(getToken, f.id);
                        setConfirming(null);
                        await load();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Could not delete that recipe.");
                      } finally {
                        setBusy(null);
                      }
                    }}
                    className="text-xs font-semibold text-danger-ink underline underline-offset-4 disabled:opacity-50"
                  >
                    {busy === f.id ? "Deleting…" : `Really delete ${f.name}?`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="text-xs font-semibold text-text-muted underline underline-offset-4 hover:text-text"
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(f.id)}
                  aria-label={`Delete ${f.name}`}
                  className="text-xs font-semibold text-danger-ink underline underline-offset-4"
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {foods !== null && foods.length > 0 && (
        <p className="text-[0.6875rem] text-text-dim">
          {/* The one consequence of deleting a recipe that is not obvious, and
              it is a reassuring one. `source_food_id` is ON DELETE SET NULL,
              so the days you ate it keep saying exactly what they said. */}
          Deleting a recipe removes it from your list. Days you have already
          logged it on are untouched — an entry owns its numbers.
        </p>
      )}
    </div>
  );
}
