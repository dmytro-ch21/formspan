"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import {
  listSessions,
  listWorkouts,
  setsFromWorkout,
  SPORTS,
  startSession,
  type Session,
  type Sport,
  type Workout,
} from "@/lib/api";

/**
 * Training history, and the place a freeform session starts.
 *
 * The web half of logging is deliberately *review*-shaped rather than
 * mid-set-shaped: a wide screen is where you look back over a block, spot
 * that the top set stalled three weeks running, and read the numbers you
 * tapped in one-handed at the rack. Starting a session here matters too —
 * a phone left in a locker isn't a reason to lose the log.
 */
export default function SessionsPage() {
  const { getToken } = useAuth();
  const router = useRouter();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [starting, setStarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const [list, mine] = await Promise.all([
        listSessions(getToken, {}, controller.signal),
        listWorkouts(getToken, "mine", controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setSessions(list);
      setWorkouts(mine);
      setEverLoaded(true);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setEverLoaded(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  // A workout means "perform this plan"; no workout means a freeform session.
  // Starting from the plan pre-fills the prescribed sets, so the session opens
  // ready to confirm rather than ready to retype.
  async function start(sport: Sport, label: string, workout?: Workout) {
    if (starting) return;
    setStarting(true);
    try {
      const { session } = await startSession(getToken, {
        sport,
        name: workout ? workout.name : `${label} session`,
        workout_id: workout ? workout.id : null,
        sets: workout ? setsFromWorkout(workout.items) : [],
      });
      router.push(`/dashboard/sessions/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  const live = sessions.filter((s) => s.ended_at === null);
  const done = sessions.filter((s) => s.ended_at !== null);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">History</p>
          <h1 className="font-display text-4xl font-bold">Sessions</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-muted">Start empty:</span>
          {SPORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => start(s.key, s.label)}
              disabled={starting}
              aria-label={`Start an empty ${s.label} session`}
              className="rounded-pill border border-line px-4 py-2 text-sm font-medium transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              {s.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {error}
        </p>
      )}

      {workouts.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="eyebrow">Start from a workout</h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {workouts.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => start(w.sport, w.name, w)}
                  disabled={starting}
                  className="w-full rounded-card border border-line bg-surface px-4 py-3 text-left transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="block truncate font-medium">{w.name}</span>
                  <span className="block truncate text-xs capitalize text-text-dim">
                    {w.sport} · {w.items.length} {w.items.length === 1 ? "exercise" : "exercises"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loading && !everLoaded ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : sessions.length === 0 ? (
        error ? null : (
          <div className="rounded-card border border-dashed border-line px-6 py-16 text-center">
            <p className="font-medium">Nothing logged yet</p>
            <p className="mt-1 text-sm text-text-muted">
              Start an empty session above, or open a{" "}
              <Link href="/dashboard/workouts" className="text-lime underline">
                workout
              </Link>{" "}
              and start from the plan.
            </p>
          </div>
        )
      ) : (
        <>
          {live.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow">In progress</h2>
              <ul className="flex flex-col gap-2">
                {live.map((s) => (
                  <SessionRow key={s.id} session={s} />
                ))}
              </ul>
            </section>
          )}

          {done.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow">Completed</h2>
              <ul className="flex flex-col gap-2">
                {done.map((s) => (
                  <SessionRow key={s.id} session={s} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SessionRow({ session }: { session: Session }) {
  // Warm-ups excluded, matching the backend's own working-volume rule — a
  // number here that disagreed with the one inside the session would be
  // worse than no number.
  const working = session.sets.filter((s) => s.set_type !== "warmup");
  const tonnage = working.reduce(
    (sum, s) => sum + (s.reps ?? 0) * (s.weight_kg ?? 0),
    0,
  );
  const exercises = new Set(session.sets.map((s) => s.exercise_id)).size;

  return (
    <li>
      <Link
        href={`/dashboard/sessions/${session.id}`}
        className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-card border border-line bg-surface px-5 py-4 transition hover:bg-surface-raised"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{session.name || "Session"}</p>
          <p className="truncate text-xs capitalize text-text-dim">
            {session.sport} ·{" "}
            <time dateTime={session.started_at}>
              {new Date(session.started_at).toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
              })}
            </time>
            {session.ended_at === null && " · in progress"}
          </p>
        </div>

        <Metric label="Exercises" value={String(exercises)} />
        <Metric label="Working sets" value={String(working.length)} />
        <Metric label="Tonnage" value={tonnage > 0 ? `${Math.round(tonnage)}kg` : "—"} />
      </Link>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="w-24 shrink-0">
      <p className="stat text-lg">{value}</p>
      <p className="eyebrow text-[0.625rem]">{label}</p>
    </div>
  );
}
