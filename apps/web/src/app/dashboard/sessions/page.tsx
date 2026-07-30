"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import {
  applySuggestions,
  fetchHistory,
  fetchSuggestions,
  listSessions,
  listWorkouts,
  setsFromWorkout,
  SPORTS,
  startSession,
  type History,
  type Session,
  type Sport,
  type Workout,
} from "@/lib/api";
import {
  delta,
  formatDayLong,
  formatDuration,
  localZone,
  PERIODS,
  periodRange,
  sportLabel,
  type PeriodKey,
} from "@/lib/history";
import { formatTonnage, type UnitSystem } from "@/lib/units";
import { useUnits } from "@/lib/useUnits";

import { TrainingCalendar } from "./TrainingCalendar";
import { VolumeTrend } from "./VolumeTrend";

/**
 * Training history.
 *
 * The web half of logging is review-shaped rather than mid-set-shaped: a wide
 * screen is where you look back over a block, spot that the top set stalled
 * three weeks running, and read numbers you tapped in one-handed at a rack.
 *
 * Every figure here is computed by the API, not this page. That's deliberate
 * — the working-set rule has drifted between a client copy and the server
 * twice already, and a total summed from a capped listing would start
 * under-reporting the moment someone's history outgrew the page size. The
 * only arithmetic here buckets days the server already rolled up.
 */
/** What the period list shows before you narrow it. A day picked on the
 *  calendar is fetched on its own, so this cap never hides one. */
const LIST_LIMIT = 100;

export default function HistoryPage() {
  const { getToken } = useAuth();
  const { units } = useUnits();
  const router = useRouter();

  const [period, setPeriod] = useState<PeriodKey>("3m");
  const [sport, setSport] = useState<Sport | null>(null);
  const [day, setDay] = useState<string | null>(null);

  const [history, setHistory] = useState<History | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  // Null while a picked day's own fetch is in flight.
  const [daySessions, setDaySessions] = useState<Session[] | null>(null);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // The range and zone are resolved per fetch rather than at render: both
  // depend on the browser's clock and timezone, which the server doesn't
  // share during SSR, so computing them at render would hydrate mismatched.
  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const tz = localZone();
      const [h, list] = await Promise.all([
        fetchHistory(getToken, { from, to, sport: sport ?? undefined, tz }, controller.signal),
        listSessions(
          getToken,
          { from, to, tz, sport: sport ?? undefined, limit: LIST_LIMIT },
          controller.signal,
        ),
      ]);
      if (controller.signal.aborted) return;
      setHistory(h);
      setSessions(list);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      // Cleared, not kept. Leaving the previous period's totals on screen
      // under a new period's pressed button is worse than showing nothing —
      // the numbers look current and aren't.
      setHistory(null);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setEverLoaded(true);
      }
    }
  }, [getToken, period, sport]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Templates don't depend on the period or the sport, so they don't belong
  // in the reload every chip click triggers.
  useEffect(() => {
    const c = new AbortController();
    listWorkouts(getToken, "mine", c.signal)
      .then(setWorkouts)
      .catch(() => {});
    return () => c.abort();
  }, [getToken]);

  // A picked day is fetched for itself rather than filtered out of the
  // listing above. The listing is capped, so past that cap a day the calendar
  // shows as trained would have listed "nothing logged" — the calendar and
  // the list contradicting each other, which is the exact failure the
  // server-side totals exist to avoid, re-entering by the back door.
  useEffect(() => {
    if (!day) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDaySessions(null);
      return;
    }
    const c = new AbortController();
    listSessions(
      getToken,
      { from: day, to: day, tz: localZone(), sport: sport ?? undefined },
      c.signal,
    )
      .then(setDaySessions)
      .catch(() => {});
    return () => c.abort();
  }, [getToken, day, sport]);

  // Changing the scope clears a day picked inside the old one, or the list
  // filters to a date the calendar no longer shows.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDay(null);
  }, [period, sport]);

  async function start(s: Sport, label: string, workout?: Workout) {
    if (starting) return;
    setStarting(true);
    try {
      let sets = workout ? setsFromWorkout(workout.items) : [];
      if (sets.length > 0) {
        try {
          sets = applySuggestions(
            sets,
            await fetchSuggestions(getToken, sets.map((x) => x.exercise_id)),
          );
        } catch {
          // A failed lookup must not stop the session starting.
        }
      }
      const { session } = await startSession(getToken, {
        sport: s,
        name: workout ? workout.name : `${label} session`,
        workout_id: workout ? workout.id : null,
        sets,
      });
      router.push(`/dashboard/sessions/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  const live = sessions.filter((s) => s.ended_at === null);
  const shown = useMemo(() => {
    const source = day ? (daySessions ?? []) : sessions;
    return source.filter((s) => s.ended_at !== null);
  }, [sessions, daySessions, day]);

  const t = history?.totals;
  const p = history?.previous;
  const nothingHere = !!t && t.sessions === 0 && live.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Training</p>
          <h1 className="font-display text-4xl font-bold">History</h1>
        </div>
        <NewSessionMenu workouts={workouts} disabled={starting} onStart={start} />
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented
          label="Period"
          options={PERIODS.map((x) => ({ key: x.key, label: x.label }))}
          value={period}
          onChange={(k) => setPeriod(k as PeriodKey)}
        />
        <SportChips counts={history?.sports ?? []} value={sport} onChange={setSport} />
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => load()}
            className="rounded-pill border border-line px-3 py-1 text-xs font-medium transition hover:bg-surface-raised"
          >
            Try again
          </button>
        </div>
      )}

      {!everLoaded ? (
        <Skeleton />
      ) : !history || nothingHere ? (
        error ? null : (
          <EmptyState
            hasAnyWorkout={workouts.length > 0}
            filtered={sport !== null || period !== "1y"}
          />
        )
      ) : (
        <div
          aria-busy={loading}
          className={`flex flex-col gap-8 transition-opacity ${loading ? "opacity-50" : ""}`}
        >
          <section aria-label="Totals for the selected period">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat
                label="Sessions"
                value={String(t!.sessions)}
                change={delta(t!.sessions, p!.sessions)}
              />
              <Stat
                label="Days trained"
                value={String(t!.active_days)}
                change={delta(t!.active_days, p!.active_days)}
              />
              <Stat
                label="Working sets"
                value={t!.working_sets > 0 ? String(t!.working_sets) : "—"}
                change={delta(t!.working_sets, p!.working_sets)}
              />
              <Stat
                label="Tonnage"
                value={t!.tonnage_kg > 0 ? formatTonnage(t!.tonnage_kg, units) : "—"}
                change={delta(t!.tonnage_kg, p!.tonnage_kg)}
              />
              <Stat
                label="Time"
                value={t!.duration_seconds > 0 ? formatDuration(t!.duration_seconds) : "—"}
                change={delta(t!.duration_seconds, p!.duration_seconds)}
              />
            </dl>
            <p className="mt-2 text-xs text-text-dim">
              Compared with the {periodLength(period)} before.
            </p>
          </section>

          <TrainingCalendar
            from={history.from}
            to={history.to}
            days={history.days}
            selected={day}
            onSelect={setDay}
          />

          <VolumeTrend from={history.from} to={history.to} days={history.days} />

          {live.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow">In progress</h2>
              <ul className="flex flex-col gap-2">
                {live.map((s) => (
                  <SessionRow key={s.id} session={s} units={units} />
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="eyebrow">
                {day
                  ? formatDayLong(day)
                  : `${shown.length} ${shown.length === 1 ? "session" : "sessions"}`}
              </h2>
              {day && (
                <button
                  type="button"
                  onClick={() => setDay(null)}
                  className="rounded-pill border border-line px-3 py-1 text-xs font-medium transition hover:bg-surface-raised"
                >
                  Clear day
                </button>
              )}
            </div>
            {shown.length === 0 ? (
              <p className="rounded-card border border-dashed border-line px-6 py-10 text-center text-sm text-text-muted">
                {day ? "Nothing logged on this day." : "No completed sessions in this period."}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {shown.map((s) => (
                  <SessionRow key={s.id} session={s} units={units} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function periodLength(p: PeriodKey): string {
  return p === "4w" ? "4 weeks" : p === "3m" ? "3 months" : "year";
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-pill border border-line bg-surface p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`rounded-pill px-4 py-1.5 text-sm font-medium transition ${
            value === o.key
              ? "bg-accent-fill text-accent-on-fill"
              : "text-text-muted hover:text-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Sport filter. The counts come from the *unfiltered* breakdown on purpose —
 * a chip that says how much it would find is worth clicking; one showing its
 * own filtered result would read "0" for everything you aren't already on.
 */
function SportChips({
  counts,
  value,
  onChange,
}: {
  counts: { sport: Sport; sessions: number }[];
  value: Sport | null;
  onChange: (s: Sport | null) => void;
}) {
  if (counts.length < 2) return null;
  const total = counts.reduce((n, c) => n + c.sessions, 0);
  return (
    <div role="group" aria-label="Sport" className="flex flex-wrap items-center gap-1.5">
      <Chip active={value === null} onClick={() => onChange(null)}>
        All <span className="text-text-dim">{total}</span>
      </Chip>
      {counts.map((c) => (
        <Chip key={c.sport} active={value === c.sport} onClick={() => onChange(c.sport)}>
          {sportLabel(c.sport)} <span className="text-text-dim">{c.sessions}</span>
        </Chip>
      ))}
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
      className={`rounded-pill border px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "border-text bg-surface-raised"
          : "border-line text-text-muted hover:bg-surface-raised"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One headline number and where it's heading.
 *
 * The arrow is deliberately colour-neutral. Up is not automatically good:
 * more tonnage in a build block is progress, more in a deload week means the
 * deload didn't happen. Stating the change and leaving the judgement to
 * whoever knows what the block was for is the honest version.
 */
function Stat({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: number | null;
}) {
  const rounded = change === null ? null : Math.round(change);
  // A dash means the measure doesn't apply here — tonnage under a month of
  // BJJ. Captioning that "no prior period" invites the reader to wonder what
  // changed about a number that was never going to exist.
  const absent = value === "—";
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <dt className="eyebrow text-[0.625rem]">{label}</dt>
      <dd className="stat mt-0.5 text-2xl">{value}</dd>
      {absent ? null : rounded !== null && rounded !== 0 ? (
        <p className="mt-1 text-xs text-text-muted">
          <span aria-hidden="true">{rounded > 0 ? "↑" : "↓"}</span> {Math.abs(rounded)}%{" "}
          <span className="text-text-dim">{rounded > 0 ? "more" : "less"}</span>
        </p>
      ) : (
        <p className="mt-1 text-xs text-text-dim">
          {rounded === 0 ? "no change" : "no prior period"}
        </p>
      )}
    </div>
  );
}

function NewSessionMenu({
  workouts,
  disabled,
  onStart,
}: {
  workouts: Workout[];
  disabled: boolean;
  onStart: (sport: Sport, label: string, workout?: Workout) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Click-away and Escape. A menu you can only dismiss by picking something
  // is a trap, and this one covers the page's primary content.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Back to the trigger. Without this focus lands on <body> and a
      // keyboard user restarts from the top of the document.
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="true"
        className="rounded-pill bg-accent-fill px-5 py-2.5 text-sm font-semibold text-accent-on-fill transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        New session
      </button>

      {/* Deliberately no role="menu": that would promise arrow-key navigation
          and put screen readers into application mode, where Tab can be
          swallowed by a widget that doesn't implement the keys it advertised.
          A plain list of buttons is fully operable today with nothing added. */}
      {open && (
        <div
          className="absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-card border border-line bg-surface shadow-lg"
        >
          {workouts.length > 0 && (
            <>
              <p className="eyebrow px-4 pt-3 pb-1 text-[0.625rem]">From a workout</p>
              <ul className="max-h-64 overflow-y-auto">
                {workouts.map((w) => (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onStart(w.sport, w.name, w);
                      }}
                      className="w-full px-4 py-2 text-left transition hover:bg-surface-hover"
                    >
                      <span className="block truncate text-sm font-medium">{w.name}</span>
                      <span className="block truncate text-xs capitalize text-text-dim">
                        {w.sport} · {w.items.length}{" "}
                        {w.items.length === 1 ? "exercise" : "exercises"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="eyebrow border-t border-line-soft px-4 pt-3 pb-1 text-[0.625rem]">
            Empty session
          </p>
          <ul className="pb-2">
            {SPORTS.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onStart(s.key, s.label);
                  }}
                  className="w-full px-4 py-2 text-left text-sm transition hover:bg-surface-hover"
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// `units` is passed in, not read from useUnits() here. The hook fetches the
// profile per call site with no shared cache, so a hook call in this row cost
// one GET /v1/profile *per session rendered* — 200 identical requests for one
// account-level enum the page already holds. Exactly the amplification this
// codebase just finished removing from the mobile save path.
function SessionRow({ session, units }: { session: Session; units: UnitSystem }) {
  // Completed, non-warm-up sets — the backend's own working-volume rule. The
  // `completed` half was missed when progressive volume landed, so this row
  // showed a session's full tonnage while the detail page showed zero for
  // the same session.
  const working = session.sets.filter((s) => s.completed && s.set_type !== "warmup");
  const tonnage = working.reduce((sum, s) => sum + (s.reps ?? 0) * (s.weight_kg ?? 0), 0);
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
            {session.ended_at === null && <span className="text-warn"> · in progress</span>}
          </p>
        </div>

        <Metric
          label="Duration"
          value={
            session.ended_at
              ? formatDuration(
                  (new Date(session.ended_at).getTime() -
                    new Date(session.started_at).getTime()) /
                    1000,
                )
              : "—"
          }
        />
        <Metric label="Exercises" value={String(exercises)} />
        <Metric label="Working sets" value={String(working.length)} />
        <Metric label="Tonnage" value={tonnage > 0 ? formatTonnage(tonnage, units) : "—"} />
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

/** Shaped like the real thing, so the layout doesn't jump when data lands. */
function Skeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading history">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className="h-[86px] animate-pulse rounded-card border border-line bg-surface"
          />
        ))}
      </div>
      <div className="h-28 animate-pulse rounded-card bg-surface" />
      <div className="h-40 animate-pulse rounded-card border border-line bg-surface" />
    </div>
  );
}

function EmptyState({
  hasAnyWorkout,
  filtered,
}: {
  hasAnyWorkout: boolean;
  filtered: boolean;
}) {
  return (
    <div className="rounded-card border border-dashed border-line px-6 py-16 text-center">
      <p className="font-display text-xl font-bold">
        {filtered ? "Nothing in this period" : "No history yet"}
      </p>
      <p className="mx-auto mt-2 max-w-sm text-sm text-text-muted">
        {filtered
          ? "Try a longer period, or a different sport."
          : hasAnyWorkout
            ? "Log a session and it'll show up here — the calendar and totals fill in as you train."
            : "Build a workout first, then every session you log lands here."}
      </p>
      {!filtered && !hasAnyWorkout && (
        <Link
          href="/dashboard/workouts"
          className="mt-4 inline-block rounded-pill bg-accent-fill px-5 py-2.5 text-sm font-semibold text-accent-on-fill transition hover:opacity-90"
        >
          Build a workout
        </Link>
      )}
    </div>
  );
}
