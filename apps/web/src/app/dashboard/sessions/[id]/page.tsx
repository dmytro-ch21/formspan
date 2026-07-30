"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import ProgressionCard from "./ProgressionCard";
import {
  deleteSession,
  emptySet,
  fetchSuggestions,
  getWorkout,
  finishSession,
  getExerciseUnits,
  getSession,
  isValidationError,
  listExercises,
  measuresFor,
  MEASURE_KEY,
  MEASURE_LABEL,
  pickImage,
  replaceSets,
  setExerciseUnit,
  SET_TYPES,
  similarTo,
  swapExercise,
  type Exercise,
  type LoggedSet,
  type Measure,
  type Session,
  type SetType,
  type Suggestion,
  type Volume,
} from "@/lib/api";
import {
  distanceInputUnit,
  formatVolume,
  fromDisplayDistance,
  fromDisplayWeight,
  toDisplayDistance,
  toDisplayWeight,
  weightUnit,
  type UnitSystem,
} from "@/lib/units";
import { useUnits } from "@/lib/useUnits";

/**
 * Logging a session on a desktop.
 *
 * The phone screen hides each set's fields behind a disclosure because there
 * is no room and one hand to spare. Here there is room, so nothing is hidden:
 * every set is a row of live inputs, and Tab walks reps → weight → RIR → RPE
 * → next set. Typing up a session you scribbled on paper, or fixing last
 * Tuesday's numbers, is what this screen is for.
 *
 * There is no Save button on either platform — every edit writes through,
 * coalesced so a three-digit weight is one request rather than three.
 */
export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  // Held apart from `session` so a save landing mid-keystroke can't replace
  // what's being typed.
  const [sets, setSets] = useState<LoggedSet[]>([]);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [suggestions, setSuggestions] = useState<Map<string, Suggestion>>(new Map());
  const { units } = useUnits();
  // Per-exercise overrides: a machine marked in pounds shouldn't force the
  // whole account into pounds.
  const [exerciseUnits, setExerciseUnits] = useState<Record<string, UnitSystem>>({});
  useEffect(() => {
    getExerciseUnits(getToken)
      .then(setExerciseUnits)
      .catch(() => {});
  }, [getToken]);
  const unitFor = useCallback(
    (exerciseID: string): UnitSystem => exerciseUnits[exerciseID] ?? units,
    [exerciseUnits, units],
  );
  const toggleUnitFor = useCallback(
    (exerciseID: string) => {
      const next: UnitSystem = (exerciseUnits[exerciseID] ?? units) === "metric" ? "imperial" : "metric";
      // Cleared rather than stored when it matches the default, so the map
      // only ever holds genuine exceptions.
      const override = next === units ? null : next;
      setExerciseUnits((m) => {
        const copy = { ...m };
        if (override) copy[exerciseID] = override;
        else delete copy[exerciseID];
        return copy;
      });
      setExerciseUnit(getToken, exerciseID, override).catch(() => {});
    },
    [exerciseUnits, getToken, units],
  );
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The exercise being replaced, if any. The catalog pane doubles as the
  // swap picker rather than growing a second modal.
  const [swapping, setSwapping] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { session: s, volume: v } = await getSession(getToken, id, controller.signal);
      // One catalog request for the sport rather than one per exercise.
      const list = await listExercises(getToken, { sport: s.sport }, controller.signal);
      if (controller.signal.aborted) return;
      setSession(s);
      setSets(s.sets);
      setVolume(v);
      setCatalog(new Map(list.map((e) => [e.id, e])));
      setEverLoaded(true);
      setError(null);
      // Non-blocking: the session must render even if the history lookup
      // fails, since it's advice rather than content.
      // The rep range the rule progresses inside comes from the workout's
      // goal, so a strength block advances on 3-5 and a hypertrophy block on
      // 6-10. A freeform session has no template and falls back to the
      // general range, which is the correct answer rather than a gap.
      (async () => {
        let goal: string | null = null;
        if (s.workout_id) {
          // Advisory: a template that has since been deleted must not stop
          // the session rendering, it just costs the narrower rep range.
          goal = await getWorkout(getToken, s.workout_id, controller.signal)
            .then((w) => w.goal)
            .catch(() => null);
        }
        const found = await fetchSuggestions(
          getToken,
          s.sets.map((x) => x.exercise_id),
          goal,
          controller.signal,
        );
        setSuggestions(found);
      })().catch(() => {});
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setEverLoaded(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [getToken, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const pending = useRef<LoggedSet[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Saves are chained, not fired in parallel: two overlapping PUTs of the
  // whole set list have no ordering guarantee, and the older one landing
  // second would leave the server holding the older list while the screen
  // shows the newer — a lost update with nothing to reconcile it.
  const inFlight = useRef<Promise<unknown>>(Promise.resolve());

  // The response updates the summary but never the rows: replacing them
  // mid-keystroke would fight whoever is typing.
  const persist = useCallback(
    (next: LoggedSet[]) => {
      const run = inFlight.current.then(async () => {
        setSaving(true);
        try {
          const { volume: v } = await replaceSets(getToken, id, next);
          setVolume(v);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          // Bad input is the caller's to fix — reloading would discard every
          // other edit made since the last good save. Only re-read when the
          // server and the screen genuinely disagree about what exists.
          if (!isValidationError(err)) {
            pending.current = null;
            load();
          }
        } finally {
          setSaving(false);
        }
      });
      inFlight.current = run.catch(() => {});
      return run;
    },
    [getToken, id, load],
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const queued = pending.current;
    pending.current = null;
    if (queued) await persist(queued);
    // Awaited even with nothing queued: a save may already be flying, and
    // callers flush precisely because they're about to read the session back.
    await inFlight.current;
  }, [persist]);

  const persistSoon = useCallback(
    (next: LoggedSet[]) => {
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  // Closing the tab mid-edit would otherwise drop the last keystrokes.
  useEffect(() => () => void flush(), [flush]);

  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (pending.current) e.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  function update(index: number, next: LoggedSet) {
    const updated = sets.map((s, i) => (i === index ? next : s));
    setSets(updated);
    persistSoon(updated);
  }

  // Adding, removing, swapping or applying a suggestion is a structural
  // change: it goes now, not on the debounce. Kept in a useCallback rather
  // than a plain function so the ref writes stay out of the render path.
  const commit = useCallback(
    (updated: LoggedSet[]) => {
      pending.current = null;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      void persist(updated);
    },
    [persist],
  );

  // Inserted after the group it belongs to, not appended to the end of the
  // session. Groups form by adjacency, so appending created a second block of
  // the same exercise at the bottom of the page — the volume counted it while
  // the exercise you were looking at appeared unchanged.
  // Computed outside the state updater, deliberately: an updater must be pure,
  // and StrictMode invokes it twice — which would fire two PUTs.
  const addSet = useCallback(
    (exerciseID: string, afterIndex: number) => {
      const next = [
        ...sets.slice(0, afterIndex + 1),
        emptySet(exerciseID, afterIndex + 1, sets[afterIndex]),
        ...sets.slice(afterIndex + 1),
      ].map((s, i) => ({ ...s, position: i }));
      setSets(next);
      commit(next);
    },
    [commit, sets],
  );

  /**
   * Applies a recommendation to the sets of one exercise that are still ahead
   * of you.
   *
   * Both halves together: under double progression the rep target is half the
   * recommendation, so applying only the weight would silently drop the part
   * that moves in most sessions.
   *
   * **Never touches a completed set or a warm-up.** A set already ticked off
   * is a record of what happened, and rewriting its reps to a target would
   * put numbers in the log that nobody performed — then count them in the
   * volume. That matters far more now than it did when only weight moved:
   * `add_reps` is where most sessions land, so the control is visible exactly
   * when the early sets hold fresh real data.
   */
  const applySuggestion = useCallback(
    (indices: number[], weightKg: number | null, reps: number | null) => {
      const next = sets.map((s, i) =>
        indices.includes(i)
          ? {
              ...s,
              ...(weightKg != null ? { weight_kg: weightKg } : {}),
              ...(reps != null ? { reps } : {}),
            }
          : s,
      );
      setSets(next);
      commit(next);
    },
    [commit, sets],
  );


  function addExercise(e: Exercise) {
    setCatalog((c) => (c.has(e.id) ? c : new Map(c).set(e.id, e)));
    const next = swapping
      ? // Rewrites the sets already logged rather than deleting and re-adding,
        // which would throw them away.
        swapExercise(sets, swapping, e, catalog.get(swapping)?.load_type)
      : [...sets, emptySet(e.id, sets.length)];
    setSets(next);
    commit(next);
    setSwapping(null);
  }

  function removeSet(index: number) {
    const next = sets.filter((_, i) => i !== index).map((s, i) => ({ ...s, position: i }));
    setSets(next);
    commit(next);
  }

  // Grouped by exercise so "Add set" sits under the movement it belongs to.
  const groups = useMemo(() => {
    const out: { exerciseID: string; indices: number[] }[] = [];
    sets.forEach((s, i) => {
      const last = out[out.length - 1];
      if (last && last.exerciseID === s.exercise_id) last.indices.push(i);
      else out.push({ exerciseID: s.exercise_id, indices: [i] });
    });
    return out;
  }, [sets]);

  if (loading && !everLoaded) {
    return <p className="text-sm text-text-muted">Loading session…</p>;
  }

  if (!session) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {error ?? "Session not found."}
        </p>
        <Link href="/dashboard/sessions" className="text-sm text-text-muted hover:text-text">
          ← Back to sessions
        </Link>
      </div>
    );
  }

  const finished = session.ended_at !== null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/dashboard/sessions" className="eyebrow hover:text-text-muted">
            ← Sessions
          </Link>
          <h1 className="mt-1 font-display text-4xl font-bold">{session.name || "Session"}</h1>
          <p className="mt-1 text-sm capitalize text-text-muted">
            {session.sport} ·{" "}
            <time dateTime={session.started_at}>
              {new Date(session.started_at).toLocaleString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            {finished ? " · finished" : " · in progress"}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span aria-live="polite" className="text-sm text-text-muted">
            {saving ? "Saving…" : ""}
          </span>
          {!finished && (
            <button
              type="button"
              onClick={async () => {
                try {
                  // The last set typed must land before the session closes.
                  await flush();
                  const { session: s, volume: v } = await finishSession(getToken, id);
                  setSession(s);
                  setSets(s.sets);
                  setVolume(v);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
              className="rounded-pill bg-accent-fill px-5 py-2 text-sm font-bold text-accent-on-fill transition hover:brightness-110"
            >
              Finish session
            </button>
          )}
        </div>
      </header>

      {volume && (
        // Time, sets and reps while training; volume joins them on finish.
        // "Top RPE" is gone — it only repeated the effort just entered. Both
        // are still computed by the API for the trends screen.
        <dl className={`grid gap-3 ${finished ? "grid-cols-4" : "grid-cols-3"}`}>
          <Stat label="Working sets" value={String(volume.working_sets)} />
          <Stat label="Reps" value={String(volume.total_reps)} />
          {/* A result, not a readout — shown once the session is done. */}
          {finished && (
            <Stat
              label="Volume"
              value={volume.tonnage_kg > 0 ? formatVolume(volume.tonnage_kg, units) : "—"}
            />
          )}
        </dl>
      )}

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {error}
        </p>
      )}

      <div className={`grid gap-6 ${finished ? "" : "lg:grid-cols-[1fr_21rem]"}`}>
        <section className="flex min-w-0 flex-col gap-5">
          {groups.length === 0 ? (
            <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
              <p className="font-medium">Nothing logged yet</p>
              <p className="mt-1 text-sm text-text-muted">
                {finished ? "This session is empty." : "Pick an exercise from the catalog."}
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <ExerciseBlock
                key={`${g.exerciseID}-${g.indices[0]}`}
                exercise={catalog.get(g.exerciseID)}
                exerciseID={g.exerciseID}
                indices={g.indices}
                sets={sets}
                editable={!finished}
                onChange={update}
                onRemove={removeSet}
                onAddSet={addSet}
                onSwap={setSwapping}
                swapping={swapping === g.exerciseID}
                suggestion={suggestions.get(g.exerciseID)}
                units={unitFor(g.exerciseID)}
                onToggleUnit={toggleUnitFor}
                onApplySuggestion={applySuggestion}
              />
            ))
          )}

          <button
            type="button"
            onClick={async () => {
              if (!confirm("Delete this session? This can't be undone.")) return;
              try {
                await deleteSession(getToken, id);
                router.push("/dashboard/sessions");
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
            className="mt-4 self-start text-sm text-danger hover:underline"
          >
            Delete session
          </button>
        </section>

        {!finished && (
          <CatalogPane
            sport={session.sport}
            onAdd={addExercise}
            swapFor={swapping ? (catalog.get(swapping) ?? null) : null}
            onCancelSwap={() => setSwapping(null)}
          />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    // flex-col-reverse keeps the number on top visually while <dt> stays
    // before <dd> in the DOM, which is what assistive tech reads.
    <div className="flex flex-col-reverse rounded-card border border-line bg-surface px-4 py-3">
      <dt className="eyebrow text-[0.625rem]">{label}</dt>
      <dd className="stat text-2xl">{value}</dd>
    </div>
  );
}

function ExerciseBlock({
  exercise,
  exerciseID,
  indices,
  sets,
  editable,
  onChange,
  onRemove,
  onAddSet,
  onSwap,
  swapping,
  suggestion,
  onApplySuggestion,
  units,
  onToggleUnit,
}: {
  exercise: Exercise | undefined;
  exerciseID: string;
  indices: number[];
  sets: LoggedSet[];
  editable: boolean;
  onChange: (index: number, next: LoggedSet) => void;
  onRemove: (index: number) => void;
  onAddSet: (exerciseID: string, afterIndex: number) => void;
  onSwap: (exerciseID: string) => void;
  swapping: boolean;
  suggestion: Suggestion | undefined;
  onApplySuggestion: (indices: number[], weightKg: number | null, reps: number | null) => void;
  units: UnitSystem;
  onToggleUnit: (exerciseID: string) => void;
}) {
  const image = exercise ? pickImage(exercise, "thumbnail") : null;
  // Data-driven from the catalog's load_type, so a plank asks for seconds
  // and a squat asks for weight without this component knowing either.
  const measures: Measure[] = exercise ? measuresFor(exercise.load_type) : ["reps"];
  // The sets a recommendation may write to: still to come, and not warm-ups.
  // A completed set is a record of what happened, not a slot to fill.
  const pending = indices.filter(
    (i) => !sets[i]?.completed && sets[i]?.set_type !== "warmup",
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote R2 host, not configured for next/image
          <img src={image} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-surface-raised object-cover" />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-lg bg-surface-raised" />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-lg font-bold">
            {exercise?.name ?? exerciseID}
          </h2>
          {exercise?.is_unilateral && (
            <p className="text-xs text-text-dim">Per side — 8 reps here means 8 each side.</p>
          )}
        </div>
        {editable && (
          <button
            type="button"
            onClick={() => onToggleUnit(exerciseID)}
            title={`Showing ${units === "imperial" ? "pounds" : "kilograms"} for this exercise`}
            aria-label={`${exercise?.name ?? "This exercise"} is in ${
              units === "imperial" ? "pounds" : "kilograms"
            }. Switch.`}
            className="shrink-0 rounded-pill border border-line px-3 py-1 text-xs font-bold text-text-muted transition hover:bg-surface-raised"
          >
            {weightUnit(units)}
          </button>
        )}
        {editable && (
          <button
            type="button"
            onClick={() => onSwap(exerciseID)}
            aria-pressed={swapping}
            className={`shrink-0 rounded-pill border px-3 py-1 text-xs font-bold transition ${
              swapping
                ? "border-lime bg-lime/10 text-lime"
                : "border-line text-text-muted hover:bg-surface-raised"
            }`}
          >
            {swapping ? "Choosing…" : "Swap"}
          </button>
        )}
      </div>

      {/* The sets a recommendation may write to: still to come, and not
          warm-ups. A completed set is a record of what happened. */}
      {suggestion && (
        <ProgressionCard
          suggestion={suggestion}
          exerciseName={exercise?.name ?? "this exercise"}
          units={units}
          // Nothing left to write to — every set of this exercise is done or a
          // warm-up — so there is no action to offer.
          editable={editable && pending.length > 0}
          // "Applied" is judged against the first set the control would
          // actually write to, not the first set in the group: a session
          // mid-flight legitimately has completed sets ahead of it, and
          // judging on those would leave the button offering to redo what's
          // already been done.
          applied={
            pending.length > 0 &&
            (suggestion.target_weight_kg == null ||
              sets[pending[0]]?.weight_kg === suggestion.target_weight_kg) &&
            (suggestion.target_reps == null ||
              sets[pending[0]]?.reps === suggestion.target_reps)
          }
          onApply={(weightKg, reps) => onApplySuggestion(pending, weightKg, reps)}
        />
      )}

      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className="border-b border-line-soft text-left">
              <th scope="col" className="px-4 py-2">
                <span className="sr-only">Done</span>
              </th>
              <th scope="col" className="eyebrow px-4 py-2 text-[0.625rem] font-medium">
                Set
              </th>
              {measures.map((m) => (
                <th key={m} scope="col" className="eyebrow px-2 py-2 text-[0.625rem] font-medium">
                  {m === "weight"
                    ? weightUnit(units)
                    : m === "distance"
                      ? distanceInputUnit(units)
                      : MEASURE_LABEL[m]}
                </th>
              ))}
              <th scope="col" className="eyebrow px-2 py-2 text-[0.625rem] font-medium">
                <abbr title="Reps in reserve — how many you could still have done">RIR</abbr>
              </th>
              <th scope="col" className="eyebrow px-2 py-2 text-[0.625rem] font-medium">
                <abbr title="Rate of perceived exertion, 1–10">RPE</abbr>
              </th>
              <th scope="col" className="eyebrow px-2 py-2 text-[0.625rem] font-medium">
                Type
              </th>
              <th scope="col" className="px-2 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {indices.map((index, ordinal) => (
              <SetRow
                key={index}
                ordinal={ordinal + 1}
                set={sets[index]}
                measures={measures}
                editable={editable}
                exerciseName={exercise?.name ?? exerciseID}
                units={units}
                onChange={(next) => onChange(index, next)}
                onRemove={() => onRemove(index)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {editable && (
        <button
          type="button"
          onClick={() => onAddSet(exerciseID, indices[indices.length - 1])}
          className="self-start rounded-pill border border-dashed border-line px-4 py-1.5 text-sm font-medium text-text-muted transition hover:border-lime hover:text-text"
        >
          + Add set
        </button>
      )}
    </div>
  );
}

function SetRow({
  ordinal,
  set,
  measures,
  editable,
  exerciseName,
  onChange,
  onRemove,
  units,
}: {
  ordinal: number;
  set: LoggedSet;
  measures: Measure[];
  editable: boolean;
  exerciseName: string;
  onChange: (next: LoggedSet) => void;
  onRemove: () => void;
  units: UnitSystem;
}) {
  const short = SET_TYPES.find((t) => t.key === set.set_type)?.short ?? "";

  function num(key: keyof LoggedSet, whole = false) {
    return (raw: string) => {
      const n = raw.trim() === "" ? null : Number(raw.replace(",", "."));
      if (n === null || !Number.isFinite(n)) {
        onChange({ ...set, [key]: null });
        return;
      }
      onChange({ ...set, [key]: whole ? Math.round(n) : n });
    };
  }

  return (
    <tr className="border-b border-line-soft last:border-b-0">
      <td className="px-4 py-1.5">
        {/* Web could create sets but never mark one done, so every
            web-logged session reported zero volume and dropped out of the
            progression history entirely — completed sets are the only ones
            Summarise and RecentEfforts count. */}
        <input
          type="checkbox"
          checked={set.completed}
          disabled={!editable}
          onChange={(e) => onChange({ ...set, completed: e.target.checked })}
          aria-label={`Set ${ordinal} of ${exerciseName} done`}
          className="size-5 accent-lime disabled:opacity-50"
        />
      </td>
      <td className="px-4 py-1.5">
        <span className="stat text-text-dim">{ordinal}</span>
        {short && <span className="ml-1 text-xs font-bold text-lime">{short}</span>}
      </td>

      {measures.map((m) => {
        const stored = set[MEASURE_KEY[m]] as number | null;
        const unitLabel =
          m === "weight"
            ? weightUnit(units)
            : m === "distance"
              ? distanceInputUnit(units)
              : MEASURE_LABEL[m];
        const shown =
          stored == null
            ? null
            : m === "weight"
              ? toDisplayWeight(stored, units)
              : m === "distance"
                ? toDisplayDistance(stored, units)
                : stored;
        return (
          <td key={m} className="px-2 py-1.5">
            <NumberCell
              label={`${unitLabel} for set ${ordinal} of ${exerciseName}`}
              value={shown}
              onChange={(raw) => {
                const n = raw.trim() === "" ? null : Number(raw.replace(",", "."));
                if (n === null || !Number.isFinite(n)) {
                  onChange({ ...set, [MEASURE_KEY[m]]: null });
                  return;
                }
                // Converted back before it's stored — the database only ever
                // sees kilograms and metres.
                const canonical =
                  m === "weight"
                    ? fromDisplayWeight(n, units)
                    : m === "distance"
                      ? Math.round(fromDisplayDistance(n, units))
                      : Math.round(n);
                onChange({ ...set, [MEASURE_KEY[m]]: canonical });
              }}
              step={m === "weight" ? 0.5 : 1}
              disabled={!editable}
            />
          </td>
        );
      })}

      <td className="px-2 py-1.5">
        <NumberCell
          label={`Reps in reserve for set ${ordinal} of ${exerciseName}`}
          value={set.rir}
          onChange={num("rir", true)}
          disabled={!editable}
          min={0}
          max={20}
          step={1}
        />
      </td>
      <td className="px-2 py-1.5">
        <NumberCell
          label={`RPE for set ${ordinal} of ${exerciseName}`}
          value={set.rpe}
          onChange={num("rpe")}
          disabled={!editable}
          min={1}
          max={10}
          step={0.5}
        />
      </td>

      <td className="px-2 py-1.5">
        <select
          value={set.set_type}
          disabled={!editable}
          aria-label={`Type of set ${ordinal} of ${exerciseName}`}
          onChange={(e) => onChange({ ...set, set_type: e.target.value as SetType })}
          className="rounded-lg border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-lime disabled:opacity-60"
        >
          {SET_TYPES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </td>

      <td className="px-2 py-1.5 text-right">
        {editable && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove set ${ordinal} of ${exerciseName}`}
            title="Remove set"
            className="rounded-lg px-2 py-1 text-sm text-text-dim transition hover:bg-surface-hover hover:text-danger"
          >
            ✕
          </button>
        )}
      </td>
    </tr>
  );
}

function NumberCell({
  label,
  value,
  onChange,
  disabled,
  min,
  max,
  step,
}: {
  label: string;
  value: number | null;
  onChange: (raw: string) => void;
  /** A finished session is read-only — but still readable and focusable. */
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      readOnly={disabled}
      onChange={(e) => onChange(e.target.value)}
      placeholder="—"
      className="stat w-20 rounded-lg border border-line bg-bg px-2 py-1.5 text-center text-base outline-none focus:border-lime read-only:border-transparent read-only:bg-transparent"
    />
  );
}

/**
 * The always-visible catalog, same as the workout editor: adding six
 * movements is six clicks with the list never leaving view, rather than six
 * modal round-trips. Pre-filtered to the session's own discipline, so a
 * mismatch the API would reject is simply unreachable.
 */
function CatalogPane({
  sport,
  onAdd,
  swapFor,
  onCancelSwap,
}: {
  sport: string;
  onAdd: (e: Exercise) => void;
  /** Set while replacing an exercise — the pane becomes the swap picker. */
  swapFor: Exercise | null;
  onCancelSwap: () => void;
}) {
  const { getToken } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Exercise[]>([]);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  // Only while the search is untouched: once you're typing, the results you
  // asked for are the ones you want.
  const suggestions = useMemo(
    () => (swapFor && query.trim() === "" ? similarTo(swapFor, results) : []),
    [swapFor, results, query],
  );

  return (
    <aside className="flex h-fit flex-col gap-3 lg:sticky lg:top-10">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="eyebrow">
          {swapFor ? `Replace ${swapFor.name}` : `Catalog · ${sport}`}
        </h2>
        {swapFor && (
          <button
            type="button"
            onClick={onCancelSwap}
            className="text-xs text-text-muted hover:text-text"
          >
            Cancel
          </button>
        )}
      </div>

      <input
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

      <ul className="flex max-h-[34rem] flex-col gap-1 overflow-y-auto pr-1">
        {suggestions.length > 0 && (
          <li className="eyebrow px-2 pb-1 pt-2 text-[0.625rem]">Similar</li>
        )}
        {suggestions.map((e) => (
          <CatalogRow key={`suggested-${e.id}`} exercise={e} swapFor={swapFor} onAdd={onAdd} />
        ))}
        {suggestions.length > 0 && (
          <li className="eyebrow px-2 pb-1 pt-3 text-[0.625rem]">All {sport}</li>
        )}
        {results.map((e) => (
          <CatalogRow key={e.id} exercise={e} swapFor={swapFor} onAdd={onAdd} />
        ))}
        {everLoaded && !error && results.length === 0 && (
          <li className="px-2 py-4 text-sm text-text-muted">No matching {sport} exercises.</li>
        )}
      </ul>
    </aside>
  );
}

/** One catalog entry, in either the suggestions or the full list. */
function CatalogRow({
  exercise,
  swapFor,
  onAdd,
}: {
  exercise: Exercise;
  swapFor: Exercise | null;
  onAdd: (e: Exercise) => void;
}) {
  const image = pickImage(exercise, "thumbnail");
  const carries = swapFor ? exercise.load_type === swapFor.load_type : true;
  return (
    <li>
      <button
        type="button"
        onClick={() => onAdd(exercise)}
        aria-label={swapFor ? `Swap for ${exercise.name}` : `Add ${exercise.name}`}
        className="flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left transition hover:border-line hover:bg-surface-raised"
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote R2 host
          <img src={image} alt="" className="h-9 w-9 shrink-0 rounded bg-surface-raised object-cover" />
        ) : (
          <div className="h-9 w-9 shrink-0 rounded bg-surface-raised" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{exercise.name}</span>
          <span className="block truncate text-xs capitalize text-text-dim">
            {exercise.movement_pattern.replace(/_/g, " ")}
            {swapFor && !carries ? " · measured differently" : ""}
          </span>
        </span>
      </button>
    </li>
  );
}
