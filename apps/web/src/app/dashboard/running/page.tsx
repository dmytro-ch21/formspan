"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import { listSessionsPage, type Session, type SessionPage } from "@/lib/api";
import { runSetFrom } from "@/lib/runningApi";
import { localZone, periodRange, PERIODS, type PeriodKey } from "@/lib/history";
import { formatDistance, formatPace, type UnitSystem } from "@/lib/units";
import { formatDuration } from "@/lib/history";
import { useUnits } from "@/lib/useUnits";

/**
 * Running analytics — the desk-depth surface N464 asks for: a full route
 * map, an elevation profile, a pace-zone breakdown and run-to-run
 * comparison, all reached from a run's own row here.
 *
 * **Data-fetching follows `dashboard/sessions/page.tsx` and
 * `dashboard/records/page.tsx` exactly** (AC: "reuses apps/web's existing
 * history/records data-fetching conventions"): `listSessionsPage` with a
 * `sport` filter, `PERIODS`/`periodRange`/`localZone` from `lib/history` for
 * the period control, `AbortController` per in-flight request, everything
 * computed server-side rather than summed from a capped page. The one
 * addition specific to this page is `runSetFrom` (`lib/runningApi.ts`),
 * which reads a run's distance/duration off the `session_sets` row the
 * generic personal-record pipeline already relies on — see
 * `internal/modules/running`'s package doc — so the list shows every run's
 * headline numbers without an N+1 fetch of `GET
 * /v1/running/sessions/{id}` per row. The full detail (route, elevation,
 * splits) is fetched only once a specific run is opened.
 */
const PAGE_SIZE = 20;

export default function RunningPage() {
  const { getToken } = useAuth();
  const { units } = useUnits();
  const router = useRouter();

  const [period, setPeriod] = useState<PeriodKey>("3m");
  const [page, setPage] = useState<SessionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setLoading(true);
    const { from, to } = periodRange(period);
    listSessionsPage(
      getToken,
      { from, to, tz: localZone(), sport: "running", limit: PAGE_SIZE, offset },
      c.signal,
    )
      .then((p) => {
        if (c.signal.aborted) return;
        setPage(p);
        setFailed(false);
      })
      .catch(() => {
        if (!c.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
  }, [getToken, period, offset]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffset(0);
  }, [period]);

  const rows = useMemo(() => page?.sessions ?? [], [page]);
  const total = page?.total ?? 0;

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // Compare is a PAIR, not a set — see lib/runningAnalysis.ts's
      // `compareRuns`, which takes exactly two. Picking a third replaces the
      // OLDEST selection rather than refusing the click, so the control stays
      // usable with a fast double-click instead of forcing an explicit
      // deselect first.
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Training</p>
          <h1 className="font-display text-4xl font-bold">Running</h1>
        </div>
        <div className="flex items-center gap-3">
          {selected.length === 2 && (
            <button
              type="button"
              onClick={() =>
                router.push(
                  `/dashboard/running/compare?a=${encodeURIComponent(selected[0])}&b=${encodeURIComponent(selected[1])}`,
                )
              }
              className="rounded-pill bg-accent-fill px-5 py-2.5 text-sm font-semibold text-accent-on-fill transition hover:opacity-90"
            >
              Compare selected
            </button>
          )}
          <Segmented
            options={PERIODS.map((x) => ({ key: x.key, label: x.label }))}
            value={period}
            onChange={(k) => setPeriod(k as PeriodKey)}
          />
        </div>
      </header>

      <p className="text-sm text-text-dim">
        Pick two runs (checkboxes) to compare them side by side, or open one
        for its full route, elevation and pace-zone breakdown.
      </p>

      {failed ? (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          Couldn&apos;t load your runs.{" "}
          <button type="button" onClick={load} className="underline">
            Try again
          </button>
        </p>
      ) : !loading && rows.length === 0 ? (
        <div className="rounded-card border border-dashed border-line px-6 py-16 text-center">
          <p className="font-display text-xl font-bold">No runs in this period</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-text-muted">
            Log a run on your phone and it shows up here with its route,
            splits and pace.
          </p>
        </div>
      ) : (
        <ul
          aria-busy={loading}
          className={`flex flex-col gap-2 transition-opacity ${loading ? "opacity-50" : ""}`}
        >
          {rows.map((s) => (
            <RunRow
              key={s.id}
              session={s}
              units={units}
              selected={selected.includes(s.id)}
              onToggleSelected={() => toggleSelected(s.id)}
            />
          ))}
        </ul>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-text-dim">
            {offset + 1}–{Math.min(offset + rows.length, total)} of {total}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-pill border border-line px-4 py-1.5 text-xs font-medium transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              Newer
            </button>
            <button
              type="button"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + rows.length >= total}
              className="rounded-pill border border-line px-4 py-1.5 text-xs font-medium transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              Older
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunRow({
  session,
  units,
  selected,
  onToggleSelected,
}: {
  session: Session;
  units: UnitSystem;
  selected: boolean;
  onToggleSelected: () => void;
}) {
  const runSet = runSetFrom(session.sets);
  const distanceM = runSet?.distance_m ?? null;
  const durationSeconds =
    runSet?.seconds ??
    (session.ended_at
      ? (new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 1000
      : null);
  const paceSecPerKm =
    distanceM && distanceM > 0 && durationSeconds
      ? durationSeconds / (distanceM / 1000)
      : null;

  return (
    <li className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-card border border-line bg-surface px-5 py-4">
      <label className="flex items-center">
        <span className="sr-only">Select {session.name || "run"} to compare</span>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          className="h-4 w-4 accent-lime"
        />
      </label>

      <Link
        href={`/dashboard/running/${session.id}`}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2"
      >
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate font-medium">{session.name || "Run"}</p>
          <p className="truncate text-xs text-text-dim">
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
        <Metric label="Distance" value={formatDistance(distanceM, units)} />
        <Metric
          label="Duration"
          value={durationSeconds ? formatDuration(durationSeconds) : "—"}
        />
        <Metric label="Pace" value={formatPace(paceSecPerKm, units)} />
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

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Period"
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
