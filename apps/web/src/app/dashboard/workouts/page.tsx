"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import {
  createWorkout,
  GOALS,
  listWorkouts,
  summariseTargets,
  type Goal,
  type Sport,
  type Workout,
  enabledSports,
  labelForModule,
  moduleFor,
} from "@/lib/api";
import { useModules } from "@/lib/ModulesProvider";
import { useUnits } from "@/lib/useUnits";

const SCOPES = [
  { key: "mine", label: "Mine" },
  { key: "shared", label: "Shared" },
] as const;

export default function WorkoutsPage() {
  // For the sport label on each card — the registry carries the acronym.
  const { modules } = useModules();
  const { getToken } = useAuth();
  const { units } = useUnits();
  const router = useRouter();

  const [scope, setScope] = useState<"mine" | "shared">("mine");
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const list = await listWorkouts(getToken, scope, controller.signal);
      if (controller.signal.aborted) return;
      setWorkouts(list);
      setEverLoaded(true);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setEverLoaded(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [getToken, scope]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Templates</p>
          <h1 className="font-display text-4xl font-bold">Workouts</h1>
        </div>
        <button
          type="button"
          onClick={() => setComposing(true)}
          className="rounded-pill bg-accent-fill px-5 py-2.5 text-sm font-bold text-accent-on-fill transition hover:brightness-110"
        >
          New workout
        </button>
      </header>

      <div className="flex gap-1 self-start rounded-pill border border-line p-1">
        {SCOPES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => {
              setScope(s.key);
              setLoading(true);
            }}
            aria-pressed={scope === s.key}
            className={`rounded-pill px-4 py-1.5 text-sm font-medium transition ${
              scope === s.key
                ? "bg-surface-raised text-text"
                : "text-text-muted hover:text-text"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error}
        </p>
      )}

      {loading && !everLoaded ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : workouts.length === 0 ? (
        error ? null : (
          <div className="rounded-card border border-dashed border-line px-6 py-16 text-center">
            <p className="font-medium">
              {scope === "mine" ? "No workouts yet" : "Nothing shared yet"}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              {scope === "mine"
                ? "Build one once, then reuse it every session."
                : "Workouts other people publish appear here."}
            </p>
          </div>
        )
      ) : (
        // Cards rather than a table: the count is small and each card can
        // preview its first movements, which is what actually tells them
        // apart at a glance. A table would sort well and read poorly.
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {workouts.map((w) => (
            <li key={w.id}>
              <Link
                href={`/dashboard/workouts/${w.id}`}
                className="group flex h-full flex-col gap-3 rounded-card border border-line bg-surface p-5 transition hover:bg-surface-raised"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-display text-2xl font-semibold leading-tight">
                    {w.name}
                  </h2>
                  {w.visibility === "public" && (
                    <span className="eyebrow shrink-0 rounded-pill border border-lime/40 px-2 py-0.5 text-lime">
                      Shared
                    </span>
                  )}
                </div>

                <p className="text-sm capitalize text-text-muted">
                  {labelForModule(modules, w.sport)}
                  {w.goal
                    ? ` · ${GOALS.find((g) => g.key === w.goal)?.label}`
                    : ""}
                </p>

                {w.items.length > 0 ? (
                  <ul className="mt-auto flex flex-col gap-1 border-t border-line-soft pt-3">
                    {w.items.slice(0, 3).map((it, i) => (
                      <li
                        key={i}
                        className="flex justify-between gap-3 text-xs text-text-dim"
                      >
                        <span className="truncate">
                          {it.exercise_id.replace(/-/g, " ")}
                        </span>
                        <span className="stat shrink-0">
                          {summariseTargets(it, units)}
                        </span>
                      </li>
                    ))}
                    {w.items.length > 3 && (
                      <li className="text-xs text-text-dim">
                        +{w.items.length - 3} more
                      </li>
                    )}
                  </ul>
                ) : (
                  <p className="mt-auto border-t border-line-soft pt-3 text-xs text-text-dim">
                    Empty — add exercises
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {composing && (
        <NewWorkoutDialog
          onClose={() => setComposing(false)}
          onCreated={(w) => {
            // Straight into the editor: creating a template is never the
            // goal, filling it is.
            router.push(`/dashboard/workouts/${w.id}`);
          }}
        />
      )}
    </div>
  );
}

function NewWorkoutDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (w: Workout) => void;
}) {
  const { modules } = useModules();
  const startable = enabledSports(modules);
  const { getToken } = useAuth();
  const [name, setName] = useState("");
  // The athlete's first enabled discipline, not a hardcoded "strength".
  // Hardcoded, a strength-disabled athlete got no active chip and silently
  // created strength workouts anyway — the backend validates registry
  // membership, not per-user enablement, so nothing caught it.
  const [sport, setSport] = useState<Sport>(startable[0]?.key ?? "");
  const [goal, setGoal] = useState<Goal>("general");
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const w = await createWorkout(getToken, {
        name: name.trim(),
        sport,
        // Goal is meaningful only for strength.
        // Capability, not a sport name.
        goal: moduleFor(modules, sport)?.capabilities.has_goals ? goal : null,
        visibility: isPublic ? "public" : "private",
      });
      onCreated(w);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    /*
      Two nested elements rather than one centred flex box, and both parts are
      load-bearing on a phone.

      `overflow-y-auto` on the OUTER element is what lets the dialog be reached
      when the soft keyboard is up: `fixed inset-0` sizes to the layout
      viewport, which iOS Safari does not shrink for the keyboard, so a dialog
      centred in it sits partly behind the keyboard with nothing to scroll —
      the Goal field below the autofocused Name field was simply unreachable.

      The centring then moves to an INNER `min-h-full` flex box instead of onto
      the scroll container, because `items-center` on a scrolling element clips
      its own overflow at the top: once the content is taller than the
      viewport, the part above the centre line becomes unscrollable. That is
      the classic centred-modal bug, and it only appears on the small screens
      this is being fixed for.
    */
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/70"
      onClick={onClose}
      role="presentation"
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <form
          onSubmit={submit}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-workout-title"
          className="flex w-full max-w-md flex-col gap-5 rounded-card border border-line bg-surface p-6"
        >
          <h2 id="new-workout-title" className="font-display text-2xl font-bold">
            New workout
          </h2>

          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Name</span>
            {/* Autofocused deliberately: the dialog exists only to fill this
                field, so landing anywhere else would cost a click. */}
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Push Day A"
              className="rounded-card border border-line bg-bg px-3 py-2.5 outline-none placeholder:text-text-dim focus:border-lime"
            />
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="eyebrow mb-1.5">Discipline</legend>
            <div className="flex flex-wrap gap-2">
              {startable.map((s) => (
                <Chip
                  key={s.key}
                  active={sport === s.key}
                  onClick={() => setSport(s.key)}
                >
                  {s.label}
                </Chip>
              ))}
            </div>
            <p className="mt-1 text-xs text-text-dim">
              One discipline per workout — that&apos;s what lets the catalog show
              only what fits.
            </p>
          </fieldset>

          {moduleFor(modules, sport)?.capabilities.has_goals && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="eyebrow mb-1.5">Goal</legend>
              <div className="flex flex-wrap gap-2">
                {GOALS.map((g) => (
                  <Chip
                    key={g.key}
                    active={goal === g.key}
                    onClick={() => setGoal(g.key)}
                  >
                    {g.label}
                  </Chip>
                ))}
              </div>
            </fieldset>
          )}

          <label className="flex cursor-pointer items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Share publicly</span>
              <span className="block text-xs text-text-dim">
                Anyone can view it. You stay the only editor.
              </span>
            </span>
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="h-5 w-5 accent-lime"
            />
          </label>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-muted hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim() || !sport}
              className="rounded-pill bg-accent-fill px-5 py-2 text-sm font-bold text-accent-on-fill transition disabled:cursor-not-allowed disabled:opacity-30"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-pill border px-4 py-1.5 text-sm font-medium transition ${
        active
          ? "border-lime bg-lime/10 text-lime"
          : "border-line text-text-muted hover:border-line hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
