"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import { listWorkouts, type Workout } from "@/lib/api";
import { newTraceId, traceparent } from "@/lib/trace";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

type Activity = { id: string; kind: string; occurred_at: string; notes: string | null };

// Fixed locale and zone: the default resolves differently during SSR than in
// the browser, which mismatches on hydration.
const DAY = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

export default function TodayPage() {
  const { getToken } = useAuth();
  const [traceId] = useState(newTraceId);
  // Captured once rather than read during render: Date.now() in the render
  // body is impure, and it also resolves differently on the server than in
  // the browser, which is a hydration mismatch waiting to happen.
  const [mountedAt] = useState(() => Date.now());

  const [activities, setActivities] = useState<Activity[]>([]);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
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
      const res = await fetch(`${API_BASE}/activities`, {
        headers: { Authorization: `Bearer ${token}`, traceparent: traceparent(traceId) },
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `API responded ${res.status}`);
      const mine = await listWorkouts(getToken, "mine", controller.signal);
      if (controller.signal.aborted) return;
      setActivities(body.activities ?? []);
      setWorkouts(mine);
      setEverLoaded(true);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setEverLoaded(true);
    }
  }, [getToken, traceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const thisWeek = activities.filter(
    (a) => mountedAt - new Date(a.occurred_at).getTime() < 7 * 864e5,
  ).length;

  return (
    <div className="flex flex-col gap-10">
      <header>
        <p className="eyebrow">Today</p>
        <h1 className="font-display text-4xl font-bold">Overview</h1>
      </header>

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {error}
        </p>
      )}

      {/* Real counts only. The Readiness/Load/Fuel dials from the design doc
          need data we don't collect yet, and a placeholder dial would be a
          fabricated number on the one screen that must never lie. */}
      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="Sessions this week" value={everLoaded ? String(thisWeek) : "—"} />
        <Stat label="Logged all time" value={everLoaded ? String(activities.length) : "—"} />
        <Stat label="Your templates" value={everLoaded ? String(workouts.length) : "—"} />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="eyebrow">Recent activity</h2>
          <Link href="/dashboard/workouts" className="text-sm text-text-muted hover:text-text">
            Workouts →
          </Link>
        </div>

        {!everLoaded ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : activities.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
            <p className="font-medium">Nothing logged yet</p>
            <p className="mt-1 text-sm text-text-muted">
              Log a session in the mobile app — it syncs here automatically.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {activities.slice(0, 8).map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-4 rounded-card border border-line bg-surface px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium capitalize">{a.kind.replace(/_/g, " ")}</p>
                  <p className="truncate text-sm text-text-dim">{a.notes ?? "No notes"}</p>
                </div>
                <span className="stat shrink-0 text-sm text-text-muted">
                  {DAY.format(new Date(a.occurred_at))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface p-5">
      <span aria-hidden="true" className="accent-rule absolute inset-x-0 top-0 h-[2px]" />
      <p className="eyebrow">{label}</p>
      <p className="stat mt-1 text-5xl">{value}</p>
    </div>
  );
}
