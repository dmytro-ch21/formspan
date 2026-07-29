"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { newTraceId, traceparent } from "@/lib/trace";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

type Media = { kind: string; url: string; is_default: boolean };
type Exercise = {
  id: string;
  name: string;
  movement_pattern: string;
  equipment: string[];
  load_type: string;
  is_unilateral: boolean;
  instructions: string;
  media: Media[];
};
type WorkoutItem = {
  exercise_id: string;
  position: number;
  target_sets: number | null;
  target_reps: number | null;
  target_weight_kg: number | null;
  target_seconds: number | null;
  target_distance_m: number | null;
  notes: string;
};
type Workout = {
  id: string;
  owner_user_id: string | null;
  name: string;
  sport: string;
  goal: string | null;
  notes: string;
  visibility: "private" | "public";
  items: WorkoutItem[];
};

function summarise(i: WorkoutItem): string {
  const parts: string[] = [];
  if (i.target_sets && i.target_reps) parts.push(`${i.target_sets} × ${i.target_reps}`);
  else if (i.target_sets) parts.push(`${i.target_sets} sets`);
  else if (i.target_reps) parts.push(`${i.target_reps} reps`);
  if (i.target_weight_kg) parts.push(`${i.target_weight_kg} kg`);
  if (i.target_seconds) {
    const m = Math.floor(i.target_seconds / 60);
    const s = i.target_seconds % 60;
    parts.push(m ? `${m}m${s ? ` ${s}s` : ""}` : `${s}s`);
  }
  if (i.target_distance_m) {
    parts.push(
      i.target_distance_m >= 1000
        ? `${(i.target_distance_m / 1000).toFixed(1)} km`
        : `${i.target_distance_m} m`,
    );
  }
  return parts.join(" · ") || "No targets set";
}

/**
 * The read view a bigger screen is actually better at: every exercise, its
 * targets, and its coaching notes visible at once — which is the thing you
 * want the night before, not mid-session on a phone.
 */
export default function WorkoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const [traceId] = useState(newTraceId);

  const [workout, setWorkout] = useState<Workout | null>(null);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in.");
      const headers = { Authorization: `Bearer ${token}`, traceparent: traceparent(traceId) };

      const res = await fetch(`${API_BASE}/workouts/${encodeURIComponent(id)}`, {
        headers,
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `API responded ${res.status}`);
      const w = body as Workout;

      // One catalog request for the workout's sport, rather than one per
      // item — the list is short but the N+1 would grow with the template.
      const exRes = await fetch(`${API_BASE}/exercises?sport=${encodeURIComponent(w.sport)}`, {
        headers,
        signal: controller.signal,
      });
      const exBody = await exRes.json().catch(() => null);
      if (!exRes.ok) throw new Error(exBody?.error?.message ?? `API responded ${exRes.status}`);

      if (!controller.signal.aborted) {
        setWorkout(w);
        setCatalog(new Map((exBody.exercises as Exercise[]).map((e) => [e.id, e])));
        setError(null);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [getToken, id, traceId]);

  useEffect(() => {
    // `load` is async and every setState in it happens after an await, so
    // none runs synchronously during this effect. The rule flags any call
    // to a setState-containing function and can't see past it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  if (loading) return <p className="text-sm text-neutral-500">Loading workout…</p>;

  if (!workout) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? "Workout not found."}
        </p>
        <Link href="/dashboard/workouts" className="text-sm font-medium hover:underline">
          ← Back to workouts
        </Link>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard/workouts" className="text-sm text-neutral-500 hover:underline">
          ← Workouts
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{workout.name}</h1>
        <p className="text-sm capitalize text-neutral-500">
          {workout.sport}
          {workout.goal ? ` · ${workout.goal}` : ""}
          {workout.visibility === "public" ? " · shared" : ""}
          {` · ${workout.items.length} ${workout.items.length === 1 ? "exercise" : "exercises"}`}
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {workout.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 px-6 py-12 text-center">
          <p className="font-medium">No exercises yet</p>
          <p className="mt-1 text-sm text-neutral-500">Add them in the mobile app.</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {workout.items.map((item, index) => {
            const ex = catalog.get(item.exercise_id);
            const image = ex?.media.find((m) => m.kind === "thumbnail" && m.url)?.url;
            return (
              <li
                key={`${item.exercise_id}-${index}`}
                className="flex gap-4 rounded-xl border border-neutral-200 p-4"
              >
                <span className="w-5 shrink-0 pt-1 text-right text-sm font-bold text-neutral-400">
                  {index + 1}
                </span>
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- remote R2 host, not configured for next/image
                  <img
                    src={image}
                    alt=""
                    width={64}
                    height={64}
                    className="h-16 w-16 shrink-0 rounded-lg bg-neutral-100 object-cover"
                  />
                ) : (
                  <div className="h-16 w-16 shrink-0 rounded-lg bg-neutral-100" />
                )}
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="font-semibold">{ex?.name ?? item.exercise_id}</p>
                  <p className="text-sm text-neutral-600">{summarise(item)}</p>
                  {ex && (
                    <p className="text-xs capitalize text-neutral-500">
                      {ex.movement_pattern.replace(/_/g, " ")}
                      {ex.is_unilateral ? " · per side" : ""}
                      {ex.equipment.length ? ` · ${ex.equipment.join(", ").replace(/-/g, " ")}` : ""}
                    </p>
                  )}
                  {/* The reason a big screen earns its place: coaching notes
                      are unreadable on a phone mid-set but useful the night
                      before. Only 60 of 523 exercises have them so far. */}
                  {ex?.instructions ? (
                    <p className="mt-1 text-sm text-neutral-600">{ex.instructions}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
