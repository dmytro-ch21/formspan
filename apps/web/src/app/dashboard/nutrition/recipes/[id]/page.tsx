"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import { listFoods, type Food } from "@/lib/nutritionApi";
import { RecipeEditor } from "../RecipeEditor";

/**
 * Editing an existing recipe.
 *
 * The row is found in the athlete's own list rather than fetched by id,
 * because there is no `GET /nutrition/foods/{id}` route — the repository has a
 * `GetFood` but nothing exposes it. Reading the list is one request either way
 * for a cap of 200 rows, so this is a cheaper answer than adding an endpoint
 * and a contract entry for a screen that already has the data it needs.
 *
 * A missing id says so rather than rendering an empty form, which would look
 * like a new recipe and silently create a second one on save.
 */
export default function EditRecipePage() {
  const { getToken } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [food, setFood] = useState<Food | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    try {
      const all = await listFoods(getToken, "", c.signal);
      if (c.signal.aborted) return;
      const match = all.find((f) => f.id === id && f.kind === "recipe");
      setFood(match ?? null);
      setState(match ? "ready" : "missing");
    } catch (e) {
      if (c.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Could not load that recipe.");
      setState("error");
    }
  }, [getToken, id]);

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

  if (state === "loading") return <p className="text-sm text-text-dim">Loading…</p>;
  if (state === "error") {
    return (
      <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-danger-ink">
        {error}
      </p>
    );
  }
  if (state === "missing" || !food) {
    return (
      <p className="rounded-card border border-line bg-surface p-4 text-sm text-text-muted">
        That recipe is not in your list. It may have been deleted from another
        device.
      </p>
    );
  }
  return <RecipeEditor existing={food} />;
}
