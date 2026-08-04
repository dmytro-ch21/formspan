"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  createPlan,
  deletePlan,
  fetchHistory,
  labelForModule,
  listPlans,
  listWorkouts,
  type History,
  type Plan,
  type Workout,
} from "@/lib/api";
import {
  addMonths,
  formatDayLong,
  formatDuration,
  localZone,
  monthGrid,
  today,
} from "@/lib/history";
import { useModules } from "@/lib/ModulesProvider";

/**
 * The calendar — web's half of planning.
 *
 * The platform rule puts authoring here and live logging on the phone, and
 * this is the clearest case of it: a month grid needs width, and choosing what
 * next week looks like is a desk activity. The phone shows the *day* and
 * starts it; this shows the shape of a block and lets you move things around.
 *
 * **Two layers, never conflated.** Green is what happened (from
 * `/sessions/history`, the same per-day rollup the heatmap uses); lime is what
 * was planned (`/plans`). They are deliberately not reconciled — a planned day
 * can be trained twice, ignored, or trained with something else, so a plan is
 * never "consumed" by a session. Adherence is a comparison the reader makes,
 * and later a query, not a status this screen invents.
 *
 * **Two panes**, matching the workout builder: the grid keeps its shape while
 * the selected day's detail and its planning form sit beside it. A dialog over
 * the grid would hide the thing you are planning against.
 */

/** Sunday-last week header, matching `startOfWeek`'s Monday-first grid. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function CalendarPage() {
  const { getToken } = useAuth();
  const { modules } = useModules();

  // The month being browsed, as its own first day. A key rather than a Date
  // for the same reason `history.ts` uses keys throughout: `new Date("2026-08-04")`
  // parses as UTC, so west of Greenwich it renders as the 3rd.
  const [month, setMonth] = useState(() => `${today().slice(0, 7)}-01`);
  const [selected, setSelected] = useState<string>(() => today());

  const [history, setHistory] = useState<History | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const range = useMemo(() => {
    const weeks = monthGrid(month);
    // The whole grid, not just the month — the spill days are visible cells
    // and must carry their own marks, or the last week of the month looks
    // empty until you page forward.
    return { from: weeks[0][0], to: weeks[weeks.length - 1][6] };
  }, [month]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const [hist, planned, mine] = await Promise.all([
        fetchHistory(getToken, { ...range, tz: localZone() }, controller.signal),
        listPlans(getToken, range, controller.signal),
        listWorkouts(getToken, "mine", controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setHistory(hist);
      setPlans(planned);
      setWorkouts(mine);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setEverLoaded(true);
    }
  }, [getToken, range]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const trainedByDay = useMemo(
    () => new Map((history?.days ?? []).map((d) => [d.date, d])),
    [history],
  );
  const plansByDay = useMemo(() => {
    const map = new Map<string, Plan[]>();
    for (const p of plans) {
      const list = map.get(p.day);
      if (list) list.push(p);
      else map.set(p.day, [p]);
    }
    return map;
  }, [plans]);

  const workoutName = useCallback(
    (id: string | null) => (id ? (workouts.find((w) => w.id === id)?.name ?? null) : null),
    [workouts],
  );

  const weeks = useMemo(() => monthGrid(month), [month]);
  const thisMonth = month.slice(0, 7);
  const todayKey = today();

  async function addPlan(sport: string, workoutID: string | null) {
    setBusy(true);
    try {
      await createPlan(getToken, { day: selected, sport, workoutID });
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removePlan(id: string) {
    setBusy(true);
    try {
      await deletePlan(getToken, id);
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}T00:00:00Z`));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Plan</p>
          <h1 className="font-display text-4xl font-bold">Calendar</h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMonth(addMonths(month, -1))}
            className="rounded-control border border-line px-3 py-1.5 text-sm transition hover:bg-surface-hover"
            aria-label="Previous month"
          >
            ←
          </button>
          <span className="stat min-w-44 text-center text-lg">{monthLabel}</span>
          <button
            type="button"
            onClick={() => setMonth(addMonths(month, 1))}
            className="rounded-control border border-line px-3 py-1.5 text-sm transition hover:bg-surface-hover"
            aria-label="Next month"
          >
            →
          </button>
          <button
            type="button"
            onClick={() => {
              setMonth(`${todayKey.slice(0, 7)}-01`);
              setSelected(todayKey);
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm transition hover:bg-surface-hover"
          >
            Today
          </button>
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="min-w-0">
          <div className="mb-2 grid grid-cols-7 gap-1.5">
            {WEEKDAYS.map((d) => (
              <div key={d} className="eyebrow px-1 text-center">
                {d}
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            {weeks.map((week) => (
              <div key={week[0]} className="grid grid-cols-7 gap-1.5">
                {week.map((day) => {
                  const inMonth = day.startsWith(thisMonth);
                  const trained = trainedByDay.get(day);
                  const dayPlans = plansByDay.get(day) ?? [];
                  const isToday = day === todayKey;
                  const isSelected = day === selected;

                  const trainedLabel = trained
                    ? trained.sports.map((s) => labelForModule(modules, s)).join(", ") ||
                      "Trained"
                    : null;

                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => setSelected(day)}
                      aria-pressed={isSelected}
                      // The chips are folded IN, because `aria-label` replaces
                      // the accessible name entirely — it does not add to it.
                      // With just the date here, a screen reader announced
                      // "Tuesday, 4 August" and nothing about what was on the
                      // day, so the cell's whole payload was invisible to
                      // assistive tech. This is also the only place the two
                      // layers are named in words rather than shown.
                      aria-label={[
                        formatDayLong(day),
                        // `trained: a session` rather than `trained: Trained`,
                        // which is what the chip's own fallback produces when a
                        // day rolls up with no sport on it.
                        trained
                          ? `trained: ${
                              trained.sports.length > 0 ? trainedLabel : "a session"
                            }`
                          : null,
                        dayPlans.length > 0
                          ? `planned: ${dayPlans
                              .map(
                                (p) =>
                                  workoutName(p.workout_id) ??
                                  labelForModule(modules, p.sport),
                              )
                              .join(", ")}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(". ")}
                      className={[
                        "flex min-h-24 flex-col gap-1 rounded-card border p-1.5 text-left transition",
                        isSelected
                          ? "border-accent-fill bg-surface-raised"
                          : "border-line bg-surface hover:bg-surface-hover",
                        // Spill days stay legible but recede — a blank cell
                        // reads as a rendering fault, not as another month.
                        inMonth ? "" : "opacity-45",
                      ].join(" ")}
                    >
                      <span
                        className={[
                          "stat inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm",
                          isToday
                            ? "bg-accent-fill text-accent-on-fill"
                            : "text-text-muted",
                        ].join(" ")}
                      >
                        {Number(day.slice(8, 10))}
                      </span>

                      <span className="flex min-w-0 flex-col gap-1">
                        {/* What happened, first. The rollup is per-day, so a
                            day with two sessions is one chip naming both
                            disciplines rather than a fabricated split. */}
                        {trainedLabel && <Chip kind="trained" label={trainedLabel} />}

                        {dayPlans.map((p) => (
                          <Chip
                            key={p.id}
                            kind="planned"
                            label={
                              workoutName(p.workout_id) ??
                              labelForModule(modules, p.sport)
                            }
                          />
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Real chips, not swatches. A legend of coloured dots teaches only
              the colour — which is the channel a colour-blind reader cannot
              use, so it taught them nothing. Showing the actual solid and
              dashed treatments makes the legend teach what the cells show. */}
          <div className="mt-3 flex items-center gap-3 text-xs text-text-muted">
            <Chip kind="trained" label="Trained" />
            <Chip kind="planned" label="Planned" />
            {!everLoaded && <span>Loading…</span>}
          </div>
        </section>

        <DayPanel
          day={selected}
          trained={trainedByDay.get(selected) ?? null}
          plans={plansByDay.get(selected) ?? []}
          workouts={workouts}
          workoutName={workoutName}
          busy={busy}
          onAdd={addPlan}
          onRemove={removePlan}
        />
      </div>
    </div>
  );
}

/**
 * One entry in a day cell: what was trained, or what is planned.
 *
 * **The two are never distinguished by colour alone.** Green and lime are
 * adjacent hues, rendered here at 10% on a light ground, and a day that is
 * both trained AND planned as the same discipline renders the same word twice
 * — so for a colour-blind reader the two chips were literally identical. That
 * is the one place this screen conflated the two layers it exists to keep
 * apart, which made it worth fixing rather than noting.
 *
 * **The marker is a text glyph, not a coloured dot, and that is measured.**
 * The first version of this fix used a filled dot for trained and a hollow
 * ring for planned, which works on mobile (dark ground: 12.8:1 and 15.1:1) and
 * fails here. On web's light default:
 *
 *   green dot on white        1.43:1
 *   green border at 40%       1.19:1
 *   lime border at 60%        1.95:1
 *   chip text                18.28:1
 *
 * WCAG 1.4.11 wants 3:1 for a non-text control. So the trained chip's dot AND
 * border were both effectively invisible — "solid versus dashed" was comparing
 * an invisible border against a faint one, and a fix resting on it would have
 * been a fix in name only. `globals.css` says exactly this in its own words:
 * the brand green "is only legible as a *fill* against dark".
 *
 * The chip's text is the one channel with guaranteed contrast, so the meaning
 * rides on it: **✓ for what happened, ○ for what is intended**, in the same
 * ink as the label. Greyscale-safe by construction, and it survives any future
 * change to the palette.
 *
 * **The glyph is the channel; the border and tint are reinforcement.** An
 * earlier draft of this comment called them two channels "either of which is
 * enough on its own", which measurement does not support: a 1px dash on an
 * 11px chip is a sub-pixel cue that antialiasing degrades further, and it is
 * reinforcement rather than an independent signal. Saying otherwise would
 * invite someone to later drop the glyph on the strength of it.
 *
 * The borders now draw with the **ink** steps at near-full strength, because
 * they have to clear 3:1 to be a signal at all: green-ink needs ≥70% alpha on
 * white and lime needs ≥95%, so the old `/40` and `/60` were both invisible.
 * The 10% fills stay as fills — they are decoration, not a signal, and are not
 * held to that floor.
 *
 * The glyph is `aria-hidden`: the day button's own label names both layers in
 * words, so announcing it would only repeat them.
 */
function Chip({ kind, label }: { kind: "trained" | "planned"; label: string }) {
  const trained = kind === "trained";
  return (
    <span
      className={[
        "flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] font-medium",
        trained
          ? "border border-green-ink/80 bg-green/10"
          : "border border-dashed border-lime bg-lime/10",
      ].join(" ")}
    >
      <span aria-hidden="true" className="shrink-0 leading-none text-text-muted">
        {trained ? "✓" : "○"}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * The selected day: what happened on it, what is planned, and a way to plan
 * more.
 *
 * The form is a plain sport picker plus an optional template, because those
 * are the only two facts a plan carries. A discipline with no template is a
 * complete plan — "Tuesday is BJJ" — so the template select defaults to none
 * rather than to the first workout.
 */
function DayPanel({
  day,
  trained,
  plans,
  workouts,
  workoutName,
  busy,
  onAdd,
  onRemove,
}: {
  day: string;
  trained: History["days"][number] | null;
  plans: Plan[];
  workouts: Workout[];
  workoutName: (id: string | null) => string | null;
  busy: boolean;
  onAdd: (sport: string, workoutID: string | null) => void;
  onRemove: (id: string) => void;
}) {
  const { modules } = useModules();
  // is_sport, not merely enabled: "plan a nutrition session" has no session
  // and no screen behind it. Same rule the API enforces.
  const sports = modules.filter((m) => m.enabled && m.is_sport);

  // Both selections are DERIVED from the choice plus what is currently
  // available, rather than stored and then corrected by an effect.
  //
  // The effect version rendered the wrong value for a frame and fixed it on
  // the next pass — visible as the template select flashing a stale option
  // when the discipline changed, and flagged by `react-hooks/set-state-in-effect`
  // for exactly that reason. Deriving means there is no wrong frame to fix.
  const [chosenSport, setChosenSport] = useState<string | null>(null);
  const sport = chosenSport ?? sports[0]?.key ?? "";

  const [chosenWorkout, setChosenWorkout] = useState("");
  const forSport = workouts.filter((w) => w.sport === sport);
  // A template belongs to exactly one discipline. One left over from a
  // previous choice reads as none here rather than being cleared — otherwise
  // a BJJ day could carry a strength template, which the API rejects and the
  // reader would not understand.
  const workoutID = forSport.some((w) => w.id === chosenWorkout)
    ? chosenWorkout
    : "";

  return (
    <aside className="flex h-fit flex-col gap-4 rounded-card border border-line bg-surface p-4">
      <div>
        <p className="eyebrow">Selected</p>
        <h2 className="font-display text-xl font-bold">{formatDayLong(day)}</h2>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="eyebrow">Trained</h3>
        {trained ? (
          <p className="text-sm">
            {trained.sessions === 1 ? "1 session" : `${trained.sessions} sessions`}
            {trained.duration_seconds > 0 &&
              ` · ${formatDuration(trained.duration_seconds)}`}
          </p>
        ) : (
          <p className="text-sm text-text-dim">Nothing logged.</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="eyebrow">Planned</h3>
        {plans.length === 0 ? (
          <p className="text-sm text-text-dim">Nothing planned.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {plans.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-control border border-line px-2.5 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {workoutName(p.workout_id) ?? labelForModule(modules, p.sport)}
                  </span>
                  <span className="block text-xs text-text-dim">
                    {labelForModule(modules, p.sport)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(p.id)}
                  disabled={busy}
                  className="shrink-0 text-xs text-text-muted transition hover:text-danger disabled:opacity-50"
                  aria-label={`Remove ${
                    workoutName(p.workout_id) ?? labelForModule(modules, p.sport)
                  } from ${formatDayLong(day)}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        className="flex flex-col gap-2 border-t border-line-soft pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (sport) onAdd(sport, workoutID || null);
        }}
      >
        <h3 className="eyebrow">Add to this day</h3>

        {sports.length === 0 ? (
          <p className="text-sm text-text-dim">
            Turn on a discipline in Settings and it becomes plannable here.
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">Discipline</span>
              <select
                value={sport}
                onChange={(e) => setChosenSport(e.target.value)}
                className="rounded-control border border-line bg-surface px-2.5 py-2"
              >
                {sports.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">Template</span>
              <select
                value={workoutID}
                onChange={(e) => setChosenWorkout(e.target.value)}
                className="rounded-control border border-line bg-surface px-2.5 py-2"
              >
                {/* Not "pick one" — none is a legitimate, complete plan. */}
                <option value="">None — an empty session</option>
                {forSport.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              disabled={busy || !sport}
              className="mt-1 rounded-control bg-accent-fill px-3 py-2 text-sm font-semibold text-accent-on-fill transition disabled:opacity-50"
            >
              {busy ? "Saving…" : "Add to plan"}
            </button>
          </>
        )}
      </form>
    </aside>
  );
}
