"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import {
  applySuggestions,
  deleteWorkout,
  fetchSuggestions,
  emptyItem,
  FIELD_KEY,
  FIELD_LABEL,
  getWorkout,
  listExercises,
  pickImage,
  replaceItems,
  setsFromWorkout,
  startSession,
  targetFieldsFor,
  type Exercise,
  type TargetField,
  type Workout,
  type WorkoutItem,
} from "@/lib/api";
import {
  formatWeight,
  fromDisplayWeight,
  toDisplayWeight,
  weightUnit,
  type UnitSystem,
} from "@/lib/units";
import { useUnits } from "@/lib/useUnits";

/**
 * The workout editor, built for a mouse and a keyboard rather than as a
 * widened phone screen.
 *
 * Two panes: the template on the left, the catalog on the right. On a phone
 * adding an exercise has to be a modal — there isn't room for both — and
 * that modal costs an open/search/pick/close cycle per exercise. Here the
 * catalog is simply *always visible*, so building an eight-movement session
 * is eight clicks with the list never leaving view. That difference is the
 * whole argument for authoring on desktop.
 *
 * Targets are edited inline in the row rather than behind a disclosure, for
 * the same reason: a wide row has space for the inputs, so nothing needs
 * hiding.
 */
export default function WorkoutEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken, userId } = useAuth();
  const router = useRouter();

  const [workout, setWorkout] = useState<Workout | null>(null);
  const [items, setItems] = useState<WorkoutItem[]>([]);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [starting, setStarting] = useState(false);
  const { units } = useUnits();
  const abortRef = useRef<AbortController | null>(null);

  const canEdit =
    workout !== null && workout.owner_user_id !== null && workout.owner_user_id === userId;

  const dirty = useMemo(
    () => workout !== null && JSON.stringify(items) !== JSON.stringify(workout.items),
    [items, workout],
  );

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const w = await getWorkout(getToken, id, controller.signal);
      // One catalog request for the sport rather than one per item.
      const list = await listExercises(getToken, { sport: w.sport }, controller.signal);
      if (controller.signal.aborted) return;
      setWorkout(w);
      setItems(w.items);
      setCatalog(new Map(list.map((e) => [e.id, e])));
      setEverLoaded(true);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setEverLoaded(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [getToken, id]);

  useEffect(() => {
    // `load` is async; every setState in it runs after an await, so none is
    // synchronous within this effect. The rule can't see past the call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const updated = await replaceItems(getToken, id, items);
      setWorkout(updated);
      setItems(updated.items);
      setSavedOnce(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [dirty, getToken, id, items, saving]);

  // Cmd/Ctrl-S. On a page whose entire job is editing, the browser's own
  // "save page" is never what someone means by that chord.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Closing the tab mid-edit loses the work silently otherwise.
  useEffect(() => {
    if (!dirty) return;
    function warn(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // A template is only worth writing if performing it is one click away.
  // The session opens pre-filled with the prescribed sets, so the plan is
  // what you start from and then change — which is what makes the gap
  // between prescribed and actual measurable at all.
  async function start() {
    if (starting || !workout) return;
    setStarting(true);
    try {
      let sets = setsFromWorkout(items);
      try {
        // Where the plan is silent on weight, last time's is the sensible
        // starting point. A failed lookup mustn't block the session.
        sets = applySuggestions(
          sets,
          await fetchSuggestions(getToken, sets.map((x) => x.exercise_id)),
        );
      } catch {
        /* start anyway */
      }
      const { session } = await startSession(getToken, {
        sport: workout.sport,
        name: workout.name,
        workout_id: workout.id,
        sets,
      });
      router.push(`/dashboard/sessions/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  function addExercise(e: Exercise) {
    setCatalog((c) => (c.has(e.id) ? c : new Map(c).set(e.id, e)));
    setItems((prev) => [...prev, emptyItem(e.id, prev.length)]);
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next.map((it, i) => ({ ...it, position: i })));
  }

  if (loading && !everLoaded) {
    return <p className="text-sm text-text-muted">Loading workout…</p>;
  }

  if (!workout) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {error ?? "Workout not found."}
        </p>
        <Link href="/dashboard/workouts" className="text-sm text-text-muted hover:text-text">
          ← Back to workouts
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/dashboard/workouts" className="eyebrow hover:text-text-muted">
            ← Workouts
          </Link>
          <h1 className="mt-1 font-display text-4xl font-bold">{workout.name}</h1>
          <p className="mt-1 text-sm capitalize text-text-muted">
            {workout.sport}
            {workout.goal ? ` · ${workout.goal}` : ""}
            {workout.visibility === "public" ? " · shared" : ""}
            {` · ${items.length} ${items.length === 1 ? "exercise" : "exercises"}`}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {canEdit && (
            <>
              {/* A status line rather than a toast: it stays put, so it can be
                  read at a glance without having caught it appearing. */}
              <span aria-live="polite" className="text-sm text-text-muted">
                {saving ? "Saving…" : dirty ? "Unsaved changes" : savedOnce ? "Saved" : ""}
              </span>
              <button
                type="button"
                onClick={save}
                disabled={!dirty || saving}
                className="rounded-pill border border-line px-5 py-2 text-sm font-bold transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-30"
              >
                Save
              </button>
            </>
          )}
          <button
            type="button"
            onClick={start}
            // Starting with unsaved edits would log the plan as the server
            // holds it, not as it reads on screen.
            disabled={starting || dirty || items.length === 0}
            title={dirty ? "Save your changes first" : undefined}
            className="rounded-pill bg-accent-fill px-5 py-2 text-sm font-bold text-accent-on-fill transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {starting ? "Starting…" : "Start session"}
          </button>
        </div>
      </header>

      {!canEdit && (
        <p className="rounded-card border border-line bg-surface px-4 py-3 text-sm text-text-muted">
          {workout.owner_user_id === null
            ? "A VOLA template — view only."
            : "Shared by someone else — view only."}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {error}
        </p>
      )}

      <div className={`grid gap-6 ${canEdit ? "lg:grid-cols-[1fr_21rem]" : ""}`}>
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="eyebrow">The session</h2>
          {items.length === 0 ? (
            <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
              <p className="font-medium">Nothing in this workout yet</p>
              <p className="mt-1 text-sm text-text-muted">
                {canEdit ? "Pick exercises from the catalog on the right." : "This workout is empty."}
              </p>
            </div>
          ) : (
            <ol className="flex flex-col gap-2">
              {items.map((item, index) => (
                <ItemRow
                  key={`${item.exercise_id}-${index}`}
                  item={item}
                  index={index}
                  total={items.length}
                  exercise={catalog.get(item.exercise_id)}
                  editable={canEdit}
                  units={units}
                  onChange={(next) => setItems(items.map((it, i) => (i === index ? next : it)))}
                  onMoveTo={(to) => move(index, to)}
                  onDropFrom={(from) => move(from, index)}
                  onRemove={() =>
                    setItems(items.filter((_, i) => i !== index).map((it, i) => ({ ...it, position: i })))
                  }
                />
              ))}
            </ol>
          )}

          {canEdit && (
            <button
              type="button"
              onClick={async () => {
                if (!confirm(`Delete "${workout.name}"? This can't be undone.`)) return;
                try {
                  await deleteWorkout(getToken, id);
                  router.push("/dashboard/workouts");
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
              className="mt-6 self-start text-sm text-danger hover:underline"
            >
              Delete workout
            </button>
          )}
        </section>

        {canEdit && <CatalogPane sport={workout.sport} onAdd={addExercise} />}
      </div>
    </div>
  );
}

function ItemRow({
  item,
  index,
  total,
  exercise,
  editable,
  units,
  onChange,
  onMoveTo,
  onDropFrom,
  onRemove,
}: {
  item: WorkoutItem;
  index: number;
  total: number;
  exercise: Exercise | undefined;
  editable: boolean;
  units: UnitSystem;
  onChange: (next: WorkoutItem) => void;
  onMoveTo: (to: number) => void;
  onDropFrom: (from: number) => void;
  onRemove: () => void;
}) {
  const image = exercise ? pickImage(exercise, "thumbnail") : null;
  const fields: TargetField[] = exercise ? targetFieldsFor(exercise.load_type) : [];

  return (
    <li
      // Native HTML5 drag: no dependency, and it's the pointer affordance
      // people expect on desktop. Keyboard users get the arrow buttons —
      // which is why both exist rather than drag alone.
      draggable={editable}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(index))}
      onDragOver={(e) => {
        if (editable) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!editable) return;
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        if (Number.isFinite(from)) onDropFrom(from);
      }}
      className="group flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3 transition hover:bg-surface-raised"
    >
      <span className="stat w-6 shrink-0 text-center text-lg text-text-dim">{index + 1}</span>

      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote R2 host, not configured for next/image
        <img src={image} alt="" className="h-14 w-14 shrink-0 rounded-lg bg-surface-raised object-cover" />
      ) : (
        <div className="h-14 w-14 shrink-0 rounded-lg bg-surface-raised" />
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{exercise?.name ?? item.exercise_id}</p>
        <p className="truncate text-xs capitalize text-text-dim">
          {exercise?.movement_pattern.replace(/_/g, " ")}
          {exercise?.is_unilateral ? " · per side" : ""}
        </p>
      </div>

      {editable ? (
        <div className="flex shrink-0 items-end gap-2">
          {fields.map((f) => {
            const label = f === "weight" ? weightUnit(units) : FIELD_LABEL[f];
            const stored = item[FIELD_KEY[f]] as number | null;
            // Shown in the athlete's units, stored in kilograms — the same
            // rule the session logger follows, so a template written in
            // pounds and performed in kilograms is still the same plan.
            const shown =
              stored == null ? "" : f === "weight" ? toDisplayWeight(stored, units) : stored;
            return (
              <label key={f} className="flex flex-col gap-1">
                <span className="eyebrow text-[0.625rem]">{label}</span>
                <input
                  type="number"
                  min={0}
                  step={f === "weight" ? 0.5 : 1}
                  inputMode={f === "weight" ? "decimal" : "numeric"}
                  aria-label={`${label} for ${exercise?.name ?? "exercise"}`}
                  value={shown}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const n = raw === "" ? null : Number(raw);
                    if (n === null || !Number.isFinite(n)) {
                      onChange({ ...item, [FIELD_KEY[f]]: null });
                      return;
                    }
                    onChange({
                      ...item,
                      [FIELD_KEY[f]]: f === "weight" ? fromDisplayWeight(n, units) : Math.round(n),
                    });
                  }}
                  placeholder="—"
                  className="stat w-16 rounded-lg border border-line bg-bg px-2 py-1.5 text-center text-base outline-none focus:border-lime"
                />
              </label>
            );
          })}
        </div>
      ) : (
        <span className="stat shrink-0 text-sm text-text-muted">{targetSummary(item, units)}</span>
      )}

      {editable && (
        // Revealed on hover so the row stays calm at rest, but never hidden
        // from keyboard users.
        <div className="flex shrink-0 gap-1 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton label="Move up" onClick={() => onMoveTo(index - 1)} disabled={index === 0}>
            ↑
          </IconButton>
          <IconButton label="Move down" onClick={() => onMoveTo(index + 1)} disabled={index === total - 1}>
            ↓
          </IconButton>
          <IconButton label={`Remove ${exercise?.name ?? "exercise"}`} onClick={onRemove} danger>
            ✕
          </IconButton>
        </div>
      )}
    </li>
  );
}

function targetSummary(i: WorkoutItem, units: UnitSystem): string {
  const p: string[] = [];
  if (i.target_sets && i.target_reps) p.push(`${i.target_sets}×${i.target_reps}`);
  if (i.target_weight_kg) p.push(formatWeight(i.target_weight_kg, units));
  if (i.target_seconds) p.push(`${i.target_seconds}s`);
  if (i.target_distance_m) p.push(`${i.target_distance_m}m`);
  return p.join(" · ") || "—";
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg border border-line text-sm transition hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-25 ${
        danger ? "text-danger" : "text-text-muted"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The always-visible catalog — the reason authoring belongs on desktop.
 * Search and results stay on screen while the template fills up, so adding
 * eight movements is eight clicks rather than eight modal round-trips.
 */
function CatalogPane({ sport, onAdd }: { sport: string; onAdd: (e: Exercise) => void }) {
  const { getToken } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Exercise[]>([]);
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
          { sport, q: query.trim() || undefined },
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

  // "/" to jump to search — the convention anywhere with a prominent filter.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className="flex h-fit flex-col gap-3 lg:sticky lg:top-10">
      <div className="flex items-baseline justify-between">
        <h2 className="eyebrow">Catalog · {sport}</h2>
        <kbd className="rounded border border-line px-1.5 py-0.5 text-[0.625rem] text-text-dim">/</kbd>
      </div>

      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        maxLength={100}
        placeholder={`Search ${sport} exercises`}
        aria-label={`Search ${sport} exercises`}
        className="rounded-card border border-line bg-surface px-3 py-2.5 text-sm outline-none placeholder:text-text-dim focus:border-lime"
      />

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {/* Only this pane scrolls, so the template beside it never moves. */}
      <ul className="flex max-h-[34rem] flex-col gap-1 overflow-y-auto pr-1">
        {results.map((e) => {
          const image = pickImage(e, "thumbnail");
          return (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onAdd(e)}
                aria-label={`Add ${e.name}`}
                className="flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left transition hover:border-line hover:bg-surface-raised"
              >
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- remote R2 host
                  <img src={image} alt="" className="h-9 w-9 shrink-0 rounded bg-surface-raised object-cover" />
                ) : (
                  <div className="h-9 w-9 shrink-0 rounded bg-surface-raised" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{e.name}</span>
                  <span className="block truncate text-xs capitalize text-text-dim">
                    {e.movement_pattern.replace(/_/g, " ")}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {everLoaded && !error && results.length === 0 && (
          <li className="px-2 py-4 text-sm text-text-muted">No matching {sport} exercises.</li>
        )}
      </ul>
    </aside>
  );
}
