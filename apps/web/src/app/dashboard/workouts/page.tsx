"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { newTraceId, traceparent } from "@/lib/trace";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

type Workout = {
  id: string;
  owner_user_id: string | null;
  name: string;
  sport: string;
  goal: string | null;
  visibility: "private" | "public";
  items: { exercise_id: string }[];
  updated_at: string;
};

const UTC_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const SCOPES = [
  { key: "mine", label: "My workouts" },
  { key: "shared", label: "Shared" },
] as const;

/**
 * Desktop is the planning surface — see the mobile-first split in
 * docs/decisions/system-design.md. So this leads with a scannable table
 * (sortable-by-eye, everything visible at once) rather than the card list
 * the phone uses, and it's read-oriented: building a workout is a
 * one-hand-on-the-bar job that belongs on the phone.
 */
export default function WorkoutsPage() {
  const { getToken } = useAuth();
  const [traceId] = useState(newTraceId);

  const [scope, setScope] = useState<"mine" | "shared">("mine");
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in.");
      const res = await fetch(`${API_BASE}/workouts?scope=${scope}`, {
        headers: { Authorization: `Bearer ${token}`, traceparent: traceparent(traceId) },
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `API responded ${res.status}`);
      if (!controller.signal.aborted) {
        setWorkouts(body.workouts ?? []);
        setEverLoaded(true);
        // Cleared on success rather than at the start of the request: an
        // error wiped up front leaves the screen claiming everything is
        // fine for the whole duration of a retry that may also fail.
        setError(null);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      // Otherwise the empty state would claim there are no workouts when we
      // simply failed to find out.
      setEverLoaded(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [getToken, scope, traceId]);

  useEffect(() => {
    // `load` is async and every setState in it happens after an await, so
    // none runs synchronously during this effect. The rule flags any call
    // to a setState-containing function and can't see past it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Workouts</h1>
          <p className="text-sm text-neutral-500">
            Templates you reuse each session. Build and edit them on the phone — this is
            the overview.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-neutral-300 p-1">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                setScope(s.key);
                setLoading(true);
              }}
              aria-pressed={scope === s.key}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                scope === s.key
                  ? "bg-brand-navy text-brand-lime"
                  : "text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading && !everLoaded ? (
        <p className="text-sm text-neutral-500">Loading workouts…</p>
      ) : workouts.length === 0 ? (
        error ? null : (
          <div className="rounded-xl border border-dashed border-neutral-300 px-6 py-12 text-center">
            <p className="font-medium">
              {scope === "mine" ? "No workouts yet" : "Nothing shared yet"}
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              {scope === "mine"
                ? "Create one in the mobile app — it takes about a minute."
                : "Workouts other people publish will show up here."}
            </p>
          </div>
        )
      ) : (
        // Scrolls inside its own container so the page body never scrolls
        // sideways on a narrow window.
        <div className="overflow-x-auto rounded-xl border border-neutral-200">
          <table className="w-full min-w-[42rem] border-collapse text-sm">
            <caption className="sr-only">
              {scope === "mine" ? "Your workouts" : "Workouts shared with you"}
            </caption>
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left">
                <th scope="col" className="px-4 py-3 font-semibold">Name</th>
                <th scope="col" className="px-4 py-3 font-semibold">Discipline</th>
                <th scope="col" className="px-4 py-3 font-semibold">Goal</th>
                <th scope="col" className="px-4 py-3 font-semibold">Exercises</th>
                <th scope="col" className="px-4 py-3 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {workouts.map((w) => (
                <tr key={w.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                  <th scope="row" className="px-4 py-3 text-left font-medium">
                    <Link href={`/dashboard/workouts/${w.id}`} className="hover:underline">
                      {w.name}
                    </Link>
                    {w.visibility === "public" && (
                      <span className="ml-2 rounded-full bg-lime-100 px-2 py-0.5 text-xs font-semibold text-lime-800">
                        Shared
                      </span>
                    )}
                    {w.owner_user_id === null && (
                      <span className="ml-2 text-xs text-neutral-500">VOLA template</span>
                    )}
                  </th>
                  <td className="px-4 py-3 capitalize text-neutral-600">{w.sport}</td>
                  <td className="px-4 py-3 capitalize text-neutral-600">{w.goal ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-600">{w.items.length}</td>
                  <td className="px-4 py-3 text-neutral-600">
                    {UTC_FORMAT.format(new Date(w.updated_at))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
