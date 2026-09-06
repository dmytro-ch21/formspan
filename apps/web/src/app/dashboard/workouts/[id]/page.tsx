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
  EXERCISE_PROFILES,
  FIELD_KEY,
  FIELD_LABEL,
  getWorkout,
  listExercises,
  pickImage,
  PROGRESSION_STRATEGIES,
  protocolIsConfigured,
  renameWorkout,
  copyWorkout,
  replaceItems,
  SET_ROLES,
  setsFromWorkout,
  startSession,
  targetFieldsFor,
  type Exercise,
  type ItemProtocol,
  type RepCountMode,
  type SetPrescription,
  type TargetField,
  type Workout,
  type WorkoutItem,
} from "@/lib/api";
import {
  distanceInputUnit,
  formatDistance,
  formatWeight,
  fromDisplayDistance,
  fromDisplayWeight,
  toDisplayDistance,
  toDisplayWeight,
  weightUnit,
  type UnitSystem,
} from "@/lib/units";
import { useUnits } from "@/lib/useUnits";
import { ShareToFriend } from "@/components/ShareToFriend";

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
export default function WorkoutEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { getToken, userId } = useAuth();
  const router = useRouter();

  const [workout, setWorkout] = useState<Workout | null>(null);
  const [items, setItems] = useState<WorkoutItem[]>([]);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * WHICH workout is being copied, and cleared whenever the id changes.
   *
   * `router.push` to the copy stays inside the `[id]` segment, so Next REUSES
   * this component rather than remounting it. A plain boolean survived that:
   * copy, press Back, and the original's button sat disabled at "Copying…".
   *
   * **Deriving alone was not enough, which review caught.** `copyingId === id`
   * is false while you are AWAY from the original — and true again the moment
   * you navigate BACK to it, because the equality returns. So the id is
   * compared against the previous render's and the flag cleared on any change,
   * in either direction, using React's adjust-state-during-render pattern
   * rather than an effect (`react-hooks/set-state-in-effect` refuses the
   * effect, correctly). Clearing after the push instead would re-enable the
   * button mid-transition, and copying is not idempotent.
   */
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setCopyingId(null);
  }
  const copying = copyingId !== null && copyingId === id;
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [starting, setStarting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const renameButtonRef = useRef<HTMLButtonElement | null>(null);
  const { units } = useUnits();
  const abortRef = useRef<AbortController | null>(null);

  const canEdit =
    workout !== null &&
    workout.owner_user_id !== null &&
    workout.owner_user_id === userId;

  /**
   * Commit the name, or quietly abandon a blank one.
   *
   * Kept apart from `save()`, which is item-shaped and only lights up when the
   * item list differs — a rename leaves that comparison equal, so a combined
   * flow would need one button live for two unrelated reasons. The API keeps
   * the two verbs apart for the same reason.
   *
   * Unlike mobile there is no local-first write here: the web app has no
   * offline store, so the server IS the save. That is also why the failure
   * path restores the old name rather than leaving the new one on screen —
   * showing a rename the server refused is the lie the mobile outbox exists
   * to avoid.
   */
  async function commitRename() {
    if (!workout) return;
    const next = draftName.trim();
    setRenaming(false);
    // The input unmounts here, and without this focus lands on <body> — a
    // keyboard user editing the title would have to tab from the top of the
    // document to get back to it (WCAG 2.4.3). Deferred a frame so the button
    // it targets exists.
    requestAnimationFrame(() => renameButtonRef.current?.focus());
    if (next === "" || next === workout.name) return;
    const previous = workout.name;
    setWorkout((w) => (w ? { ...w, name: next } : w));
    try {
      const updated = await renameWorkout(getToken, workout.id, next);
      setWorkout(updated);
      setError(null);
    } catch (err) {
      setWorkout((w) => (w ? { ...w, name: previous } : w));
      setError(
        `Couldn't rename: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const dirty = useMemo(
    () =>
      workout !== null &&
      JSON.stringify(items) !== JSON.stringify(workout.items),
    [items, workout],
  );

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const w = await getWorkout(getToken, id, controller.signal);
      // One catalog request for the sport rather than one per item.
      const list = await listExercises(
        getToken,
        { sport: w.sport },
        controller.signal,
      );
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
        // Where the plan is silent, last time's numbers are the sensible
        // starting point. A failed lookup mustn't block the session.
        //
        // The goal goes with it: it decides the rep range the recommendation
        // is expressed in, so omitting it here would pre-fill a session on the
        // general 5-8 range that the session screen then re-derives on 3-5.
        sets = applySuggestions(
          sets,
          await fetchSuggestions(
            getToken,
            sets.map((x) => x.exercise_id),
            workout.goal,
            undefined,
            undefined,
            // N473/#812 item 8 — see fetchSuggestions's own doc comment.
            units,
            // N494/#864 — see fetchSuggestions's own doc comment.
            workout.id,
          ),
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
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error ?? "Workout not found."}
        </p>
        <Link
          href="/dashboard/workouts"
          className="text-sm text-text-muted hover:text-text"
        >
          ← Back to workouts
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard/workouts"
            className="eyebrow hover:text-text-muted"
          >
            ← Workouts
          </Link>
          {/*
            The heading is the control when the workout is yours. A template
            named in a hurry had no correction short of rebuilding it, which
            loses every plan pointing at the old id.

            It stays an `h1` in both states — swapping the heading for a bare
            input on edit would take the page's only level-1 landmark away from
            a screen reader mid-task.
          */}
          <h1 className="mt-1 font-display text-4xl font-bold">
            {renaming ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  // Escape abandons rather than commits — the one way out
                  // that does not write, which a blur-to-save field otherwise
                  // does not offer.
                  if (e.key === "Escape") setRenaming(false);
                }}
                // Matches the server's maxNameLen, so the field cannot hold
                // something that is a guaranteed 400.
                maxLength={120}
                aria-label="Workout name"
                className="w-full border-b border-line bg-transparent font-display text-4xl font-bold outline-none focus:border-lime"
                data-testid="workout-name-input"
              />
            ) : canEdit ? (
              <button
                type="button"
                onClick={() => {
                  setDraftName(workout.name);
                  setRenaming(true);
                }}
                ref={renameButtonRef}
                className="rounded text-left hover:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime"
                aria-label={`${workout.name}. Rename this workout`}
                data-testid="workout-rename"
              >
                {workout.name}
              </button>
            ) : (
              workout.name
            )}
          </h1>
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
                {saving
                  ? "Saving…"
                  : dirty
                    ? "Unsaved changes"
                    : savedOnce
                      ? "Saved"
                      : ""}
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
          {/* OUTSIDE the `canEdit` gate, exactly as on the sequence page:
              passing on a template you can read is not a write to it, and the
              server tests VISIBILITY rather than ownership for that reason —
              a VOLA Workout is already one tap from "Copy to my workouts".

              What it shares is what the SERVER holds. With unsaved edits on
              screen that is not what you are looking at, which is the same
              trap "Start session" is disabled for, so this says so rather
              than sending a version of the plan nobody chose. */}
          <ShareToFriend
            resourceType="workout"
            resourceId={workout.id}
            disabled={dirty}
            disabledReason="Save your changes first — sharing sends the saved version."
          />
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
          <p className="text-sm text-text-muted">
            {workout.owner_user_id === null
              ? "A VOLA Workout — yours to copy, not to edit."
              : "Published by someone else — yours to copy, not to edit."}
          </p>
          {/* The point of a browse surface: without this, the seeded plans are
              something you can read and never use. The copy is a NEW workout
              owned outright, so editing it can't touch the original and a
              deploy refreshing the seeded plan can't reach into the copy. */}
          <button
            type="button"
            disabled={copying}
            onClick={async () => {
              setCopyingId(workout.id);
              try {
                // ONE call. This was `createWorkout` then `replaceItems`, and
                // a failure between them left an empty workout the athlete now
                // owned, with no sign of where it came from. The server has
                // done it in a transaction since F10.
                const mine = await copyWorkout(getToken, workout.id);
                router.push(`/dashboard/workouts/${mine.id}`);
              } catch (err) {
                setError(
                  `Couldn't copy: ${err instanceof Error ? err.message : String(err)}`,
                );
                // Only on failure. On success the navigation changes `id`,
                // which clears the flag above.
                setCopyingId(null);
              }
            }}
            className="shrink-0 rounded-pill bg-accent-fill px-4 py-2 text-sm font-bold text-accent-on-fill transition hover:brightness-110 disabled:opacity-50"
          >
            {/* aria-live, matching the sequences page and the save status
                above: a label swapping in place on an already focused button
                is not reliably announced. */}
            <span aria-live="polite">
              {copying ? "Copying…" : "Copy to my workouts"}
            </span>
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error}
        </p>
      )}

      <div
        className={`grid gap-6 ${canEdit ? "lg:grid-cols-[1fr_21rem]" : ""}`}
      >
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="eyebrow">The session</h2>
          {items.length === 0 ? (
            <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
              <p className="font-medium">Nothing in this workout yet</p>
              <p className="mt-1 text-sm text-text-muted">
                {canEdit
                  ? "Pick exercises from the catalog on the right."
                  : "This workout is empty."}
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
                  onChange={(next) =>
                    setItems(items.map((it, i) => (i === index ? next : it)))
                  }
                  onMoveTo={(to) => move(index, to)}
                  onDropFrom={(from) => move(from, index)}
                  onRemove={() =>
                    setItems(
                      items
                        .filter((_, i) => i !== index)
                        .map((it, i) => ({ ...it, position: i })),
                    )
                  }
                />
              ))}
            </ol>
          )}

          {canEdit && (
            <button
              type="button"
              onClick={async () => {
                if (!confirm(`Delete "${workout.name}"? This can't be undone.`))
                  return;
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
  const fields: TargetField[] = exercise
    ? targetFieldsFor(exercise.load_type)
    : [];
  const [protocolOpen, setProtocolOpen] = useState(false);
  const configured = protocolIsConfigured(item.protocol);

  return (
    <li className="rounded-card border border-line bg-surface transition hover:bg-surface-raised">
      <div
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
      className="group flex items-center gap-4 px-4 py-3"
    >
      <span className="stat w-6 shrink-0 text-center text-lg text-text-dim">
        {index + 1}
      </span>

      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote R2 host, not configured for next/image
        <img
          src={image}
          alt=""
          className="h-14 w-14 shrink-0 rounded-lg bg-surface-raised object-cover"
        />
      ) : (
        <div className="h-14 w-14 shrink-0 rounded-lg bg-surface-raised" />
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {exercise?.name ?? item.exercise_id}
        </p>
        <p className="truncate text-xs capitalize text-text-dim">
          {exercise?.movement_pattern.replace(/_/g, " ")}
          {exercise?.is_unilateral ? " · per side" : ""}
          {/* A target weight PREFILLS the logged weight verbatim, and the
              server applies the ×2 on read — so a pair total typed here comes
              back doubled from an already-doubled number. This is the last
              place "which number do I type?" was asked and left unanswered.
              Implement-neutral: 58 of the 142 are kettlebell or handles. */}
          {exercise?.load_mode === "per_side" ? " · weight per hand" : ""}
        </p>
      </div>

      {editable ? (
        <div className="flex shrink-0 items-end gap-2">
          {fields.map((f) => {
            // **Label and value move together, or not at all.** An earlier
            // pass of N105 gave `distance` the imperial LABEL here and left
            // the value in metres, which recreated the exact bug the ticket
            // exists to close: a stored 100 m displayed as "100" under a "yd"
            // header, and an athlete typing "100" meaning yards stored 100
            // metres. The old "Metres" label was at least truthful.
            //
            // A unit label is a claim about the number beside it. Adding one
            // without converting the number is worse than leaving both metric.
            const label =
              f === "weight"
                ? weightUnit(units)
                : f === "distance"
                  ? distanceInputUnit(units)
                  : FIELD_LABEL[f];
            const stored = item[FIELD_KEY[f]] as number | null;
            // Shown in the athlete's units, stored in kilograms and metres —
            // the same rule the session logger follows, so a template written
            // in pounds and performed in kilograms is still the same plan.
            const shown =
              stored == null
                ? ""
                : f === "weight"
                  ? toDisplayWeight(stored, units)
                  : f === "distance"
                    ? toDisplayDistance(stored, units)
                    : stored;
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
                    // Converted back before it is stored — the database only
                    // ever sees kilograms and metres.
                    onChange({
                      ...item,
                      [FIELD_KEY[f]]:
                        f === "weight"
                          ? fromDisplayWeight(n, units)
                          : f === "distance"
                            ? Math.round(fromDisplayDistance(n, units))
                            : Math.round(n),
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
        <span className="stat shrink-0 text-sm text-text-muted">
          {targetSummary(item, units)}
        </span>
      )}

      {editable && (
        <div className="flex shrink-0 items-center gap-1">
          {/* N494/#864: not hover-revealed like the icon buttons below — a
              configured protocol is a fact about the item worth seeing at
              rest, not a rarely-used action. */}
          <button
            type="button"
            onClick={() => setProtocolOpen((v) => !v)}
            aria-expanded={protocolOpen}
            aria-label={`Protocol for ${exercise?.name ?? "exercise"}${configured ? ", configured" : ""}`}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
              configured
                ? "border-lime bg-lime/10 text-lime"
                : "border-line text-text-dim hover:border-lime/60 hover:text-lime"
            }`}
          >
            Protocol{configured ? " ✓" : ""}
          </button>
          {/* Revealed on hover so the row stays calm at rest, but never hidden
              from keyboard users. */}
          <div className="flex gap-1 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
            <IconButton
              label="Move up"
              onClick={() => onMoveTo(index - 1)}
              disabled={index === 0}
            >
              ↑
            </IconButton>
            <IconButton
              label="Move down"
              onClick={() => onMoveTo(index + 1)}
              disabled={index === total - 1}
            >
              ↓
            </IconButton>
            <IconButton
              label={`Remove ${exercise?.name ?? "exercise"}`}
              onClick={onRemove}
              danger
            >
              ✕
            </IconButton>
          </div>
        </div>
      )}
    </div>

      {editable && protocolOpen && (
        <ProtocolEditor
          protocol={item.protocol}
          units={units}
          exerciseName={exercise?.name}
          onChange={(next) => onChange({ ...item, protocol: next })}
        />
      )}
    </li>
  );
}

/**
 * The richer, web-only authoring surface for a workout item's progression
 * protocol (N494/#864, phase 2 of #753) — full scalar configuration PLUS
 * the per-set prescription table (role/load/rep range/effort range/rest/
 * optionality), which needs the row-based layout only a wide screen has
 * room for. `apps/mobile`'s equivalent editor covers every scalar field
 * here but not the per-set table — see CLAUDE.md's mobile-first rule and
 * that editor's own doc comment for why that split is deliberate rather
 * than a gap.
 */
function ProtocolEditor({
  protocol,
  units,
  exerciseName,
  onChange,
}: {
  protocol: ItemProtocol | null | undefined;
  units: UnitSystem;
  exerciseName: string | undefined;
  onChange: (next: ItemProtocol | undefined) => void;
}) {
  const p = protocol ?? {};

  function set(patch: Partial<ItemProtocol>) {
    const next: ItemProtocol = { ...p, ...patch };
    onChange(protocolIsConfigured(next) ? next : undefined);
  }

  function setSet(i: number, patch: Partial<SetPrescription>) {
    const sets = [...(p.sets ?? [])];
    sets[i] = { ...sets[i], ...patch };
    set({ sets });
  }

  function addSet() {
    set({ sets: [...(p.sets ?? []), { role: "working" }] });
  }

  function removeSet(i: number) {
    const sets = (p.sets ?? []).filter((_, idx) => idx !== i);
    set({ sets: sets.length > 0 ? sets : undefined });
  }

  const numberInput = (
    label: string,
    value: number | null | undefined,
    onSet: (n: number | null) => void,
    step = 1,
  ) => (
    <label className="flex flex-col gap-1">
      <span className="eyebrow text-[0.625rem]">{label}</span>
      <input
        type="number"
        step={step}
        aria-label={`${label} for ${exerciseName ?? "exercise"}`}
        value={value == null ? "" : value}
        onChange={(e) => {
          const raw = e.target.value;
          const n = raw === "" ? null : Number(raw);
          onSet(n === null || !Number.isFinite(n) ? null : n);
        }}
        placeholder="—"
        className="stat w-24 rounded-lg border border-line bg-bg px-2 py-1.5 text-center text-sm outline-none focus:border-lime"
      />
    </label>
  );

  return (
    <div className="border-t border-line bg-bg/40 px-4 py-4">
      <p className="mb-3 max-w-2xl text-xs text-text-muted">
        Overrides the workout&apos;s general rep range for just this exercise —
        useful for accessory work (an upright row, a calf raise) that
        shouldn&apos;t follow the same protocol as a primary lift. These are
        defaults for THIS item; leaving a field blank falls back to the
        exercise&apos;s profile default, then to the workout&apos;s own goal-based
        range.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        {numberInput("Min reps", p.rep_range_min, (n) => set({ rep_range_min: n }))}
        {numberInput("Max reps", p.rep_range_max, (n) => set({ rep_range_max: n }))}
        {numberInput("Target sets", p.target_sets, (n) => set({ target_sets: n }))}
        {numberInput("Target RIR", p.target_rir, (n) => set({ target_rir: n }))}
        {numberInput("Target RPE", p.target_rpe, (n) => set({ target_rpe: n }), 0.5)}
        {numberInput(
          `Equipment increment (${weightUnit(units)})`,
          p.equipment_increment == null ? null : toDisplayWeight(p.equipment_increment, units),
          (n) => set({ equipment_increment: n == null ? null : fromDisplayWeight(n, units) }),
          0.5,
        )}

        <label className="flex flex-col gap-1">
          <span className="eyebrow text-[0.625rem]">Progression strategy</span>
          <select
            aria-label="Progression strategy"
            value={p.progression_strategy ?? ""}
            onChange={(e) =>
              set({
                progression_strategy: e.target.value
                  ? (e.target.value as ItemProtocol["progression_strategy"])
                  : null,
              })
            }
            className="stat rounded-lg border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-lime"
          >
            <option value="">— not set —</option>
            {PROGRESSION_STRATEGIES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="eyebrow text-[0.625rem]">Rep counting</span>
          <select
            aria-label="Rep counting mode"
            value={p.rep_count_mode ?? ""}
            onChange={(e) =>
              set({ rep_count_mode: (e.target.value || null) as RepCountMode | null })
            }
            className="stat rounded-lg border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-lime"
          >
            <option value="">— not set —</option>
            <option value="total">Total</option>
            <option value="per_side">Per side</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="eyebrow text-[0.625rem]">Exercise profile</span>
          <select
            aria-label="Exercise profile"
            value={p.exercise_profile ?? ""}
            onChange={(e) =>
              set({
                exercise_profile: e.target.value
                  ? (e.target.value as ItemProtocol["exercise_profile"])
                  : null,
              })
            }
            className="stat rounded-lg border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-lime"
          >
            <option value="">— not set —</option>
            {EXERCISE_PROFILES.map((prof) => (
              <option key={prof.key} value={prof.key}>
                {prof.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Per-set prescriptions — the one piece of this ticket's scope that
          genuinely needs a wide table rather than a phone-sized form: a
          top-set/backoff scheme has no single set of numbers describing
          both a top set and its backoffs, which is exactly what this table
          exists to author. */}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow text-[0.625rem]">Per-set prescription</span>
          <button
            type="button"
            onClick={addSet}
            className="rounded-full border border-line px-2 py-1 text-xs font-semibold text-text-dim hover:border-lime hover:text-lime"
          >
            + Add set
          </button>
        </div>
        {(p.sets ?? []).length === 0 ? (
          <p className="text-xs text-text-muted">No per-set overrides — this item uses one uniform prescription.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-text-dim">
                <tr>
                  <th className="pb-1 pr-2">Role</th>
                  <th className="pb-1 pr-2">Load ({weightUnit(units)})</th>
                  <th className="pb-1 pr-2">Reps</th>
                  <th className="pb-1 pr-2">Effort (RIR)</th>
                  <th className="pb-1 pr-2">Rest (s)</th>
                  <th className="pb-1 pr-2">Optional</th>
                  <th className="pb-1" />
                </tr>
              </thead>
              <tbody>
                {(p.sets ?? []).map((sp, i) => (
                  <tr key={i} className="border-t border-line/60">
                    <td className="py-1.5 pr-2">
                      <select
                        aria-label={`Role for set ${i + 1}`}
                        value={sp.role}
                        onChange={(e) => setSet(i, { role: e.target.value as SetPrescription["role"] })}
                        className="rounded border border-line bg-bg px-1 py-1"
                      >
                        {SET_ROLES.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        type="number"
                        step={0.5}
                        aria-label={`Load for set ${i + 1}`}
                        value={sp.load_kg == null ? "" : toDisplayWeight(sp.load_kg, units)}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const n = raw === "" ? null : Number(raw);
                          setSet(i, {
                            load_kg: n === null || !Number.isFinite(n) ? null : fromDisplayWeight(n, units),
                          });
                        }}
                        className="w-16 rounded border border-line bg-bg px-1 py-1"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          aria-label={`Min reps for set ${i + 1}`}
                          value={sp.rep_range_min == null ? "" : sp.rep_range_min}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setSet(i, { rep_range_min: raw === "" ? null : Math.round(Number(raw)) });
                          }}
                          className="w-12 rounded border border-line bg-bg px-1 py-1"
                        />
                        <span>–</span>
                        <input
                          type="number"
                          aria-label={`Max reps for set ${i + 1}`}
                          value={sp.rep_range_max == null ? "" : sp.rep_range_max}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setSet(i, { rep_range_max: raw === "" ? null : Math.round(Number(raw)) });
                          }}
                          className="w-12 rounded border border-line bg-bg px-1 py-1"
                        />
                      </div>
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          aria-label={`Min effort RIR for set ${i + 1}`}
                          value={sp.effort_rir_min == null ? "" : sp.effort_rir_min}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setSet(i, { effort_rir_min: raw === "" ? null : Math.round(Number(raw)) });
                          }}
                          className="w-12 rounded border border-line bg-bg px-1 py-1"
                        />
                        <span>–</span>
                        <input
                          type="number"
                          aria-label={`Max effort RIR for set ${i + 1}`}
                          value={sp.effort_rir_max == null ? "" : sp.effort_rir_max}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setSet(i, { effort_rir_max: raw === "" ? null : Math.round(Number(raw)) });
                          }}
                          className="w-12 rounded border border-line bg-bg px-1 py-1"
                        />
                      </div>
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        type="number"
                        aria-label={`Rest seconds for set ${i + 1}`}
                        value={sp.rest_seconds == null ? "" : sp.rest_seconds}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setSet(i, { rest_seconds: raw === "" ? null : Math.round(Number(raw)) });
                        }}
                        className="w-16 rounded border border-line bg-bg px-1 py-1"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        type="checkbox"
                        aria-label={`Set ${i + 1} is optional`}
                        checked={!!sp.optional}
                        onChange={(e) => setSet(i, { optional: e.target.checked })}
                      />
                    </td>
                    <td className="py-1.5">
                      <button
                        type="button"
                        onClick={() => removeSet(i)}
                        aria-label={`Remove set ${i + 1}`}
                        className="text-text-dim hover:text-danger"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function targetSummary(i: WorkoutItem, units: UnitSystem): string {
  const p: string[] = [];
  if (i.target_sets && i.target_reps)
    p.push(`${i.target_sets}×${i.target_reps}`);
  if (i.target_weight_kg) p.push(formatWeight(i.target_weight_kg, units));
  if (i.target_seconds) p.push(`${i.target_seconds}s`);
  // `formatDistance`, not `${…}m`. This is the READ-ONLY twin of the edit row
  // above, so a raw metre figure here would contradict the yards that row
  // shows for the same item the moment the athlete clicks Edit.
  //
  // `check-unit-literals` can never catch this one: `m` is deliberately
  // outside its vocabulary, because this app renders minutes and seconds as
  // `m` and `s` in a dozen places. A checker with an ambiguous token in it is
  // one somebody eventually silences.
  if (i.target_distance_m) p.push(formatDistance(i.target_distance_m, units));
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
function CatalogPane({
  sport,
  onAdd,
}: {
  sport: string;
  onAdd: (e: Exercise) => void;
}) {
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
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
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
        <kbd className="rounded border border-line px-1.5 py-0.5 text-[0.625rem] text-text-dim">
          /
        </kbd>
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
                  <img
                    src={image}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded bg-surface-raised object-cover"
                  />
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
          <li className="px-2 py-4 text-sm text-text-muted">
            No matching {sport} exercises.
          </li>
        )}
      </ul>
    </aside>
  );
}
