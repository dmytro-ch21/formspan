"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { listExercises, pickImage, SPORTS, type Exercise } from "@/lib/api";

const LOAD_LABEL: Record<Exercise["load_type"], string> = {
  weight_reps: "Weight × reps",
  reps: "Reps",
  time: "Time",
  distance: "Distance",
  distance_time: "Distance & time",
};

/**
 * The exercise catalog on desktop — 524 entries, previously reachable only
 * from the phone.
 *
 * A grid rather than the phone's list, and a detail panel rather than a
 * push-navigation: on a wide screen you can browse and read at the same
 * time, so selecting an exercise shouldn't cost you your place in the list.
 * Coaching notes live in that panel, which is the one thing a big screen is
 * genuinely better at than a phone mid-set.
 */
export default function LibraryPage() {
  const { getToken } = useAuth();

  const [sport, setSport] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Exercise[]>([]);
  const [selected, setSelected] = useState<Exercise | null>(null);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const list = await listExercises(
          getToken,
          { sport: sport || undefined, q: query.trim() || undefined },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResults(list);
        setEverLoaded(true);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setEverLoaded(true);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [getToken, sport, query]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Reference</p>
          <h1 className="font-display text-4xl font-bold">Library</h1>
        </div>
        <p className="stat text-sm text-text-dim">
          {everLoaded ? `${results.length} shown` : ""}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={100}
            placeholder="Search exercises"
            aria-label="Search exercises by name"
            className="w-full rounded-card border border-line bg-surface px-4 py-2.5 pr-10 text-sm outline-none placeholder:text-text-dim focus:border-lime"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-line px-1.5 py-0.5 text-[0.625rem] text-text-dim">
            /
          </kbd>
        </div>
        <div className="flex gap-2">
          <Chip active={sport === ""} onClick={() => setSport("")}>
            All
          </Chip>
          {SPORTS.map((s) => (
            <Chip key={s.key} active={sport === s.key} onClick={() => setSport(s.key)}>
              {s.label}
            </Chip>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {error}
        </p>
      )}

      <div className={selected ? "grid gap-6 lg:grid-cols-[1fr_22rem]" : ""}>
        {everLoaded && results.length === 0 && !error ? (
          <p className="text-sm text-text-muted">No exercises match this filter.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((e) => {
              const image = pickImage(e, "thumbnail");
              const active = selected?.id === e.id;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(active ? null : e)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-3 rounded-card border p-3 text-left transition ${
                      active
                        ? "border-lime bg-surface-raised"
                        : "border-line bg-surface hover:bg-surface-raised"
                    }`}
                  >
                    {image ? (
                      // eslint-disable-next-line @next/next/no-img-element -- remote R2 host
                      <img
                        src={image}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-lg bg-surface-raised object-cover"
                      />
                    ) : (
                      <div className="h-14 w-14 shrink-0 rounded-lg bg-surface-raised" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{e.name}</span>
                      <span className="block truncate text-xs capitalize text-text-dim">
                        {e.movement_pattern.replace(/_/g, " ")} · {LOAD_LABEL[e.load_type]}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selected && <DetailPanel exercise={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

function DetailPanel({ exercise, onClose }: { exercise: Exercise; onClose: () => void }) {
  const image = pickImage(exercise, "demo");
  const isPlaceholder = exercise.media.every((m) => m.is_default);

  return (
    <aside className="flex h-fit flex-col gap-4 rounded-card border border-line bg-surface p-5 lg:sticky lg:top-10">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-2xl font-semibold leading-tight">{exercise.name}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="shrink-0 text-text-dim hover:text-text"
        >
          ✕
        </button>
      </div>

      {image && (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote R2 host */}
          <img src={image} alt={exercise.name} className="w-full rounded-lg bg-surface-raised object-contain" />
          {isPlaceholder && (
            // Saying so matters: 463 of 523 entries have no photo of their
            // own, and a placeholder that passes for the real thing makes
            // that gap invisible and therefore permanent.
            <span className="absolute bottom-2 left-2 rounded-pill bg-black/70 px-2 py-0.5 text-[0.625rem] text-text-muted">
              Placeholder image
            </span>
          )}
        </div>
      )}

      <dl className="flex flex-col gap-2 text-sm">
        <Row label="Pattern">
          {exercise.movement_pattern_detail || exercise.movement_pattern.replace(/_/g, " ")}
        </Row>
        <Row label="Tracks">{LOAD_LABEL[exercise.load_type]}</Row>
        {exercise.is_unilateral && <Row label="Sides">Per side</Row>}
        {exercise.equipment.length > 0 && (
          <Row label="Equipment">{exercise.equipment.join(", ").replace(/-/g, " ")}</Row>
        )}
        {exercise.primary_muscles.length > 0 && (
          <Row label="Primary">{exercise.primary_muscles.join(", ").replace(/-/g, " ")}</Row>
        )}
      </dl>

      {exercise.instructions ? (
        <p className="border-t border-line-soft pt-4 text-sm leading-relaxed text-text-muted">
          {exercise.instructions}
        </p>
      ) : (
        <p className="border-t border-line-soft pt-4 text-sm text-text-dim">
          No coaching notes yet.
        </p>
      )}
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-right capitalize text-text-muted">{children}</dd>
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
        active ? "border-lime bg-lime/10 text-lime" : "border-line text-text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
