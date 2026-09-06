"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import {
  applySuggestions,
  fetchHistory,
  sessionVolume,
  fetchSuggestions,
  listSessionsPage,
  listWorkouts,
  setsFromWorkout,
  startSession,
  type History,
  type Session,
  type SessionPage,
  type Sport,
  type Workout,
  enabledSports,
} from "@/lib/api";
import { labelForModule } from "@/lib/modules";
import { useModules } from "@/lib/ModulesProvider";
import {
  delta,
  formatDayLong,
  formatDuration,
  localZone,
  PERIODS,
  periodRange,
  type PeriodKey,
} from "@/lib/history";
import { formatVolume, type UnitSystem } from "@/lib/units";
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
/**
 * Sessions per page.
 *
 * The list used to fetch a flat 100 and stop, so a year of training simply
 * ended two-thirds of the way down with nothing saying so. Twenty is about a
 * month of training — enough to scan, small enough that the request stays
 * quick even though every session drags its sets along.
 */
const PAGE_SIZE = 20;

export default function HistoryPage() {
  const { getToken } = useAuth();
  const { units } = useUnits();
  const router = useRouter();

  const [period, setPeriod] = useState<PeriodKey>("3m");
  const [sport, setSport] = useState<Sport | null>(null);
  const [day, setDay] = useState<string | null>(null);

  const [history, setHistory] = useState<History | null>(null);
  // What's typed, and what's actually been asked for — separated so every
  // keystroke doesn't become a request.
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<SessionPage | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
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
      const h = await fetchHistory(
        getToken,
        { from, to, sport: sport ?? undefined, tz },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setHistory(h);
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

  // Typing shouldn't be a request per character.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // The list is paged on the server, so it asks for exactly the rows it draws
  // rather than a capped batch it filters down. A picked day narrows the
  // range like any other filter — which is also what stops the calendar and
  // the list disagreeing about a day past the old cap.
  useEffect(() => {
    const c = new AbortController();
    const { from, to } = day ? { from: day, to: day } : periodRange(period);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setListLoading(true);
    listSessionsPage(
      getToken,
      {
        from,
        to,
        tz: localZone(),
        sport: sport ?? undefined,
        q: query || undefined,
        limit: PAGE_SIZE,
        offset,
      },
      c.signal,
    )
      .then((p) => {
        if (c.signal.aborted) return;
        setPage(p);
        setListFailed(false);
      })
      .catch(() => {
        if (!c.signal.aborted) {
          setPage(null);
          setListFailed(true);
        }
      })
      .finally(() => {
        if (!c.signal.aborted) setListLoading(false);
      });
    return () => c.abort();
  }, [getToken, period, sport, day, query, offset]);

  // Any change of scope starts again at the first page — staying on page 4 of
  // a result set that now has one page shows an empty list over a non-zero
  // count, which reads as a bug.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffset(0);
  }, [period, sport, day, query]);

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
            await fetchSuggestions(
              getToken,
              sets.map((x) => x.exercise_id),
              workout?.goal ?? null,
              undefined,
              undefined,
              // N473/#812 item 8 — see fetchSuggestions's own doc comment.
              units,
              // N494/#864 — see fetchSuggestions's own doc comment.
              workout?.id,
            ),
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

  const rows = useMemo(() => page?.sessions ?? [], [page]);
  // Lifted into their own section only on the unfiltered first page, where
  // "what's still open" is a useful thing to put at the top.
  const live = useMemo(
    () =>
      offset === 0 && !query ? rows.filter((s) => s.ended_at === null) : [],
    [rows, offset, query],
  );
  // Anywhere else they stay in the list rather than being filtered out of it.
  // Removing them unconditionally meant a search for an in-progress session
  // counted it in the total and then rendered "no sessions matching" — the
  // page contradicting itself about a session that exists. SessionRow already
  // badges them "in progress", so they read correctly inline.
  const shown = useMemo(
    () => (live.length > 0 ? rows.filter((s) => s.ended_at !== null) : rows),
    [rows, live],
  );
  const total = page?.total ?? 0;

  const t = history?.totals;
  const p = history?.previous;
  const nothingHere = !!t && t.sessions === 0 && live.length === 0 && !query;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Training</p>
          <h1 className="font-display text-4xl font-bold">History</h1>
        </div>
        <NewSessionMenu
          workouts={workouts}
          disabled={starting}
          onStart={start}
        />
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented
          label="Period"
          options={PERIODS.map((x) => ({ key: x.key, label: x.label }))}
          value={period}
          onChange={(k) => setPeriod(k as PeriodKey)}
        />
        <SportChips
          counts={history?.sports ?? []}
          value={sport}
          onChange={setSport}
        />
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
                label="Volume"
                value={
                  t!.tonnage_kg > 0 ? formatVolume(t!.tonnage_kg, units) : "—"
                }
                change={delta(t!.tonnage_kg, p!.tonnage_kg)}
              />
              <Stat
                label="Time"
                value={
                  t!.duration_seconds > 0
                    ? formatDuration(t!.duration_seconds)
                    : "—"
                }
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

          <VolumeTrend
            from={history.from}
            to={history.to}
            days={history.days}
          />

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
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* The count lives here, not only in the pager, because the
                  list is scoped by the period above it — searching "Lower"
                  inside 3 months finds fewer than searching a year, and
                  without a number that reads as missing data. */}
              <h2 className="eyebrow">
                {day ? formatDayLong(day) : "Sessions"}
                {total > 0 && (
                  <span className="ml-2 text-text-dim">
                    {total} {total === 1 ? "session" : "sessions"}
                  </span>
                )}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative">
                  <span className="sr-only">Search sessions by name</span>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name…"
                    maxLength={100}
                    className="w-56 rounded-pill border border-line bg-surface px-4 py-1.5 text-sm placeholder:text-text-dim focus-visible:border-text"
                  />
                </label>
                {day && (
                  <button
                    type="button"
                    onClick={() => setDay(null)}
                    className="rounded-pill border border-line px-3 py-1.5 text-xs font-medium transition hover:bg-surface-raised"
                  >
                    Clear day
                  </button>
                )}
              </div>
            </div>

            {/* Always mounted, so narrowing a search, changing page and the
                busy state all announce. The Pager's own region unmounts as
                soon as there's one page, which is exactly when a search has
                just succeeded. */}
            <p role="status" aria-live="polite" className="sr-only">
              {listLoading
                ? "Loading sessions"
                : listFailed
                  ? "Couldn't load sessions"
                  : `${total} ${total === 1 ? "session" : "sessions"}${query ? ` matching ${query}` : ""}`}
            </p>

            {listFailed ? (
              <p
                role="alert"
                className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
              >
                Couldn&apos;t load these sessions.
              </p>
            ) : shown.length === 0 && !listLoading ? (
              <p className="rounded-card border border-dashed border-line px-6 py-10 text-center text-sm text-text-muted">
                {query
                  ? `No sessions matching “${query}”.`
                  : day
                    ? "Nothing logged on this day."
                    : "No completed sessions in this period."}
              </p>
            ) : (
              <ul
                aria-busy={listLoading}
                className={`flex flex-col gap-2 transition-opacity ${listLoading ? "opacity-50" : ""}`}
              >
                {shown.map((s) => (
                  <SessionRow key={s.id} session={s} units={units} />
                ))}
              </ul>
            )}

            {/* Fed from the server's echoed offset, not local state — local
                state moves on click, so the range briefly read "41–60 of 43"
                before the page landed, and announced it via aria-live. */}
            <Pager
              total={total}
              offset={page?.offset ?? 0}
              count={rows.length}
              onOffset={setOffset}
            />
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
  // Before the early return, same rules-of-hooks reason as TrainingCalendar.
  const { modules } = useModules();
  if (counts.length < 2) return null;
  const total = counts.reduce((n, c) => n + c.sessions, 0);
  return (
    <div
      role="group"
      aria-label="Sport"
      className="flex flex-wrap items-center gap-1.5"
    >
      <Chip active={value === null} onClick={() => onChange(null)}>
        All <span className="text-text-dim">{total}</span>
      </Chip>
      {counts.map((c) => (
        <Chip
          key={c.sport}
          active={value === c.sport}
          onClick={() => onChange(c.sport)}
        >
          {labelForModule(modules, c.sport)}{" "}
          <span className="text-text-dim">{c.sessions}</span>
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
 * more volume in a build block is progress, more in a deload week means the
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
  // A dash means the measure doesn't apply here — volume under a month of
  // BJJ. Captioning that "no prior period" invites the reader to wonder what
  // changed about a number that was never going to exist.
  const absent = value === "—";
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <dt className="eyebrow text-[0.625rem]">{label}</dt>
      <dd className="stat mt-0.5 text-2xl">{value}</dd>
      {absent ? null : rounded !== null && rounded !== 0 ? (
        <p className="mt-1 text-xs text-text-muted">
          <span aria-hidden="true">{rounded > 0 ? "↑" : "↓"}</span>{" "}
          {Math.abs(rounded)}%{" "}
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
  const { modules } = useModules();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Click-away and Escape. A menu you can only dismiss by picking something
  // is a trap, and this one covers the page's primary content.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
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
        <div className="absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-card border border-line bg-surface shadow-lg">
          {workouts.length > 0 && (
            <>
              <p className="eyebrow px-4 pt-3 pb-1 text-[0.625rem]">
                From a workout
              </p>
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
                      <span className="block truncate text-sm font-medium">
                        {w.name}
                      </span>
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
            {enabledSports(modules).map((s) => (
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
function SessionRow({
  session,
  units,
}: {
  session: Session;
  units: UnitSystem;
}) {
  // Both figures come from `lib/api` now, not from a reduce written here.
  // Three separate bugs have lived on that reduce — see `sessionVolume`, where
  // the rule is stated once and can actually be tested.
  const { working_sets: workingSets, tonnage_kg: volume } = sessionVolume(
    session.sets,
  );
  const exercises = new Set(session.sets.map((s) => s.exercise_id)).size;

  return (
    <li>
      <Link
        href={`/dashboard/sessions/${session.id}`}
        className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-card border border-line bg-surface px-5 py-4 transition hover:bg-surface-raised"
      >
        {/* A floor under the name, not just flex-1. Four fixed 6rem metrics
            take 24rem, so on anything under ~900px the name was being
            squeezed to "U…" — the one part of the row you actually scan by.
            With a basis it wraps onto its own line instead. */}
        <div className="min-w-0 flex-1 basis-48">
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
            {session.ended_at === null && (
              <span className="text-warn"> · in progress</span>
            )}
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
        <Metric label="Working sets" value={String(workingSets)} />
        <Metric
          label="Volume"
          value={volume > 0 ? formatVolume(volume, units) : "—"}
        />
      </Link>
    </li>
  );
}

/**
 * Page controls, and the count that makes them meaningful.
 *
 * The count comes from the API alongside the rows, computed from the same
 * predicate — so "21–40 of 137" can never disagree with what's above it, which
 * is what happens when a total is fetched separately and one of the two moves.
 *
 * Prev/next rather than numbered pages: a training log is scanned backwards
 * from now, and page 7 means nothing to anyone.
 */
function Pager({
  total,
  offset,
  count,
  onOffset,
}: {
  total: number;
  offset: number;
  count: number;
  onOffset: (n: number) => void;
}) {
  if (total <= PAGE_SIZE) return null;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + count, total);
  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <p className="text-xs text-text-dim" aria-live="polite">
        {first}–{last} of {total}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}
          disabled={offset === 0}
          className="rounded-pill border border-line px-4 py-1.5 text-xs font-medium transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
        >
          Newer
        </button>
        <button
          type="button"
          onClick={() => onOffset(offset + PAGE_SIZE)}
          disabled={last >= total}
          className="rounded-pill border border-line px-4 py-1.5 text-xs font-medium transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
        >
          Older
        </button>
      </div>
    </div>
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
    <div
      className="flex flex-col gap-8"
      aria-busy="true"
      aria-label="Loading history"
    >
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
